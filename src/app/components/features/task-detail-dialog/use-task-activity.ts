import { useCallback, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { Task } from '@/db/schema';
import { apiClient } from '@/lib/api/client';
import { type SessionCallbacks, type Subscription, subscribeToSession } from '@/lib/streams/client';
import type { ActivityEntry } from './index';

type SessionEventType = string;

interface RawEvent {
  id: string;
  type: SessionEventType;
  timestamp: number;
  data: unknown;
}

function mapEventToActivity(event: RawEvent): ActivityEntry | null {
  const { id, type, timestamp, data } = event;
  const eventData = (data ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'agent:started':
    case 'container-agent:started':
      return {
        id,
        type: 'status_change',
        timestamp,
        message: 'Agent started execution',
        data: eventData,
      };

    case 'agent:planning':
      return {
        id,
        type: 'status_change',
        timestamp,
        message: 'Agent began planning',
        data: eventData,
      };

    case 'agent:plan_ready':
    case 'container-agent:plan_ready':
      return {
        id,
        type: 'status_change',
        timestamp,
        message: 'Plan ready for review',
        data: eventData,
      };

    case 'agent:completed':
    case 'container-agent:complete':
      return {
        id,
        type: 'status_change',
        timestamp,
        message: 'Agent completed successfully',
        data: eventData,
      };

    case 'agent:error':
    case 'container-agent:error': {
      const errorMsg = typeof eventData.error === 'string' ? `: ${eventData.error}` : '';
      return {
        id,
        type: 'status_change',
        timestamp,
        message: `Agent encountered an error${errorMsg}`,
        data: eventData,
      };
    }

    case 'agent:turn':
    case 'container-agent:turn': {
      const turn = typeof eventData.turn === 'number' ? eventData.turn : undefined;
      const msg = turn !== undefined ? `Turn ${turn} completed` : 'Turn completed';
      return { id, type: 'tool_call', timestamp, message: msg, data: eventData };
    }

    case 'agent:turn_limit':
      return {
        id,
        type: 'status_change',
        timestamp,
        message: 'Maximum turns reached',
        data: eventData,
      };

    case 'agent:warning':
      return {
        id,
        type: 'status_change',
        timestamp,
        message: `Warning: ${eventData.message ?? 'unknown'}`,
        data: eventData,
      };

    case 'tool:start':
    case 'container-agent:tool:start': {
      const toolName =
        typeof eventData.tool === 'string'
          ? eventData.tool
          : typeof eventData.toolName === 'string'
            ? eventData.toolName
            : 'unknown';
      const input = eventData.input;
      let inputSummary = '';
      if (typeof input === 'string') {
        inputSummary = input.length > 60 ? `${input.slice(0, 60)}...` : input;
      } else if (input && typeof input === 'object') {
        const inputObj = input as Record<string, unknown>;
        const command = inputObj.command ?? inputObj.path ?? inputObj.pattern;
        if (typeof command === 'string') {
          inputSummary = command.length > 60 ? `${command.slice(0, 60)}...` : command;
        }
      }
      const msg = inputSummary ? `Running ${toolName}: ${inputSummary}` : `Running ${toolName}`;
      return { id, type: 'tool_call', timestamp, message: msg, data: eventData };
    }

    case 'tool:result':
    case 'container-agent:tool:result': {
      const duration =
        typeof eventData.durationMs === 'number' ? ` (${eventData.durationMs}ms)` : '';
      return {
        id,
        type: 'tool_call',
        timestamp,
        message: `Tool completed${duration}`,
        data: eventData,
      };
    }

    case 'approval:approved':
      return { id, type: 'approval', timestamp, message: 'Changes approved', data: eventData };

    case 'approval:rejected': {
      // AE-012: Deprecated event type, kept for backward compat with persisted events.
      // New code emits 'agent:resumed' instead.
      const reason = typeof eventData.reason === 'string' ? `: ${eventData.reason}` : '';
      return {
        id,
        type: 'rejection',
        timestamp,
        message: `Changes rejected${reason}`,
        data: eventData,
      };
    }

    case 'agent:resumed': {
      const feedback = typeof eventData.feedback === 'string' ? `: ${eventData.feedback}` : '';
      return {
        id,
        type: 'status_change',
        timestamp,
        message: `Agent resumed${feedback}`,
        data: eventData,
      };
    }

    case 'container-agent:cancelled':
      return { id, type: 'status_change', timestamp, message: 'Agent cancelled', data: eventData };

    case 'container-agent:message': {
      const content = typeof eventData.content === 'string' ? eventData.content : '';
      const preview = content.length > 80 ? `${content.slice(0, 80)}...` : content;
      return {
        id,
        type: 'tool_call',
        timestamp,
        message: preview || 'Agent message',
        data: eventData,
      };
    }

    // Skip chunk, presence, terminal, state:update - too noisy for activity timeline
    default:
      return null;
  }
}

function buildSyntheticEntries(task: Task): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  if (task.createdAt) {
    entries.push({
      id: `synthetic-created-${task.id}`,
      type: 'status_change',
      timestamp: new Date(task.createdAt).getTime(),
      message: 'Task created',
    });
  }

  if (task.startedAt) {
    entries.push({
      id: `synthetic-started-${task.id}`,
      type: 'status_change',
      timestamp: new Date(task.startedAt).getTime(),
      message: 'Moved to In Progress',
    });
  }

  if (task.completedAt) {
    entries.push({
      id: `synthetic-completed-${task.id}`,
      type: 'status_change',
      timestamp: new Date(task.completedAt).getTime(),
      message: 'Task completed',
    });
  }

  if (task.approvedAt) {
    entries.push({
      id: `synthetic-approved-${task.id}`,
      type: 'approval',
      timestamp: new Date(task.approvedAt).getTime(),
      message: task.approvedBy ? `Approved by ${task.approvedBy}` : 'Changes approved',
    });
  }

  return entries;
}

