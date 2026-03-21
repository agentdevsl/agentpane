// biome-ignore lint/style/noRestrictedImports: factory hook — only file allowed to import useEffect
import { useEffect, useRef } from 'react';

/**
 * Runs a callback on a recurring interval. Pass `null` as delay to pause.
 * The callback is always called with the latest closure (no stale values).
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const savedCallback = useRef(callback);

  // Always keep the ref pointing at the latest callback
  savedCallback.current = callback;

  // biome-ignore lint/correctness/useExhaustiveDependencies: delay is the only reactive dep
  useEffect(() => {
    if (delayMs === null) return;

    const id = window.setInterval(() => savedCallback.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}
