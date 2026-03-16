import { useCallback, useEffect } from 'react';
import type { TopologyAction } from '@/app/components/features/agent-topology/topology-context';
import type {
  SessionCallbacks,
  TopologyAgentCompleted,
  TopologyAgentProgress,
  TopologyAgentSpawned,
} from '@/lib/streams/client';
import { subscribeToSession } from '@/lib/streams/client';
import type { TopologyNode } from '@/lib/topology/types';

/**
 * Map a role string from the backend to a TopologyAgentRole.
 */
function toRole(role: string): TopologyNode['role'] {
  const valid = ['orchestrator', 'planner', 'coder', 'reviewer', 'tester', 'scanner', 'deployer'];
  return valid.includes(role) ? (role as TopologyNode['role']) : 'coder';
}

/**
 * Create a new TopologyNode from a spawned event.
 */
function createNodeFromSpawned(data: TopologyAgentSpawned): TopologyNode {
  return {
    id: data.agentId,
    name: data.name,
    role: toRole(data.role),
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

/**
 * Hook that subscribes to topology SSE events and dispatches to the topology context.
 */
export function useTopologyStream(
  sessionId: string | undefined,
  dispatch: React.Dispatch<TopologyAction>
): void {
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

      dispatch({
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
    [dispatch]
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

  useEffect(() => {
    if (!sessionId) return;

    let hasReceivedEvent = false;
    let disconnectCount = 0;

    const callbacks: SessionCallbacks = {
      onTopologyAgentSpawned: (event) => {
        hasReceivedEvent = true;
        handleSpawned(event);
      },
      onTopologyAgentProgress: (event) => {
        hasReceivedEvent = true;
        handleProgress(event);
      },
      onTopologyAgentCompleted: (event) => {
        hasReceivedEvent = true;
        handleCompleted(event);
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

    return () => {
      subscription.unsubscribe();
    };
  }, [sessionId, handleSpawned, handleProgress, handleCompleted]);
}