export function useTaskActivity(task: Task | null): {
  activities: ActivityEntry[];
  isLoading: boolean;
  error: string | null;
} {
  const [fetchedActivities, setFetchedActivities] = useState<ActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenOffsets = useRef(new Set<string>());
  const subscriptionRef = useRef<Subscription | null>(null);

  // Fetch historical events
  useWatchEffect(() => {
    if (!task?.sessionId) {
      setFetchedActivities([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    const sessionId = task.sessionId;
    let cancelled = false;
    seenOffsets.current.clear();

    async function fetchEvents() {
      setIsLoading(true);
      setError(null);

      try {
        const result = await apiClient.sessions.getEvents(sessionId, { limit: 500 });
        if (cancelled) return;

        if (result.ok) {
          const events = result.data.data;
          const mapped: ActivityEntry[] = [];
          for (const event of events) {
            seenOffsets.current.add(event.id);
            const entry = mapEventToActivity(event);
            if (entry) mapped.push(entry);
          }
          setFetchedActivities(mapped);
        } else {
          setError('Failed to load activity');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load activity');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchEvents();

    return () => {
      cancelled = true;
    };
  }, [task?.sessionId]);

  // Subscribe to SSE for in_progress tasks
  useWatchEffect(() => {
    if (!task?.sessionId || task.column !== 'in_progress') {
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
      return;
    }

    const sessionId = task.sessionId;

    const callbacks: SessionCallbacks = {
      onAgentState: (event) => {
        if (!event.data) return;
        const id = `stream-agent-state-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        const status = event.data.status;
        let message = 'Agent state changed';
        if (status === 'running') message = 'Agent started execution';
        else if (status === 'completed') message = 'Agent completed successfully';
        else if (status === 'error') message = 'Agent encountered an error';
        else if (status === 'paused') message = 'Agent paused';

        setFetchedActivities((prev) => [
          ...prev,
          { id, type: 'status_change', timestamp: Date.now(), message },
        ]);
      },
      onToolCall: (event) => {
        const id = `stream-tool-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        const tool = event.data.tool;
        const status = event.data.status;
        const msg =
          status === 'complete' || status === 'error'
            ? `Tool ${tool} ${status}`
            : `Running ${tool}`;

        setFetchedActivities((prev) => [
          ...prev,
          { id, type: 'tool_call', timestamp: event.data.timestamp, message: msg },
        ]);
      },
      onContainerAgentTurn: (event) => {
        const id = `stream-turn-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        setFetchedActivities((prev) => [
          ...prev,
          {
            id,
            type: 'tool_call',
            timestamp: event.data.timestamp,
            message: `Turn ${event.data.turn} completed`,
          },
        ]);
      },
      onContainerAgentToolStart: (event) => {
        const id = `stream-ctool-start-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        setFetchedActivities((prev) => [
          ...prev,
          {
            id,
            type: 'tool_call',
            timestamp: event.data.timestamp,
            message: `Running ${event.data.toolName}`,
          },
        ]);
      },
      onContainerAgentToolResult: (event) => {
        const id = `stream-ctool-result-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        setFetchedActivities((prev) => [
          ...prev,
          {
            id,
            type: 'tool_call',
            timestamp: event.data.timestamp,
            message: `Tool completed (${event.data.durationMs}ms)`,
          },
        ]);
      },
      onContainerAgentComplete: (event) => {
        const id = `stream-ccomplete-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        setFetchedActivities((prev) => [
          ...prev,
          {
            id,
            type: 'status_change',
            timestamp: event.data.timestamp,
            message: 'Agent completed successfully',
          },
        ]);
      },
      onContainerAgentError: (event) => {
        const id = `stream-cerror-${event.offset ?? Date.now()}`;
        if (seenOffsets.current.has(id)) return;
        seenOffsets.current.add(id);

        setFetchedActivities((prev) => [
          ...prev,
          {
            id,
            type: 'status_change',
            timestamp: event.data.timestamp,
            message: `Agent encountered an error: ${event.data.error}`,
          },
        ]);
      },
      onError: (err) => {
        console.error('[useTaskActivity] SSE subscription error:', err);
        setError('Live updates disconnected. Refresh to see latest activity.');
      },
    };

    const subscription = subscribeToSession(sessionId, callbacks);
    subscriptionRef.current = subscription;

    return () => {
      subscription.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [task?.sessionId, task?.column]);

  // Combine fetched events with synthetic lifecycle entries
  const activities = useCallback(() => {
    const synthetic = task ? buildSyntheticEntries(task) : [];
    const all = [...synthetic, ...fetchedActivities];
    // Sort by timestamp ascending
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }, [task, fetchedActivities]);

  return {
    activities: activities(),
    isLoading,
    error,
  };
}
