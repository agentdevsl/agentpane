# 04 - API, Security, Frontend, Testing, and Operations

## Verdict

Security and API hygiene improved since April: body limits are mounted, skill frontmatter serialization is safer, code highlighting is sanitized, and raw JSON parsing has been reduced sharply. The highest-risk remaining items are authorization mismatches on GitHub routes and the continued live use of the deprecated shell command path.

## Findings

### MAY-01 - P0 - GitHub App administration is viewer-level

The GitHub integration is guarded as `viewer` in the router (`src/server/router.ts:504`) and GitHub App routes are mounted under that path (`src/server/router.ts:614`). Those routes can create app manifests (`src/server/routes/github-app.ts:51`), save global app credentials (`src/server/routes/github-app.ts:159`), register/delete installations (`src/server/routes/github-app.ts:191`, `src/server/routes/github-app.ts:236`), and delete credentials (`src/server/routes/github-app.ts:258`).

Impact: a viewer can mutate global GitHub App configuration and credentials. This is an authorization boundary failure.

Recommendation: require `admin` for global app credential/manifest/setup/delete routes. Require team admin for team installation mapping. Add explicit 403 tests for viewer and agent_operator roles.

### MAY-08 - P1 - GitHub clone/template mutation routes are viewer-level

`/api/github/clone` and `/api/github/create-from-template` are under the same viewer guard (`src/server/router.ts:504`). They perform filesystem writes (`src/server/routes/github.ts:148`, `src/server/routes/github.ts:293`) and GitHub mutations (`src/server/routes/github.ts:220`).

Impact: low-privilege users can cause server-side repository creation/cloning and disk consumption.

Recommendation: require `agent_operator` or `admin`, add quota/audit logging, and move long-running clone/template work into an async job path.

### MAY-11 - P1 - Deprecated `sh -c` path remains live

`CommandRunner.exec()` still invokes `sh -c` (`src/server/bootstrap/service-container.ts:68`, `src/server/bootstrap/service-container.ts:92`). `GitService` still calls it in several read paths (`src/services/git.service.ts:128`, `src/services/git.service.ts:315`, `src/services/git.service.ts:388`).

Impact: the most dangerous command execution path remains available and easy to reuse. Some current calls are operator/internal, but the architectural affordance is still unsafe.

Recommendation: migrate `GitService` to `execArgs`. Restrict shell execution to explicitly operator-authored scripts. Add a lint/grep test that fails new `runner.exec(command)` call sites.

### MAY-15 - P1 - Rate limiting is still single-instance

The limiter now supports a SQLite-backed store, which fixes restart bypass. Comments explicitly note multi-instance drift (`src/lib/api/rate-limiter.ts:17`, `src/lib/api/rate-limiter.ts:208`). `createSqliteBackend()` writes to the app DB (`src/lib/api/rate-limiter.ts:219`), so it is not globally shared across per-pod SQLite files.

Impact: horizontal scaling multiplies effective quotas.

Recommendation: for hosted deployments, use a shared limiter backend or block/flag multi-instance deployment without shared limiter state. For single-instance self-hosted, document the limitation clearly.

### MAY-37 - P1 - Stream auth is still partial for non-addressable streams

Stream auth is stronger for session/plan/sandbox paths, but index/bare-kind paths, `cli-monitor`, and `terraform/:id` remain cookie-only.

Recommendation: deny broad paths by default and add DB-backed ownership or signed scoped stream tokens for streams without persistent ownership rows.

### MAY-38 - P2 - Session cookie secure behavior is environment-only

Session cookie `Secure` behavior is tied to `NODE_ENV === production`, and clear-cookie paths do not consistently mirror all cookie attributes.

Recommendation: derive secure cookies from request/proxy protocol or a `COOKIE_SECURE` setting. Use the same attributes when clearing cookies.

### MAY-39 - P2 - RBAC remains split between middleware and handler checks

Some routes use middleware-level role guards. Team and token routes use handler-level checks. There is no registration-time guarantee that every `/api/*` route has an explicit auth/RBAC policy.

Recommendation: introduce a route registry/wrapper that requires auth metadata at registration. Add a test that enumerates all mounted `/api/*` routes and asserts a policy.

### MAY-40 - P2 - API list envelopes remain inconsistent

Sessions return `data: items` plus a top-level `pagination` object in some paths, while other routes use `{ items, nextCursor, hasMore }`.

Impact: frontend code shape-juggles responses, and generated typed clients are harder to adopt.

Recommendation: standardize `ListResponse<T>` and export/generate contracts from server schemas.

### MAY-41 - P2 - Frontend data flow is mixed

TanStack Router loaders exist, but high-traffic pages still manually refetch/poll and adapt API response shapes locally. Only the root route has a broad error boundary.

Recommendation: pick one data path per route, move polling into shared query/DB sync, and add route-local error boundaries for sessions/codespaces/tasks.

### MAY-42 - P2 - TanStack DB session collections are partial

Session collections are partially adopted, but stop/unsubscribe paths do not clear collection data. `useSession` consumers have not fully converged onto the collection-backed path.

Recommendation: implement per-session collection cleanup/retention and migrate session consumers behind one data source.

### MAY-43 - P2 - Coverage and UI E2E are not hard gates

Coverage exists but is non-blocking, and UI/Agent Browser E2E is not part of the required CI path. Frontend code is excluded from Vitest coverage by design, so browser smoke tests matter more.

Recommendation: make backend coverage gating required after baseline stabilization, and add a required or scheduled Agent Browser task/session lifecycle smoke.

### MAY-44 - P3 - Ops ergonomics remain incomplete

Backup CronJob is default-off, docs reference `.env.example` but the file is missing, and `prepare` only prints hook instructions.

Recommendation: add `.env.example`, decide whether production values should require backups, and make hook setup explicit or automated.

## Resolved or materially improved

- Body-size limits are mounted on `/api/*` and `/hooks/*`.
- YAML skill injection uses structured serialization.
- Code highlighting HTML is sanitized before render.
- Raw route `c.req.json()` usage is now limited to a special optional-body memory route.
- A release workflow exists, though image build coverage still needs operational review.
