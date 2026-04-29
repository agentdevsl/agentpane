# 07 — API Surface (April 29 Review)

## Summary

The Hono surface remains 40 route modules / ~250 endpoints (`src/server/routes/` has **40 files** at HEAD `25c1c4f0`; the last full count was 39 in the April 20 review and `CLAUDE.md` still says 33). PRs #176, #178, #179 closed the three flagship findings from April 20: cursor pagination has a canonical helper (`src/lib/api/pagination.ts`) used by `/api/tasks`, `/api/sessions` (global), and `/api/events/log`; the `{ok:true, data:[]}` mask in `/api/codespaces/:id/skills` was replaced with proper `{ok:false}` propagation; the rate limiter is now key-derivation-pluggable and emits a one-time warning when run with the in-memory backend. Request-ID propagation also got a real test (`src/lib/api/__tests__/request-id-propagation.test.ts`).

Past those three, the surface still drifts. List envelopes are split four ways (flat array + sibling `pagination`, `{items, totalCount}` with no cursor, `{items, nextCursor:null, hasMore:false, totalCount}` placeholder, real cursor envelope). 31 handlers still call `c.req.json()` directly instead of `parseJsonBody` — `templates`, `workflows`, `marketplaces`, `agents`, `terraform`, and several `tasks` handlers all bypass Zod for request bodies, casting `body` to a hand-typed shape. The endpoints spec (`specs/application/api/endpoints.md`) is two renames behind: every reference is `/api/projects` / `project-members` / `team-projects`, but the code uses `/api/codespaces` / `codespace-members` / `team-project-folders`. There is still no OpenAPI surface, no `Idempotency-Key` handling on POST endpoints that retry-vulnerable agents fire (`/tasks/:id/move`, `/agents/:id/start`, `/marketplaces/:id/sync`), no body-size cap, and no API version prefix — `/api/...` is an implicit `v1` with no stated upgrade path. The dead `withErrorHandling` wrapper in `src/lib/api/middleware.ts` still pretends to be canonical and auto-includes raw `String(error)` in `details`, which would leak stack traces if anyone wired it up.

## Map

| Layer | File(s) | Notes |
|-------|---------|-------|
| Router / middleware | `src/server/router.ts:315` | CORS → logger → request-ID → security → metrics → rate limit → auth → enrich → token-rate-limit → tag-access → role guards |
| Request-ID | `src/server/router.ts:97-104` | AsyncLocalStorage frame; only `requestContextStorage.run({...}, () => next())` |
| Auth / RBAC | `src/lib/api/auth-middleware.ts`, `rbac-middleware.ts`, `src/server/shared.ts:183-377` | `requireRole`, `requireTeamRole`, `requireCodespaceRole`, `requireTagAccess` |
| Rate limiter | `src/lib/api/rate-limiter.ts` | F07-04 done — pluggable backend, key-derivation user→token→IP |
| Pagination helper | `src/lib/api/pagination.ts:103-124` | New `paginate()` + `decodeRequestCursor()`; only 3 routes consume it |
| Validation helpers | `src/server/validation.ts:244`, `src/server/shared.ts:264` | `parseJsonBody`, `validateIdParam`, `requireQueryId` |
| Response envelope types | `src/server/shared.ts:386-410` | `ApiResponse<T>`, `success()`, `failure()` |
| Largest modules | `sandbox.ts` 1,341 / `events.ts` 1,212 / `sandbox-k8s.ts` 680 / `memory.ts` 638 / `workflow-designer.ts` 597 | Unchanged from April 20 |
| Frontend hand-written client | `src/lib/api/client.ts` (~1,600 LOC) | 30+ `apiServerFetch<unknown>` callsites |
| Endpoints spec | `specs/application/api/endpoints.md` | 17 references to `/api/projects` (renamed); 0 to `/api/codespaces` |

## What's working

