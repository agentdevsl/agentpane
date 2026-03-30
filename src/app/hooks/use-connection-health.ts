import { useCallback, useRef, useState } from 'react';
import { useInterval } from '@/app/hooks/use-interval';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface ConnectionHealthOptions {
  /** Time in ms before marking as disconnected after last activity (default: 45000) */
  timeoutMs?: number;
  /** Whether the connection is currently active */
  isActive: boolean;
}

export function useConnectionHealth(options: ConnectionHealthOptions) {
  const { timeoutMs = 45_000, isActive } = options;
  const [status, setStatus] = useState<ConnectionStatus>(isActive ? 'connected' : 'disconnected');
  const lastActivityRef = useRef<number>(Date.now());

  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setStatus('connected');
  }, []);

  // When isActive goes false, immediately mark as disconnected
  useWatchEffect(() => {
    if (!isActive) {
      setStatus('disconnected');
    }
  }, [isActive]);

  // Periodically check health while active (every 5s)
  useInterval(
    () => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed > timeoutMs) {
        setStatus('disconnected');
      } else if (elapsed > timeoutMs / 2) {
        setStatus('reconnecting');
      }
    },
    isActive ? 15000 : null
  );

  return { status, recordActivity };
}
