# Hooks — useEffect Ban

Direct `useEffect` is banned in this codebase. Biome enforces this via `noRestrictedImports`.

## Decision Tree

Need an effect? Ask:

1. **Fetching data on route load?** Use a TanStack Router `loader` function
2. **One-time setup on mount?** `useMountEffect(effect)` — runs once, supports cleanup
3. **Re-run when deps change?** `useWatchEffect(effect, deps)` — controlled re-execution
4. **Polling or heartbeat?** `useInterval(callback, delayMs)` — pass `null` to pause
5. **Delayed action (auto-dismiss)?** `useTimeout(callback, delayMs)` — returns `reset`/`clear`
6. **DOM event listener?** `useEventListener(target, event, handler, options)`
7. **Auto-scroll to bottom?** `useAutoScroll()` — returns `containerRef`, `handleScroll`, `scrollToBottom`, `showScrollButton`
8. **Copy to clipboard with indicator?** `useCopyToClipboard(resetMs?)` — returns `{ copied, copy }`
9. **Sync with localStorage?** `useLocalStorage(key, initialValue)` — returns `[value, setValue]`
10. **Keep a callback ref fresh?** `useEffectEvent(callback)` from React 19 — no effect needed
11. **None of the above?** Create a new factory hook in this directory. Only factory hooks may import `useEffect`.

## Factory Hooks

All factory hooks live in `src/app/hooks/` and are re-exported from `use-effect-factories.ts`.

| Hook | File | Import `useEffect`? |
|------|------|-------------------|
| `useMountEffect` | `use-mount-effect.ts` | Yes |
| `useWatchEffect` | `use-watch-effect.ts` | Yes |
| `useInterval` | `use-interval.ts` | Yes |
| `useTimeout` | `use-timeout.ts` | Yes |
| `useEventListener` | `use-event-listener.ts` | Yes |
| `useAutoScroll` | `use-auto-scroll.ts` | Yes |
| `useCopyToClipboard` | `use-copy-to-clipboard.ts` | No (uses `useTimeout`) |
| `useLocalStorage` | `use-local-storage.ts` | No (uses `useMountEffect`) |

## Adding a New Factory Hook

1. Create `src/app/hooks/use-your-hook.ts`
2. Add `// biome-ignore lint/style/noRestrictedImports: factory hook` before the `useEffect` import
3. Add the file to the Biome override in `biome.json` (the factory hooks override block)
4. Export from `use-effect-factories.ts`

## Why

Direct `useEffect` causes: brittle dependency arrays, infinite loops, hidden coupling, and hard-to-trace execution order. Factory hooks make the intent explicit and the cleanup automatic.