- **F07-01 cursor pagination shipped** for the highest-traffic routes. `src/lib/api/pagination.ts:103` exposes `paginate()` and `decodeRequestCursor()`. `tasks.ts:64-99`, `sessions.ts:202-251`, and `events.ts:979-1022` (event log) all consume it. The contract test `tests/api/list-endpoint-contract.test.ts:80-118` enforces both flat and cursor shapes via shared assertions.
- **F07-03 mask removed** in `codespaces.ts:430-449`. Template service errors now propagate as `{ok:false}` with `result.error.status`. The five legitimate empty results in `events.ts` (sources/log when user has no teams or no sources) now carry `source: 'empty' as const` so future code can distinguish degraded states.
- **F07-04 rate-limit key derivation** is now `userId → tokenId → IP` via `defaultKeyFrom` (`rate-limiter.ts:107-116`). A `RateLimitBackend` interface accepts a Redis drop-in. The in-memory backend logs `warnInMemoryOnce()` on first use so multi-instance deployments are visible. Behind a NAT, a single corporate IP no longer throttles every authenticated user.
- **F07-05 request-ID propagation** has a regression test at `src/lib/api/__tests__/request-id-propagation.test.ts`. `getRequestId()` is consumed by the structured logger (`src/lib/logging/logger.ts:188`), event metadata (`src/services/session/event-metadata.ts:50`), the SDK stream handler (`src/lib/agents/stream-handler.ts:33`), and `invariant` (`src/lib/utils/invariant.ts:35,63`).
- **`onError` and `notFound`** in `router.ts:674-699` emit canonical `{ok:false, error:{code,message}}`. Dev-mode `err.message` echo is gated on `NODE_ENV === 'development'`, so production deployments only see `'An unexpected error occurred.'`.
- `parseJsonBody` distinguishes `SyntaxError` from other parse failures (`validation.ts:252`) and is consumed by ~17 modules.
- Health surface: `/api/healthz`, `/api/readyz`, `/api/health`, `/api/health/liveness`, `/api/health/readiness` are all wired with auth-exempt paths. `health.ts:60-83` has the `isSandboxReady` 503 gate.
- **CORS exemption is centralised**: only `/api/auth/*`, `/api/health`, `/api/healthz`, `/api/readyz` skip auth (`router.ts:196-202`). All other middleware-bypass paths are commented with AR-* references.
- Test scaffolding: `tests/api/list-endpoint-contract.test.ts` and `tests/fixtures/list-contract.ts` lock the flat vs cursor shapes — copying the wrong generic into `apiServerFetch<T>` will fail in CI.

## Findings

### F07-01 — Pagination consistency: 3 of ~25 list endpoints adopt the canonical envelope

