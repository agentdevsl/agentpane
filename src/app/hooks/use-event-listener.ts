// biome-ignore lint/style/noRestrictedImports: factory hook — only file allowed to import useEffect
import { useEffect, useRef } from 'react';

type ListenerTarget = Window | Document | Element | null;

/**
 * Attaches an event listener with automatic cleanup.
 * The handler always uses the latest closure (no stale values).
 */
export function useEventListener<K extends keyof WindowEventMap>(
  target: ListenerTarget,
  event: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): void {
  const savedHandler = useRef(handler);
  savedHandler.current = handler;

  // biome-ignore lint/correctness/useExhaustiveDependencies: target, event, and options are the reactive deps
  useEffect(() => {
    if (!target) return;

    const listener = (e: Event) => savedHandler.current(e as WindowEventMap[K]);
    target.addEventListener(event, listener, options);
    return () => target.removeEventListener(event, listener, options);
  }, [target, event, options]);
}
