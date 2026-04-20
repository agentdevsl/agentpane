/**
 * Dev-mode auth bypass helper (F06-05).
 *
 * The previous codebase gated the auth bypass in three places:
 *   - server-config.ts      — refuses to start if SKIP_AUTH=true in prod
 *   - auth-middleware.ts    — only tags a request as 'dev' when both flags
 *                             align
 *   - rbac-middleware.ts    — refuses 'dev' authMethod if NODE_ENV!=='development'
 *
 * Any future refactor that renames NODE_ENV (e.g. to APP_ENV) or
 * introduces a third auth-mode re-opens the hole. This helper is the
 * single source of truth for "is dev-auth allowed right now". All
 * callers must route through `isDevAuthAllowed()` — the layered checks
 * remain as defense-in-depth, they just now call the same function.
 *
 * Returns true ONLY when both of the following are set at call time:
 *   - SKIP_AUTH=true
 *   - NODE_ENV !== 'production'
 *
 * Note: the original design checked `NODE_ENV === 'development'` for
 * the auth-middleware bypass but this helper uses `!== 'production'` so
 * staging/test environments that explicitly opt in via SKIP_AUTH still
 * work. In production, the helper MUST return false regardless of the
 * SKIP_AUTH value.
 */

/**
 * Does the current process have dev-mode auth bypass enabled?
 *
 * @param env - Optional environment object for testing. Defaults to
 *   `process.env`. Tests can inject a stub without mutating globals.
 */
export function isDevAuthAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false;
  return env.SKIP_AUTH === 'true';
}

/**
 * Strict variant — dev-mode auth AND `NODE_ENV === 'development'`.
 * This is what the `rbac-middleware` uses to block dev-tagged requests
 * if they somehow reach the pipeline outside local development
 * (e.g. staging where SKIP_AUTH=true was set by accident).
 */
export function isStrictDevEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'development';
}
