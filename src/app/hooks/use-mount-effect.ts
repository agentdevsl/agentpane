// biome-ignore lint/style/noRestrictedImports: factory hook — only file allowed to import useEffect
import { useEffect } from 'react';

/**
 * Runs an effect exactly once on mount. For syncing with external systems.
 * This is the only sanctioned way to run a mount-only effect.
 */
export function useMountEffect(effect: () => void | (() => void)): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design
  useEffect(effect, []);
}
