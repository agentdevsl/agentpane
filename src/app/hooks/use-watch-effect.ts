// biome-ignore lint/style/noRestrictedImports: factory hook — only file allowed to import useEffect
import { type DependencyList, type EffectCallback, useEffect } from 'react';

/**
 * Runs an effect that re-executes when specific dependencies change.
 * Use this for effects that need to re-subscribe or re-sync when a value
 * like `sessionId` changes. The deps array is managed by the caller.
 *
 * This is the sanctioned way to run a dependency-based effect.
 */
export function useWatchEffect(effect: EffectCallback, deps: DependencyList): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps managed by caller
  useEffect(effect, deps);
}
