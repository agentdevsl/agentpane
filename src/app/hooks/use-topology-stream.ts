import { useCallback, useRef } from 'react';
import type { TopologyAction } from '@/app/components/features/agent-topology/topology-context';
import type {
  ContainerAgentCompleteSessionEvent,
  ContainerAgentErrorSessionEvent,
  ContainerAgentStartedSessionEvent,
  SessionCallbacks,
  TopologyAgentCompleted,
  TopologyAgentCompletedSessionEvent,
  TopologyAgentProgress,
  TopologyAgentProgressSessionEvent,
  TopologyAgentSpawned,
  TopologyAgentSpawnedSessionEvent,
} from '@/lib/streams/client';
import { subscribeToSession } from '@/lib/streams/client';
import type { TopologyNode } from '@/lib/topology/types';
import { deriveContainerAgentNodeId } from '@/lib/topology/utils';
import { useMountEffect } from './use-mount-effect';
import { useWatchEffect } from './use-watch-effect';

/**
 * Map a role string from the backend to a TopologyAgentRole.
 */
function toRole(role: string): TopologyNode['role'] {
  return role || 'agent';
}

/**
 * Create a new TopologyNode from a spawned event.
 */
function createNodeFromSpawned(data: TopologyAgentSpawned): TopologyNode {
  return {
    id: data.agentId,
    name: data.name,
    role: toRole(data.role),
    agentType: data.agentType ?? null,
    status: 'running',
    parentId: data.parentId,
    childIds: [],
    progress: 0,
    tokens: 0,
    cost: 0,
    turns: 0,
    messages: 0,
    startedAt: data.timestamp,
    completedAt: null,
    verified: false,
    verificationScore: 0,
    decisions: [],
  };
}

// Progress/cost estimation constants
/** Rough estimate: ~500 tokens per 1% progress */
const TOKENS_PER_PROGRESS_POINT = 500;
/** Blended average token cost ($3/M input + $15/M output ≈ $9/M average) */
const AVERAGE_TOKEN_COST = 0.000009;
/** Rough estimate: one message exchange every ~5 seconds */
const MS_PER_MESSAGE_ESTIMATE = 5000;

type StableEventIdentity = {
  meta?: { eventId?: string };
  cursor?: string;
};

function getStableEventId(event: StableEventIdentity, fallback: string): string {
  return event.meta?.eventId ?? event.cursor ?? fallback;
}

/**
 * Hook that subscribes to topology SSE events and dispatches to the topology context.
 */
