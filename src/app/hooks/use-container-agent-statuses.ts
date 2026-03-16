import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ContainerAgentStarted,
  type ContainerAgentStatus,
  type SessionCallbacks,
  type Subscription,
  subscribeToSession,
} from '@/lib/streams/client';

/**
 * Tracked status for a single agent session
 */
export interface AgentStatusInfo {
  sessionId: string;
  taskId: string;
  currentStage?:
    | 'initializing'
    | 'validating'
    | 'credentials'
    | 'creating_sandbox'
    | 'executing'
    | 'running';
  statusMessage?: string;
  sandboxProvider?: string;
  sandboxContainerId?: string;
  isStarting: boolean;
  isRunning: boolean;
  isComplete: boolean;
  hasError: boolean;
}

const initialStatus = (sessionId: string, taskId: string): AgentStatusInfo => ({
  sessionId,
  taskId,
  isStarting: true,
  isRunning: false,
  isComplete: false,
  hasError: false,
});

/**
 * Hook for tracking container agent statuses across multiple sessions
 *
 * Use this at the board level to provide real-time status to task cards.
 *
 * @param sessionIds - Array of session IDs to track (from in-progress tasks)
 * @returns Map of sessionId -> AgentStatusInfo
 */
export function useContainerAgentStatuses(
  sessions: Array<{ sessionId: string; taskId: string }>
): Map<string, AgentStatusInfo> {
  const [statuses, setStatuses] = useState<Map<string, AgentStatusInfo>>(new Map());
  const subscriptionsRef = useRef<Map<string, Subscription>>(new Map());

  // Handler for status events
  const handleStatus = useCallback((sessionId: string, data: ContainerAgentStatus) => {
    setStatuses((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(sessionId) ?? initialStatus(sessionId, data.taskId);
      newMap.set(sessionId, {
        ...existing,
        currentStage: data.stage,
        statusMessage: data.message,
        isStarting: data.stage !== 'running',
        isRunning: data.stage === 'running',
      });
      return newMap;
    });
  }, []);

  // Handler for started event
  const handleStarted = useCallback((sessionId: string, data: ContainerAgentStarted) => {
    setStatuses((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(sessionId);
      if (existing) {
        newMap.set(sessionId, {
          ...existing,
          isRunning: true,
          isStarting: false,
          sandboxProvider: data.sandboxProvider,
          sandboxContainerId: data.sandboxContainerId,
        });
      }
      return newMap;
    });
  }, []);

  // Handler for complete/error/cancelled
  const handleComplete = useCallback((sessionId: string, hasError = false) => {
    setStatuses((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(sessionId);
      if (existing) {
        newMap.set(sessionId, {
          ...existing,
          isComplete: true,
          isRunning: false,
          isStarting: false,
          hasError,
        });
      }
      return newMap;
    });
  }, []);

  // Stabilize sessions identity — only re-run when the actual session IDs change,
  // not on every new array reference from useMemo upstream.
  const sessionsKey = useMemo(
    () =>
      sessions
        .map((s) => `${s.sessionId}:${s.taskId}`)
        .sort()
        .join(','),
    [sessions]
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Manage subscriptions — sessionsKey drives re-evaluation when sessions change
  useEffect(() => {
    // Reference sessionsKey so the linter sees it's used (it triggers this effect)
    void sessionsKey;
    const currentSessions = sessionsRef.current;
    const currentSessionIds = new Set(currentSessions.map((s) => s.sessionId));
    const subscriptions = subscriptionsRef.current;

    // Subscribe to new sessions
    for (const { sessionId, taskId } of currentSessions) {
      if (!subscriptions.has(sessionId)) {
        // Initialize status
        setStatuses((prev) => {
          const newMap = new Map(prev);
          if (!newMap.has(sessionId)) {
            newMap.set(sessionId, initialStatus(sessionId, taskId));
          }
          return newMap;
        });

        // Subscribe
        const callbacks: SessionCallbacks = {
          onContainerAgentStatus: (event) => {
            handleStatus(sessionId, event.data);
          },
          onContainerAgentStarted: (event) => {
            handleStarted(sessionId, event.data);
          },
          onContainerAgentComplete: () => {
            handleComplete(sessionId);
          },
          onContainerAgentError: () => {
            handleComplete(sessionId, true);
          },
          onContainerAgentCancelled: () => {
            handleComplete(sessionId);
          },
        };

        const subscription = subscribeToSession(sessionId, callbacks);
        subscriptions.set(sessionId, subscription);
      }
    }

    // Unsubscribe from removed sessions
    for (const [sessionId, subscription] of subscriptions) {
      if (!currentSessionIds.has(sessionId)) {
        subscription.unsubscribe();
        subscriptions.delete(sessionId);
        setStatuses((prev) => {
          const newMap = new Map(prev);
          newMap.delete(sessionId);
          return newMap;
        });
      }
    }

    // Cleanup on unmount
    return () => {
      for (const subscription of subscriptions.values()) {
        subscription.unsubscribe();
      }
      subscriptions.clear();
    };
  }, [sessionsKey, handleStatus, handleStarted, handleComplete]);

  return statuses;
}
