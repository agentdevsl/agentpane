import { useCallback, useEffect, useRef, useState } from 'react';
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

  // Manage subscriptions
  useEffect(() => {
    const currentSessionIds = new Set(sessions.map((s) => s.sessionId));
    const subscriptions = subscriptionsRef.current;

    console.log('[useContainerAgentStatuses] Managing subscriptions:', {
      sessionsCount: sessions.length,
      sessions: sessions.map((s) => ({ sessionId: s.sessionId, taskId: s.taskId })),
      existingSubscriptions: Array.from(subscriptions.keys()),
    });

    // Subscribe to new sessions
    for (const { sessionId, taskId } of sessions) {
      if (!subscriptions.has(sessionId)) {
        console.log('[useContainerAgentStatuses] Subscribing to session:', sessionId);

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
            console.log('[useContainerAgentStatuses] Received status event:', event.data);
            handleStatus(sessionId, event.data);
          },
          onContainerAgentStarted: (event) => {
            console.log('[useContainerAgentStatuses] Received started event');
            handleStarted(sessionId, event.data);
          },
          onContainerAgentComplete: () => {
            console.log('[useContainerAgentStatuses] Received complete event');
            handleComplete(sessionId);
          },
          onContainerAgentError: () => {
            console.log('[useContainerAgentStatuses] Received error event');
            handleComplete(sessionId, true);
          },
          onContainerAgentCancelled: () => {
            console.log('[useContainerAgentStatuses] Received cancelled event');
            handleComplete(sessionId);
          },
        };

        const subscription = subscribeToSession(sessionId, callbacks);
        subscriptions.set(sessionId, subscription);
        console.log('[useContainerAgentStatuses] Subscription created for:', sessionId);
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
  }, [sessions, handleStatus, handleStarted, handleComplete]);

  return statuses;
}