export function useTopologyStream(
  sessionId: string | undefined,
  dispatch: React.Dispatch<TopologyAction>
): void {
  // rAF-based batching for UPDATE_NODE dispatches to avoid per-event re-renders
  const pendingUpdatesRef = useRef<Map<string, TopologyAction>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  const flushUpdates = useCallback(() => {
    const pending = pendingUpdatesRef.current;
    for (const action of pending.values()) {
      dispatch(action);
    }
    pending.clear();
    rafIdRef.current = null;
  }, [dispatch]);

  const scheduleUpdate = useCallback(
    (nodeId: string, action: TopologyAction) => {
      pendingUpdatesRef.current.set(nodeId, action);
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushUpdates);
      }
    },
    [flushUpdates]
  );

  // Clean up any pending rAF on unmount
  useMountEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      seenEventIdsRef.current.clear();
    };
  });

  const handleSpawned = useCallback(
    (event: { data: TopologyAgentSpawned }) => {
      const node = createNodeFromSpawned(event.data);
      const edges = node.parentId
        ? [{ id: `${node.parentId}->${node.id}`, sourceId: node.parentId, targetId: node.id }]
        : undefined;

      dispatch({ type: 'ADD_NODE', node, edges });
    },
    [dispatch]
  );

  const handleProgress = useCallback(
    (event: { data: TopologyAgentProgress }) => {
      const { agentId, tokens, durationMs } = event.data;
      const estimatedProgress = Math.min(95, Math.floor(tokens / TOKENS_PER_PROGRESS_POINT));
      const estimatedCost = Number.parseFloat((tokens * AVERAGE_TOKEN_COST).toFixed(4));

      // Buffer progress updates and flush once per animation frame to avoid
      // a cascade of re-renders when multiple subagents emit events rapidly.
      scheduleUpdate(agentId, {
        type: 'UPDATE_NODE',
        nodeId: agentId,
        updates: {
          tokens,
          cost: estimatedCost,
          progress: estimatedProgress,
          turns: event.data.toolUses,
          messages: Math.ceil(durationMs / MS_PER_MESSAGE_ESTIMATE),
        },
      });
    },
    [scheduleUpdate]
  );

  const handleCompleted = useCallback(
    (event: { data: TopologyAgentCompleted }) => {
      const { agentId, status, tokens } = event.data;
      // Map SDK status to topology status (completed, failed, stopped)
      const finalStatus: 'completed' | 'failed' | 'stopped' =
        status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : 'failed';

      // Update final metrics before completing
      if (tokens) {
        const updates: Partial<TopologyNode> = {
          tokens,
          cost: Number.parseFloat((tokens * 0.000009).toFixed(4)),
        };
        if (finalStatus === 'completed') {
          updates.progress = 100;
        }
        dispatch({ type: 'UPDATE_NODE', nodeId: agentId, updates });
      }

      dispatch({
        type: 'COMPLETE_NODE',
        nodeId: agentId,
        status: finalStatus,
        completedAt: event.data.timestamp,
      });
    },
    [dispatch]
  );

  useWatchEffect(() => {
    if (!sessionId) {
      console.debug('[useTopologyStream] no sessionId, skipping');
      seenEventIdsRef.current.clear();
      return;
    }
    console.debug('[useTopologyStream] subscribing to session', sessionId);
    const subStart = performance.now();

    let hasReceivedEvent = false;
    let disconnectCount = 0;

    let rootNodeCreated = false;
    seenEventIdsRef.current.clear();

    const shouldProcessEvent = (eventId: string): boolean => {
      if (seenEventIdsRef.current.has(eventId)) {
        return false;
      }

      seenEventIdsRef.current.add(eventId);
      return true;
    };

    const callbacks: SessionCallbacks = {
      onTopologyAgentSpawned: (event) => {
        const eventId = getStableEventId(
          event as TopologyAgentSpawnedSessionEvent,
          `topology:agent-spawned:${event.data.agentId}:${event.data.timestamp}`
        );
        if (!shouldProcessEvent(eventId)) {
          return;
        }
        hasReceivedEvent = true;
        handleSpawned(event);
      },
      onTopologyAgentProgress: (event) => {
        const eventId = getStableEventId(
          event as TopologyAgentProgressSessionEvent,
          `topology:agent-progress:${event.data.agentId}:${event.data.tokens}:${event.data.timestamp}`
        );
        if (!shouldProcessEvent(eventId)) {
          return;
        }
        hasReceivedEvent = true;
        handleProgress(event);
      },
      onTopologyAgentCompleted: (event) => {
        const eventId = getStableEventId(
          event as TopologyAgentCompletedSessionEvent,
          `topology:agent-completed:${event.data.agentId}:${event.data.status}:${event.data.timestamp}`
        );
        if (!shouldProcessEvent(eventId)) {
          return;
        }
        hasReceivedEvent = true;
        handleCompleted(event);
      },
      // Handle container-agent sessions: create a root node when the agent starts
      onContainerAgentStarted: (event) => {
        const eventId = getStableEventId(
          event as ContainerAgentStartedSessionEvent,
          `container-agent:started:${event.data.taskId}:${event.data.timestamp}`
        );
        if (!shouldProcessEvent(eventId) || rootNodeCreated) return;
        rootNodeCreated = true;
        hasReceivedEvent = true;
        const data = event.data as { taskId?: string; sessionId?: string; model?: string };
        const nodeId = deriveContainerAgentNodeId({ taskId: data.taskId, sessionId });
        const node: TopologyNode = {
          id: nodeId,
          name: data.model ?? 'Agent',
          role: 'agent',
          agentType: null,
          status: 'running',
          parentId: null,
          childIds: [],
          progress: 0,
          tokens: 0,
          cost: 0,
          turns: 0,
          messages: 0,
          startedAt: Date.now(),
          completedAt: null,
          verified: false,
          verificationScore: 0,
          decisions: [],
        };
        dispatch({ type: 'ADD_NODE', node });
      },
      // Track progress from container-agent tool calls
      onContainerAgentToolStart: () => {
        hasReceivedEvent = true;
      },
      onContainerAgentComplete: (event) => {
        const eventId = getStableEventId(
          event as ContainerAgentCompleteSessionEvent,
          `container-agent:complete:${event.data.taskId}:${event.data.turnCount}:${event.data.timestamp}`
        );
        if (!shouldProcessEvent(eventId)) {
          return;
        }
        hasReceivedEvent = true;
        const data = event.data as { taskId?: string };
        const agentId = deriveContainerAgentNodeId({ taskId: data.taskId, sessionId });
        dispatch({
          type: 'COMPLETE_NODE',
          nodeId: agentId,
          status: 'completed',
          completedAt: Date.now(),
        });
      },
      onContainerAgentError: (event) => {
        const eventId = getStableEventId(
          event as ContainerAgentErrorSessionEvent,
          `container-agent:error:${event.data.taskId}:${event.data.code ?? 'unknown'}:${event.data.timestamp}`
        );
        if (!shouldProcessEvent(eventId)) {
          return;
        }
        hasReceivedEvent = true;
        const data = event.data as { taskId?: string };
        const agentId = deriveContainerAgentNodeId({ taskId: data.taskId, sessionId });
        dispatch({
          type: 'COMPLETE_NODE',
          nodeId: agentId,
          status: 'failed',
          completedAt: Date.now(),
        });
      },
      onError: (error) => {
        console.error('[useTopologyStream] Stream error:', error);
      },
      onDisconnect: () => {
        disconnectCount++;
        // If we've disconnected 5 times without ever receiving an event,
        // the session likely has no topology data — stop retrying
        if (!hasReceivedEvent && disconnectCount >= 5) {
          console.warn('[useTopologyStream] No topology events after 5 reconnects, unsubscribing');
          subscription.unsubscribe();
        }
      },
    };

    const subscription = subscribeToSession(sessionId, callbacks);
    console.debug('[useTopologyStream] subscribed', {
      ms: Math.round(performance.now() - subStart),
    });

    return () => {
      console.debug('[useTopologyStream] unsubscribing');
      subscription.unsubscribe();
    };
  }, [sessionId, handleSpawned, handleProgress, handleCompleted]);
}
