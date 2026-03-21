import { useEffect, useRef } from 'react';

/**
 * Runs a callback on a recurring interval. Pass `null` as delay to pause.
 * The callback is always called with the latest closure (no stale values).
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const savedCallback = useRef(callback);

  // Always keep the ref pointing at the latest callback
  savedCallback.current = callback;

  useEffect(() => {
    if (delayMs === null) return;

    const id = window.setInterval(() => savedCallback.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}