- **Priority:** P1
- **Effort:** L
- **Observation:** The April 20 PR migrated 3 routes (`/api/tasks`, `/api/sessions` global, `/api/events/log`). The other ~22 list endpoints diverge.
  - `src/server/routes/codespaces.ts:61-77,178-207` returns a placeholder `{items, nextCursor: null, hasMore: false, totalCount}` that *looks* cursor-shaped but does not respect any incoming cursor — clients can never advance pages.
  - `src/server/routes/templates.ts:28-37` does the same placeholder.
  - `src/server/routes/sandbox.ts:101-108`, `marketplaces.ts:29-50,114-122`, `terraform.ts:67-87,250-256` use `{items, totalCount}` with no pagination cursor at all.
  - `src/server/routes/sessions.ts:175-184` (filtered branch with `codespaceId`) returns `data: T[]` with sibling `pagination: {limit, offset, total, hasMore}` — flat shape.
  - `src/server/routes/sessions.ts:347-359` (`GET /api/sessions/:id/events`) returns `data: T[]` with sibling `pagination` containing five offset variants (`offset`, `afterEventId`, `beforeOffset`, `fromOffset`, `toOffset`).
  - `src/server/routes/memory.ts:48-58` defines its own `parsePagination(page, size)` shadowing `shared.ts:40`. Six handlers (`memory.ts:103,190,213,249,312,529`) emit `data: T[]` with sibling `pagination: {page, size, hasMore}` — neither cursor nor offset shape.
  - `src/server/routes/cli-monitor.ts:354-381` returns `data: { sessions, total }` with no pagination metadata at all even though it accepts `limit`/`offset`.
  - `src/server/routes/rbac-tokens.ts:331,344-389` uses an opaque-but-actually-bare `cursor` (it's the raw token id passed to `gt(apiTokens.id, cursor)`) — not the base64 payload format `cursor.ts` defines.
- **Risk:** Clients that copy a working `useInfiniteQuery` block from `/api/tasks` to `/api/templates` get an unmovable first page; helper code per envelope; mid-scroll insert/delete drift on offset endpoints; the rbac-tokens endpoint ignores the cursor signature/sort fields, so a tampered cursor or a sort change silently misorders.
- **Recommendation:** Either commit to migrating the next 5 highest-traffic offset endpoints (`/api/codespaces`, `/api/codespaces/summaries`, `/api/templates`, `/api/marketplaces`, `/api/memory/insights`) onto `paginate()`, or rewrite `pagination.md` to label the *placeholder* envelope as legacy and remove the misleading `nextCursor: null, hasMore: false` fields from `codespaces.ts` and `templates.ts` so future devs do not confuse them with real cursor endpoints.
- **Links:** `src/lib/api/pagination.ts:103-124`, `specs/application/api/pagination.md`.

### F07-02 — List response shape variance: 4 distinct envelopes still in production

- **Priority:** P1
- **Effort:** M
- **Observation:** The contract test `tests/api/list-endpoint-contract.test.ts` recognises only **two** shapes (`assertFlatListShape` and `assertCursorEnvelopeShape`). The actual code emits four:
  1. **Flat array + sibling pagination** — `sessions.ts:175-184,242-251,347-359` (`data: T[]`).
  2. **Cursor envelope** — `tasks.ts:99` (`data: { items, nextCursor, hasMore, totalCount? }`).
  3. **Items + totalCount only** — `sandbox.ts:101-108`, `marketplaces.ts:29-50,114-122`, `terraform.ts:67-87,250-256`, `templates.ts:28-37`, `codespaces.ts:61-77,178-207`.
  4. **Bare data array, no pagination** — `agents.ts:32`, `memory.ts:181,235`, `marketplaces.ts:131-134`.
- **Risk:** `apiServerFetch<T>` callers must guess which shape applies. The double-wrap regression that prompted the test in `CLAUDE.md` ("API response types") will keep recurring as new endpoints land. `client.ts` already shows 13 sites typed `apiServerFetch<unknown>` — the type system has been forfeited for these calls because the shape varies.
- **Recommendation:** Pick one. Two acceptable options:
  - **(a)** Migrate every list endpoint to `paginate()` (F07-01). Codify "list endpoints MUST return `{items, nextCursor, hasMore, totalCount?}`" in CLAUDE.md and lint via a unit test that introspects every handler.
  - **(b)** Promote the flat-array shape (`{ok, data:[], pagination}`) for offset endpoints and keep cursor for cursor endpoints; drop the third "items+totalCount only" envelope. Update `assertFlatListShape` and `assertCursorEnvelopeShape` to be the only legal shapes.
- **Links:** `src/lib/api/client.ts:455`, `tests/api/list-endpoint-contract.test.ts:80-118`, `tests/fixtures/list-contract.ts`.

### F07-03 — Bare `c.req.json()` is still in 31 handlers; 5 modules bypass Zod entirely on writes

- **Priority:** P1
- **Effort:** M
- **Observation:** `parseJsonBody(c, schema)` is the canonical body parser, used by ~60 sites. **31 sites** still call `c.req.json()` directly (per `grep -rn "c\.req\.json()" src/server/routes/ | wc -l`). Some examples that bypass Zod entirely on the write path:
  - `src/server/routes/agents.ts:74-90` — `PATCH /api/agents/:id` casts `body: { config?: Partial<AgentConfig> } & Partial<AgentConfig>` and routes it straight into `agentService.update`. No `safeParse`, no max length, no enum check.
  - `src/server/routes/agents.ts:120-130,196-205` — `POST /api/agents/:id/start` and `/resume` call `c.req.json()` only to fish `taskId` and `feedback` out of an `unknown` body; only `taskId` gets `isValidId()` and `feedback` is forwarded with no length/type guard.
  - `src/server/routes/templates.ts:41-91,133-162` — `POST /api/templates` and `PATCH /api/templates/:id` accept a hand-typed body with no Zod schema; `scope` is checked against an inline `['org','codespace']` list and the error message says `"scope must be 'org' or 'project'"` (stale rename).
  - `src/server/routes/workflows.ts:97-135` — `PATCH /api/workflows/:id` casts `body` to a 13-field interface; `status` is bare-cast to the union without checking the enum, so a client can write `status: "garbage"` and the service will store it.
  - `src/server/routes/terraform.ts:91-103,169-201,273-289` — three handlers parse JSON manually then run Zod, but `POST /validate` only checks `body.code` is a string, no length/safety.
  - `src/server/routes/marketplaces.ts:55-86` — `POST /api/marketplaces` casts to a manual interface; only presence of `name` and `githubUrl|owner+repo` checked.
  - `src/server/routes/tasks.ts:248-271,278-310,318-358` — `reject-plan`, `approve`, and `reject` all parse body inside a try/catch and continue with `reason = undefined` when JSON parsing fails. `reject` then re-checks for `reason` and 400s, but `approve-plan` and `approve` silently accept the parse failure. Variable `body.approvedBy` is forwarded to `taskService.approve` with no length cap.
- **Risk:** Hand-typed casts in TS are not enforced at runtime. A client can send `{config: {model: "claude-sonnet"}, name: "x".repeat(1_000_000)}` to `PATCH /agents/:id` — `body.name` will reach `agentService.update`. Error messages drift (`'project'` in templates is the wrong scope name). Rejecting tasks with `reason: 12345` (number) currently returns 400 because the truthy/string check passes for `''`, but `reason: ' '` whitespace bypasses the `trim() !== ''` check.
- **Recommendation:** Mandate `parseJsonBody(c, schema)` everywhere and add a Biome rule (or a unit test that scans `routes/*.ts`) catching raw `c.req.json()` calls. Move the templates create/update/patch and workflows update bodies into `validation.ts` as `createTemplateSchema` / `updateWorkflowSchema`. The `agents.ts` start/resume bodies should use `agentStartSchema = z.object({taskId: idSchema.optional()})` and `agentResumeSchema = z.object({feedback: z.string().max(10000).optional()})`.
- **Links:** `src/server/routes/agents.ts:74,120,196`, `templates.ts:41,133`, `workflows.ts:97`, `tasks.ts:248,278,318`.

### F07-04 — Endpoints spec is two renames behind code

- **Priority:** P1
- **Effort:** M
- **Observation:** `specs/application/api/endpoints.md` is the source of truth for partner integrations. It has **17** references to `/api/projects`, `/api/project-members`, `/api/team-projects` — the *old* naming. There are **0** references to `/api/codespaces`, `/api/codespace-members`, `/api/team-project-folders`. The spec also names the module file as `projects.ts`, `project-members.ts`, `team-projects.ts` — none of which exist (`codespaces.ts`, `project-members.ts` for `codespaces/:id/members`, `team-project-folders.ts`). Endpoint count says "33 route modules producing 120+ endpoints"; reality is **40 modules** producing **246 route definitions** (`grep -rn "app\.\(get\|post\|put\|patch\|delete\)" src/server/routes/ | wc -l`). The April 20 review counted 39; this review counts 40 (1 added since). `CLAUDE.md` still says "33 route modules, 60+ endpoints".
- **Risk:** Any contributor or integration reading the spec will fail every endpoint check — the URLs they curl don't exist. RBAC role table at `endpoints.md:120-137` still keys on `/api/projects` so the spec disagrees with `router.ts:420` which uses `/api/codespaces`.
- **Recommendation:** Either generate `endpoints.md` from the running router (`Hono.showRoutes()` + a small script) or do a one-shot rewrite covering the 40 current modules. Rewrite + regression: a CI step that grep-fails when `endpoints.md` mentions `/api/projects`, `project-members`, or `team-projects`.
- **Links:** `specs/application/api/endpoints.md`, `CLAUDE.md` (project instructions).

### F07-05 — `cli-monitor` register/heartbeat/ingest/deregister return `{ok:true}` with no `data`

- **Priority:** P2
- **Effort:** XS
- **Observation:** `src/server/routes/cli-monitor.ts:276,294,321,329` all `c.json({ ok: true })` without a `data` field. The canonical envelope per `shared.ts:386-401` is `{ok: true, data: T}`. Clients that strict-parse `ApiResponse<T>` will treat this as malformed; lenient clients ignore `data`. Same shape leak in `settings.ts:176` (`PUT /api/settings`).
- **Risk:** When a daemon ingest fails partially (some sessions accepted, some not), there is no `data` field to surface that, so the daemon retries the whole batch. Doc drift (the spec promises `data: T`).
- **Recommendation:** Return `{ok: true, data: { accepted: count, rejected: count }}` for ingest/heartbeat; `{ok: true, data: null}` (already used in `tasks.ts:182`, `templates.ts:175`) for register/deregister/settings.
- **Links:** `src/server/routes/cli-monitor.ts:276,294,321,329`, `src/server/routes/settings.ts:176`.

### F07-06 — `tasks/:id/move` returns `{ok:true}` even when agent auto-start failed

- **Priority:** P1
- **Effort:** S
- **Observation:** `src/server/routes/tasks.ts:215-227` — `taskService.moveColumn()` returns `{task, agentError}`. When `agentError` is present, the move succeeded (column updated) but the agent did NOT start. The route returns `{ok: true, data: {task, agentError}}`. This is the same anti-pattern F07-03 closed — clients reading `result.ok` see success, only deep-inspect callers will spot `agentError`.
- **Risk:** UI toasters key on `ok` and never surface `agentError`. The CLAUDE.md "Error bubbling" section explicitly warns against this. Worse: `taskService.moveColumn()` is supposed to revert the task to backlog when agent start fails (per the ENV "Error bubbling" guidance), but the route does not check whether revert happened — if revert fails, the task is stuck in `in_progress` with no agent and an opaque success response.
- **Recommendation:** When `agentError` is set, return either:
  - `{ok: false, error: {code: 'AGENT_START_FAILED', message: agentError, details: {taskId, column: 'in_progress', revertedTo: 'backlog'}}}` with HTTP 202 (accepted but not yet running) or 500 if revert also failed — *and* enforce that `moveColumn` reverted, or
  - keep `{ok: true}` only when the move + agent both succeeded, otherwise emit a partial-success status code (207 Multi-Status would be standards-compliant) with `{ok: false, error}` and `data: {task}`.
- **Links:** `src/server/routes/tasks.ts:201-227`, `src/services/task.service.ts` (`moveColumn`).

### F07-07 — No body-size cap; oversized JSON parsed before Zod rejects

- **Priority:** P2
- **Effort:** S
- **Observation:** Bun's `c.req.json()` does not enforce a max body size by default. Only `cli-monitor.ts:176-218` declares `MAX_BODY_SIZE_BYTES = 5 * 1024 * 1024` and rejects via `Content-Length` check. No global middleware. `memory.ts` caps insight `content` at 4096 chars in Zod, but the body is parsed in full before Zod runs — a 200 MB body of repeated `{"content":"..."}` would parse and throw OOM long before validation. `agents.ts:74` and `templates.ts:41` accept arbitrary bodies with no size guard.
- **Risk:** Memory amplification, slow handling under load, accidental DoS from a malformed client. Unauthenticated webhook endpoints (`/hooks/events/:slug`, `/hooks/github-app`) read `c.req.text()` without size check and forward to the event processor.
- **Recommendation:** Add `app.use('/api/*', bodyLimit({maxSize: 1_024_000}))` global middleware (Hono ships `bodyLimit`). Larger caps for `/api/cli-monitor/ingest` (5 MB) and webhook endpoints (1 MB) configured at the route-level via override. Reject early with `{ok:false, error:{code:'PAYLOAD_TOO_LARGE'}}` 413.
- **Links:** `src/server/routes/cli-monitor.ts:203-218` (the existing pattern), `src/server/router.ts:344-347` (webhook `c.req.text()`).

### F07-08 — Dead code `withErrorHandling`/`logRequest` still in `src/lib/api/middleware.ts` and includes `String(error)` in details

- **Priority:** P2
- **Effort:** XS
- **Observation:** `src/lib/api/middleware.ts:12-43` defines `withErrorHandling` and `logRequest`. Neither is used anywhere (`grep -rn "withErrorHandling\|ApiHandler" src/` returns only the file itself). The wrapper:
  - Generates its own `requestId` via `crypto.randomUUID()` — does not read from `requestContextStorage`, so if a future contributor wires it up it'd silently break F07-05 propagation.
  - Stamps `details: { error: String(error) }` into `failure(appError)`. `Error.prototype.toString()` does not include the stack by default, but in Node24 with `cause`-chain stringification a hostile error message can include verbatim file paths. Routing through `failure()` then serialises `details` into the wire response — so `{ ok: false, error: { code: 'API_UNHANDLED_ERROR', details: { error: '<full leaked text>' } } }` would ship to the client.
  - `logRequest` is a no-op with a comment "intentionally suppressed" — yet the function shape suggests it's a public API.
- **Risk:** A future PR that adopts `withErrorHandling` (because it's exported and named `withErrorHandling`) imports a request-ID generator that doesn't see AsyncLocalStorage, plus an information leak that reflects raw error toString to the client even in production (no `NODE_ENV` gate).
- **Recommendation:** Delete `src/lib/api/middleware.ts`. The Hono `app.onError` hook in `router.ts:674-695` covers everything that `withErrorHandling` claimed to cover, and it already gates messages on `NODE_ENV`.
- **Links:** `src/lib/api/middleware.ts`.

### F07-09 — `apiServerFetch<unknown>` is rampant; the contract test only covers 1 endpoint

- **Priority:** P2
- **Effort:** L
- **Observation:** `src/lib/api/client.ts` has at least 13 callsites typed `apiServerFetch<unknown>` (`grep -n "apiServerFetch<unknown>" src/lib/api/client.ts | wc -l` = 16). The frontend treats those as `any`. The contract test `tests/api/list-endpoint-contract.test.ts` only exercises **`/api/sessions`** for the flat shape — `tasks`, `events`, the placeholder cursor envelopes, and the offset-only endpoints have no contract assertion. Per CLAUDE.md the test exists *because* of this footgun, but its coverage is one route.
- **Risk:** `result.data.id` returns `undefined` from a misshapen response and the UI silently fails. Refactor of any list route can change the envelope without a test failure.
- **Recommendation:** Either (a) extend `list-endpoint-contract.test.ts` to test every list route registered on the router, picking the right shape based on the `Content-Type` of the response (route table + assertion picker), or (b) ditch the hand-written client and adopt `@hono/zod-openapi` + `hc<AppType>` typed RPC client, regenerating types from server schemas.
- **Links:** `tests/api/list-endpoint-contract.test.ts`, `src/lib/api/client.ts:336,448,540,572,615,...`.

### F07-10 — Two GET endpoints have side effects (auto-heal); no idempotency guard

- **Priority:** P2
- **Effort:** S
- **Observation:** `src/server/routes/sandbox-status.ts:94-134,140-171` — `GET /api/sandbox/status/:codespaceId` triggers `autoHealSandbox()` (creates a Docker container) and `autoHealK8sSandbox()` (creates a K8s pod) when status check finds the sandbox missing. GET is supposed to be safe and cacheable per RFC 9110 §9.2.1. A naive client that retries a flaky `GET /sandbox/status/:id` could provoke multiple concurrent heal attempts; the in-memory `autoHealInProgress` and `k8sAutoHealInProgress` flags partially mitigate but do not address the spec violation (caches, monitors, browsers may all GET freely).
- **Risk:** A health monitor that GETs `/api/sandbox/status/:id` every 30s could create sandbox containers it didn't intend to. The flags are module-level booleans — on a multi-instance deploy each instance can heal in parallel. A client that polls fires N healing attempts when 1 is needed.
- **Recommendation:** Either (a) move auto-heal to `POST /api/sandbox/status/:codespaceId/heal` (or `/api/sandbox/:codespaceId/start`) so the side effect is opt-in, and have the GET return `status: 'missing'` instead of healing, or (b) add an explicit `?heal=true` query param that the UI must opt into and document this in OpenAPI.
- **Links:** `src/server/routes/sandbox-status.ts:90-171`.

### F07-11 — `/api/auth/*` is exempt from auth middleware including `/auth/verify-stream` (no rate-limit on stream auth probes)

- **Priority:** P2
- **Effort:** S
- **Observation:** `router.ts:200-202` exempts the *entire* `/api/auth/*` prefix from auth middleware, which is correct for `/github`, `/github/callback`, `/logout`. But the prefix also matches `/api/auth/verify-stream` (`auth.ts:323-380`) — the Caddy `forward_auth` hook for SSE streams. That endpoint reads the session cookie, hashes it, and queries the DB on every call. Caddy will hit it once per stream connection, but a hostile client can fire it directly with arbitrary cookie contents to brute-force tokens. The IP rate limiter at `router.ts:398` *does* apply (it's added before auth), so 200/min/IP is the bound. A distributed attacker from N IPs gets 200N/min. The endpoint emits `{ok:false, error:{code:'UNAUTHORIZED'}}` 401 either way.
- **Risk:** With the F07-04 fix, the rate limit is per-IP for unauthenticated requests, which is the same exposure the April review flagged. A 32-byte session token (`hex(16)`) is well outside brute-force range, but the DB hit per call is real load — 200 lookup/min/IP under sustained attack across a million IPs = unbounded.
- **Recommendation:** Move `/api/auth/verify-stream` out of the auth-exempt prefix — it's not an auth-bootstrapping endpoint, it's an *auth-checking* endpoint. Either rename to `/api/streams/verify` or add an explicit prefix check in `createAuthMiddleware`. Independently, add a tighter rate limit (e.g. 30/min) on `/api/auth/verify-stream` keyed on IP.
- **Links:** `src/server/router.ts:200-202`, `src/server/routes/auth.ts:323`.

### F07-12 — No `Idempotency-Key` support on retry-vulnerable POSTs

- **Priority:** P2
- **Effort:** L
- **Observation:** Several POST endpoints fire side effects that are bad to repeat:
  - `POST /api/tasks/:id/move` → spawns container agent (unique sandbox + worktree)
  - `POST /api/agents/:id/start` → starts Claude Agent SDK session, charges tokens
  - `POST /api/marketplaces/:id/sync` → pulls a git repo, writes plugin cache
  - `POST /api/templates/:id/sync` → similar
  - `POST /api/codespaces` → creates git worktree, registers path
  - `POST /api/sessions/:id/export` → builds a JSON/markdown blob, no harm but expensive
  No endpoint reads or honours `Idempotency-Key`. CLAUDE.md `task-creation.service.ts` mentions an internal idempotency mechanism for AI-generated questions (`questionsId`), but there is no HTTP-level support, so retried POSTs after a 502/timeout double-spawn agents and double-charge tokens.
- **Risk:** Network blip + retry = duplicate agent run + token spend. Webhook redelivery already creates an idempotency need on `/hooks/events/:slug` and `/hooks/github-app` (delivery IDs are present but not stored/checked at the HTTP layer).
- **Recommendation:** Honour `Idempotency-Key` header on the listed POST endpoints. Store `(userId, idempotencyKey)` → `(status, response)` in a `idempotency_keys` table with a 24h TTL. On retry with the same key, replay the prior response. The `task-creation.service.ts:2072` pattern (in-memory tracking of `questionsId`) is the right starting point but needs to move to a shared store.
- **Links:** `src/server/routes/tasks.ts:201`, `agents.ts:116`, `marketplaces.ts:138`, `templates.ts:101`, `codespaces.ts:81`, `webhooks.ts:18`.

### F07-13 — No API version prefix; clients implicitly bind to "v1"

- **Priority:** P3
- **Effort:** L
- **Observation:** Every API path is `/api/<resource>`. There is no `/api/v1/...` or `Api-Version` header. CORS is configured single-origin (`router.ts:330`). Frontend, CLI (`packages/cli-monitor`), and any external integrations have no migration path when a breaking shape change ships — there's no overlap window.
- **Risk:** Changing `tasks.ts` from offset to cursor (already done) would have broken any v1-pinned client. Future `/api/codespaces` shape changes (F07-01) carry the same risk. There's no signal in the response either — no `X-Api-Version` header.
- **Recommendation:** Even without a routing change, emit `X-Api-Version: 2026.04` (or a semver) on every response so clients can detect breakage. Document a path-prefix migration plan: future breaking changes go under `/api/v2/...`; legacy under `/api/v1/...` (alias of `/api/...`) for ≥3 release cycles.
- **Links:** `src/server/router.ts:178-191` (security headers — same place to add `X-Api-Version`).

### F07-14 — Two route modules export 3 factories each; one inline `parsePagination` shadows the shared helper

- **Priority:** P3
- **Effort:** M
- **Observation:** `src/server/routes/tags.ts` exports `createTagsRoutes`, `createProjectTagRoutes`, `createTaskTagRoutes`. `src/server/routes/sandbox.ts` exports `createSandboxRoutes`, `createK8sRoutes`, `createNomadRoutes`. The latter has been split (per `sandbox-k8s.ts`, `sandbox-nomad.ts` exist as separate files), yet `sandbox.ts` still re-exports `createK8sRoutes` and `createNomadRoutes` — and `router.ts:558-559` mounts the ones from `sandbox-k8s.ts`/`sandbox-nomad.ts`, **not** the ones in `sandbox.ts`. Dead exports. Separately, `src/server/routes/memory.ts:48-58` defines a local `parsePagination(c, defaults)` returning `{page, size}` — the shared helper at `src/server/shared.ts:40` returns `{cursor, limit}`. Same name, different return type, different semantics, no warning.
- **Risk:** Dead exports → confusion + dead-code lint failures. Shadowed helper → a contributor importing `parsePagination` from `shared.ts` then editing `memory.ts` will silently break offset-vs-cursor distinction.
- **Recommendation:** Delete the unused factories from `sandbox.ts`. Rename the inline `parsePagination` in `memory.ts` to `parsePaginationOffset` (or migrate memory routes to the shared helper).
- **Links:** `src/server/routes/sandbox.ts:415-417,1100+`, `src/server/routes/memory.ts:48`.

### F07-15 — Mixed error codes and dropped Zod issue field paths

- **Priority:** P3
- **Effort:** S
- **Observation:** Across the 40 route modules, error codes for the same scenario differ: `INVALID_JSON` (`agents.ts:79`), `VALIDATION_ERROR` (`tasks.ts:46`), `INVALID_PARAMS` (`tasks.ts:307`), `MISSING_PARAMS` (`marketplaces.ts:73`), `INVALID_ID` (`shared.ts:273`), `INVALID_STATE` (`auth.ts:67`), `CONFIG_ERROR` (`webhooks.ts:38`). Validation message extraction also drifts: most routes do `parsed.error.issues[0]?.message`, but `sandbox.ts:128` does `parsed.error.issues.map((i) => '${i.path.join('.')}: ${i.message}').join('; ')` (better — includes the field path), while `terraform.ts:118` and `marketplaces.ts:73` only emit `parsed.error.issues[0]?.message`. So some endpoints tell clients which field broke; most do not.
- **Risk:** Inconsistent client error UX. Clients can't reliably switch on `code` because the same logical error (bad JSON body) lands on `INVALID_JSON`, `VALIDATION_ERROR`, or `MISSING_PARAMS` depending on the route.
- **Recommendation:** Standardise on `VALIDATION_ERROR` for body/query failures, `INVALID_JSON` only when the body isn't parseable JSON, `INVALID_ID` for ID-format failures, `MISSING_PARAMS` for required fields absent at the structural level. Always include `details: { issues: [{path, message, code}] }` so clients can render field-level errors. The `ApiFailure` shape already supports `details` (`shared.ts:391`) but most handlers drop it.
- **Links:** `src/server/shared.ts:391-410`, `src/server/validation.ts:210-219`, all route modules.

### F07-16 — `validateKubeconfigPath` and other helpers `throw` instead of returning `Result`

- **Priority:** P3
- **Effort:** S
- **Observation:** `src/server/routes/sandbox.ts:250-272` — `validateKubeconfigPath` throws `Error` for path traversal and disallowed prefixes. `parseKubeconfigParam` (`:396-412`) wraps it in try/catch to convert to a 400 response. `sandbox.ts:1094` — `validateNomadAddress` may throw inside a route handler that does NOT wrap it. `sandbox.ts:1152` — `throw dbErr` re-throws into Hono's `onError`. `workflow-designer.ts:154,162,200` — three throws inside `parseAIResponse` that are caught by an outer try/catch. The pattern is brittle: every new caller must remember the throw, and a missed wrap escapes to `app.onError` which strips context (only `INTERNAL_ERROR` reaches the client in production).
- **Risk:** A new route adds `validateKubeconfigPath(c.req.query('kubeconfigPath'))` outside parseKubeconfigParam → throws → onError → 500 with no context to debug.
- **Recommendation:** Convert the helpers to `Result<T>` (or `{ok, error}` shape) so the route handler explicitly handles the bad-path branch. The existing `Result` type in `src/lib/utils/result.ts` is the standard.
- **Links:** `src/server/routes/sandbox.ts:250,396,1094,1152`, `src/server/routes/workflow-designer.ts:154,162,200`.

### F07-17 — `setup-callback` and `workflow-designer` mirror upstream error messages verbatim

- **Priority:** P3
- **Effort:** S
- **Observation:** `src/server/routes/github-app.ts:127-141` — when GitHub's manifest conversion endpoint returns a non-2xx, the route returns `{ok:false, error: { code: 'GITHUB_CONVERSION_FAILED', message: 'GitHub returned ${response.status}: ${errorBody}' }}`. `errorBody` is the verbatim response body from GitHub. `src/server/routes/workflow-designer.ts:514-538` — Claude Agent SDK errors are filtered for "401" and authentication keywords, but otherwise the raw `error.message` (which may include API key prefixes, prompt fragments, or internal trace info) is emitted as `WORKFLOW_AI_GENERATION_FAILED` message. `terraform.ts:294-303` is better — it logs the full error and returns a generic `'Failed to validate Terraform code'`.
- **Risk:** Information leak: a misconfigured GitHub App returning HTML 503 page in `errorBody` lands in the client response. SDK errors might include token prefixes (`'invalid x-api-key sk-ant-api...'`) — the filter at line 519-524 catches that pattern but not all of them.
- **Recommendation:** Log full upstream errors via `log.error`, return a generic `message: 'Failed to ...'` with a stable error code, and attach a `requestId` so support can correlate. Do not echo upstream response bodies into API responses.
- **Links:** `src/server/routes/github-app.ts:127`, `src/server/routes/workflow-designer.ts:514`.

### F07-18 — `health.ts` liveness/readiness probes leak DB error messages

- **Priority:** P3
- **Effort:** XS
- **Observation:** `src/server/routes/health.ts:295-313` — `GET /api/health/readiness` returns `{ok:false, status:'not_ready', error: error.message}` on DB failure. `GET /api/health` (`:156-162`) similarly leaks `error.message` from the DB query. Probes are typically called by load balancers / Kubernetes which don't need (or read) the message — but they're public endpoints (auth-exempt at `router.ts:197`).
- **Risk:** SQLite/Postgres internal error details exposed to anyone who can reach the probe (typical k8s deployments expose readyz/livez to the cluster network or the ingress).
- **Recommendation:** Probes should return only the boolean status + minimal counter (e.g., consecutive failures) and log the full error server-side.
- **Links:** `src/server/routes/health.ts:295-313,156-162`.

## Cross-theme pointers

- F07-07 body-size cap and F07-11 auth-exempt verify-stream tie into [`specs/release_plan/02-security-hardening.md`](../release_plan/02-security-hardening.md).
- F07-09 typed client / OpenAPI is the precondition for the `hc<AppType>` migration described in [`./09-frontend-state.md`](./09-frontend-state.md) (if present).
- F07-12 idempotency keys are the HTTP-level expression of the agent-execution retry safety from [`./03-agent-execution.md`](./03-agent-execution.md).
- F07-04 endpoints spec drift is a documentation issue; consolidate with the wider doc-sync pass in [`./11-documentation.md`](./11-documentation.md) (if present).
- F07-08 dead-code `withErrorHandling` parallels the dead-code findings expected in [`./05-cross-cutting.md`](./05-cross-cutting.md).
