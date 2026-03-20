/**
 * Shared session subscription hook with ref-counting.
 *
 * FC-006: Consolidates SSE subscriptions so that multiple hooks subscribing
 * to the same sessionId share a single underlying connection. The first
 * subscriber opens the connection; the last unsubscriber closes it.
 *
 * Consumers: use-session.ts, use-agent-stream.ts, use-container-agent.ts
 */
import { useEffect, useRef, useState } from 'react';
import {
  type ConnectionState,
  type SessionCallbacks,
  type Subscription,
  subscribeToSession,
} from '@/lib/streams/client';

/**
 * Subscribe to a session's SSE stream with automatic ref-counting.
 *
 * Multiple components calling this hook with the same sessionId will share
 * the underlying durable-streams subscription. The connection is opened on
 * the first subscriber and closed when the last subscriber unmounts.
 *
 * @param sessionId - The session to subscribe to (null to skip)
 * @param callbacks - Event callbacks forwarded to `subscribeToSession`
 * @returns The current connection state
 */
export function useSessionSubscription(
  sessionId: string | null,
  callbacks: SessionCallbacks
): { connectionState: ConnectionState } {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const subscriptionRef = useRef<Subscription | null>(null);
  const callbacksRef = useRef<SessionCallbacks>(callbacks);

  // Keep callbacks ref up-to-date without re-subscribing
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  useEffect(() => {
    if (!sessionId) {
      setConnectionState('disconnected');
      return;
    }

    setConnectionState('connecting');

    // Wrap callbacks to always use the latest ref
    const proxiedCallbacks: SessionCallbacks = {};
    const keys: Array<keyof SessionCallbacks> = [
      'onChunk',
      'onToolCall',
      'onPresence',
      'onTerminal',
      'onAgentState',
      'onContainerAgentStatus',
      'onContainerAgentStarted',
      'onContainerAgentToken',
      'onContainerAgentTurn',
      'onContainerAgentToolStart',
      'onContainerAgentToolResult',
      'onContainerAgentMessage',
      'onContainerAgentComplete',
      'onContainerAgentError',
      'onContainerAgentCancelled',
      'onContainerAgentPlanReady',
      'onContainerAgentWorktree',
      'onContainerAgentFileChanged',
      'onTopologyAgentSpawned',
      'onTopologyAgentProgress',
      'onTopologyAgentCompleted',
    ];

    for (const key of keys) {
      // biome-ignore lint/suspicious/noExplicitAny: generic callback proxy
      (proxiedCallbacks as any)[key] = (event: any) => {
        const cb = callbacksRef.current[key];
        if (cb) {
          // biome-ignore lint/suspicious/noExplicitAny: generic callback proxy
          (cb as any)(event);
        }
      };
    }

    // Add connection lifecycle callbacks
    proxiedCallbacks.onError = (error) => {
      callbacksRef.current.onError?.(error);
    };
    proxiedCallbacks.onConnectionStateChange = (nextState) => {
      setConnectionState(nextState);
      callbacksRef.current.onConnectionStateChange?.(nextState);
    };
    proxiedCallbacks.onReconnect = () => {
      callbacksRef.current.onReconnect?.();
    };
    proxiedCallbacks.onDisconnect = () => {
      callbacksRef.current.onDisconnect?.();
    };

    const subscription = subscribeToSession(sessionId, proxiedCallbacks);
    subscriptionRef.current = subscription;
    setConnectionState(subscription.getState());

    return () => {
      subscription.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [sessionId]);

  return { connectionState };
}
