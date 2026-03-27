import { useCallback, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-effect-factories';
import { apiClient } from '@/lib/api/client';

export interface EventStreamEvent {
  type: string;
  data?: {
    eventSourceId?: string;
    eventLogId?: string;
    status?: string;
    matchCount?: number;
    tasksCreated?: string[];
    [key: string]: unknown;
  };
  timestamp?: string;
}

interface UseEventStreamOptions {
  onEvent?: (event: EventStreamEvent) => void;
  enabled?: boolean;
}

/**
 * Hook that connects to the events SSE stream for real-time event notifications.
 * Handles automatic reconnection with exponential backoff.
 */
export function useEventStream(options: UseEventStreamOptions = {}): { connected: boolean } {
  const { onEvent, enabled = true } = options;
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);

  // Keep callback ref up to date without causing reconnections
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const url = apiClient.events.getStreamUrl();
    const source = new EventSource(url);
    eventSourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      retryCountRef.current = 0;
    };

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as EventStreamEvent;
        onEventRef.current?.(data);
      } catch (err) {
        console.warn('[useEventStream] Failed to parse SSE event:', event.data, err);
      }
    };

    source.onerror = () => {
      setConnected(false);
      source.close();
      eventSourceRef.current = null;

      // Reconnect with exponential backoff (max 30s, max 10 retries)
      if (retryCountRef.current >= 10) return;
      const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000);
      retryCountRef.current += 1;
      retryTimeoutRef.current = setTimeout(connect, delay);
    };
  }, []);

  useWatchEffect(() => {
    if (!enabled) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        setConnected(false);
      }
      return;
    }

    connect();

    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnected(false);
    };
  }, [enabled, connect]);

  return { connected };
}
