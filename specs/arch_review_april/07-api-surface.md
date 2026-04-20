# API Surface — Architecture Review (April 2026)

## Summary

The HTTP surface totals ~240 endpoints across **39 Hono route modules** (the "352" quoted elsewhere counts internal sub-paths and SSE). The middleware stack in `src/server/router.ts` is correct on paper — CORS → logger → request-ID → security headers → IP rate limit → auth → auth-enrichment → per-token rate limit → tag-access → role guards → route factory — but rigour falls off once you leave `router.ts`. Response envelopes are *mostly* `{ok, data}` but list shapes vary (bare `T[]` vs `{items}` vs `{items, totalCount, nextCursor}`), the cursor-based pagination spec is not honoured in code (offset everywhere, plus a bespoke `page`/`size` in memory routes), the rate limit is in-process per-IP with a documented multi-instance caveat, the request-ID is emitted but never surfaces in service logs or event payloads, and two modules (`events.ts` 1,168 LOC / 19 endpoints; `sandbox.ts` 1,341 LOC / 15 endpoints) mix CRUD, SSE, validation and RBAC. There is **no OpenAPI schema** and **no Hono typed client**: `src/lib/api/client.ts` hand-writes every response type, which is the direct cause of the `apiServerFetch<T>` double-wrap footgun flagged in `CLAUDE.md`.

## Map

| Layer | File(s) | Purpose |
|-------|---------|---------|
| Router / middleware | `src/server/api.ts`, `src/server/router.ts:227` | Mounts 39 modules; CORS → logger → request-ID → security headers → rate limits → auth → RBAC |
| Request-ID | `src/server/router.ts:91-98`, `src/lib/context/request-context.ts` | `X-Request-Id` + AsyncLocalStorage |
| Auth / RBAC | `src/lib/api/auth-middleware.ts`, `src/lib/api/rbac-middleware.ts`, `src/server/shared.ts:183-377` | `requireRole`, `requireTeamRole`, `requireCodespaceRole`, `requireTagAccess` |
| Rate limiter | `src/lib/api/rate-limiter.ts` | In-memory per-IP (200/min); per-token (100/min); multi-instance caveat documented |
| Response helpers / validation | `src/server/shared.ts`, `src/server/validation.ts:239` | `json`, `errorResponse`, `ApiResponse<T>`, `parseLimit/Offset/Pagination`, `parseJsonBody(c, schema)` |
| Largest modules | `sandbox.ts` 1,341 / `events.ts` 1,168 / `sandbox-k8s.ts` 680 / `memory.ts` 638 / `workflow-designer.ts` 597 | CRUD + SSE + RBAC mixed |
| Frontend client | `src/lib/api/client.ts` (~1,600 LOC) | Hand-rolled; duplicates server shapes |
| Pagination spec | `specs/application/api/pagination.md` | Declares cursor-based default; code uses offset |

## What's working

- Middleware order is correct: request-ID before auth, auth before RBAC, RBAC before per-token rate limiter (which needs enriched token scope).
- `createAuthMiddleware` exempts only `/api/health*`, `/api/readyz`, and `/api/auth/*` — no module can silently skip auth.
- Global `onError` and `notFound` emit canonical `{ok:false, error}`; dev-mode message echo is gated on `NODE_ENV`.
- `validateIdParam` / `requireQueryId` / `parseJsonBody` centralise the boring parts; `parseJsonBody` distinguishes `SyntaxError` from other parse failures and is used in ~17 modules.
- Rate-limiter emits `X-RateLimit-*` headers and honours `TRUSTED_PROXIES` for XFF unrolling.
- RBAC exceptions are commented with `AR-*` rationales (e.g., `/api/invitations`, `/api/me` intentionally skip middleware guards).

## Findings

### F07-01 — Pagination: cursor spec vs offset reality — **RESOLVED (April 2026, theme 07)**

- **Priority:** P1
- **Observation:** `specs/application/api/pagination.md` declares cursor-based as the primary strategy with Base64 payloads. In reality almost every list endpoint uses `parseLimit`/`parseOffset`: bare array (`/api/memory/insights`), `{items, totalCount}` without cursor (`/api/sandbox-configs`), or a degenerate `{items, nextCursor:null, hasMore:false, totalCount}` (`/api/tasks`). `memory.ts:48` even defines its own `parsePagination(page, size)` that collides with `shared.ts:40`. `events.ts:1419` is the only module with real `cursor`/`hasMore` wiring.
- **Risk:** Deep-page offset scans degrade as data grows; insert/delete during scroll causes skip/dup; cursor-scroll UIs are unreachable.
- **Recommendation:** Pick one strategy. Introduce a `paginate<T>()` helper emitting `{items, nextCursor, hasMore}` and migrate sessions, tasks, events.log first; or rewrite `pagination.md` to match code.
- **Resolution:** Added `paginate<T>()` + `decodeRequestCursor()` helpers in `src/lib/api/pagination.ts`. Migrated the three highest-traffic list routes — `GET /api/tasks`, `GET /api/sessions` (global list), `GET /api/events/log` — to the canonical cursor envelope. Extended `TaskService.list()` and `SessionCrudService.list()` to accept an optional `cursor` option that translates to a compound `(sortValue, id)` tuple comparison. Rewrote `specs/application/api/pagination.md` to describe both cursor (canonical) and offset (legacy) styles and annotate which endpoints live in each camp. Added `src/lib/api/__tests__/paginate-helper.test.ts` with a round-trip test that paginates through 100 rows and asserts no duplicates and no skips.
- **Follow-up:** Remaining offset endpoints can migrate opportunistically when their service methods are next touched.
- **Effort:** L.
- **Links:** [`specs/application/api/pagination.md`](../application/api/pagination.md).

### F07-02 — Response envelope variance: list shapes diverge

- **Priority:** P2
- **Observation:** Canonical envelope is `{ok, data: T}`, but `/api/tasks` returns `{data:{items, nextCursor, hasMore, totalCount}}`, `/api/memory/insights` returns `{data: Insight[]}`, `/api/teams/:id/members` returns `{data:{items}}` (no pagination), and `/api/events/sources` uses `{data:{items, nextCursor, hasMore}}`. The `apiServerFetch<T>` double-wrap warning in `CLAUDE.md` exists because developers guess `T` from one endpoint and mis-apply it to another.
- **Risk:** Silent UI bugs (`result.data.data` undefined); divergent refactoring.
- **Recommendation:** Define `ListResponse<T> = {items: T[], nextCursor: string|null, hasMore: boolean}` and enforce it for every list endpoint. Generate frontend types from schemas (F07-06).
- **Effort:** M.

### F07-03 — `{ok:true, data:[]}` used to mask infrastructure failures — **RESOLVED (April 2026, theme 07)**

- **Priority:** P1
- **Observation:** `CLAUDE.md` explicitly warns against this pattern, yet `src/server/routes/codespaces.ts:430,434` does it in `GET /api/codespaces/:id/skills`: when `templateService.getMergedConfig` fails (repo unreachable, parse error), the handler returns an empty list instead of `{ok:false, error}`. Same shape in `events.ts:193,675,682` when plugin directories are missing.
- **Risk:** UI cannot distinguish "no skills" from "sync broken"; users see empty state with no recovery signal.
- **Recommendation:** Return `{data:{items:[], source:'empty'|'degraded', degradedReason?}}` or propagate `{ok:false, error}`. Audit every `ok:true, data:[]` return.
- **Resolution:** `codespaces.ts` skills handler now propagates `templateService.getMergedConfig` failures as `{ok:false, error}` instead of masking as empty. The five `events.ts` empty-list returns (all legitimate "user has no teams / no sources" states, not failure masks) now carry `source: 'empty'` so a future `source: 'degraded'` variant can signal an upstream outage without breaking clients. Added `src/server/routes/__tests__/codespaces-skills.test.ts` to pin the non-ok response.
- **Effort:** S.

### F07-04 — Rate limit is per-IP, in-process, multiplies across instances — **RESOLVED (April 2026, theme 07, partial — backend-pluggable)**

- **Priority:** P1
- **Observation:** `rate-limiter.ts:6-13` admits "each instance maintains its own counters." Global IP limit 200/min, per-token 100/min, webhooks 60/min. A corporate NAT bottlenecks all users behind one IP; distributed attackers from many IPs are unthrottled. Session-cookie auth bypasses the per-token limiter entirely.
- **Risk:** DoS exposure, noisy-neighbour issues, throttling of legitimate teams behind proxies.
- **Recommendation:** Swap in Redis-backed counters keyed primarily on `userId`, with IP fallback for unauthenticated endpoints. Webhook routes should key on source slug.
- **Resolution:** Refactored `src/lib/api/rate-limiter.ts` to (a) derive keys via a pluggable `keyFrom(ctx)` function preferring `userId` → `tokenId` → trusted-proxy-aware IP, (b) expose a `RateLimitBackend` interface so the in-memory store can be swapped for Redis in one line without touching any middleware call site, (c) log a one-time startup warning when using the in-memory backend so operators running multi-instance deployments see the caveat. Did not introduce the Redis dependency — deferred to the operations-hardening workstream — but the drop-in shape is captured in the JSDoc example on `rateLimiter()`. Custom `keyFrom` lets webhook routes key on source slug (e.g. `webhook:github`) without reworking middleware. Added `F07-04` rate-limiter key-derivation tests in `src/lib/api/__tests__/rate-limiter.test.ts`.
- **Follow-up:** Provide a Redis `RateLimitBackend` (single file, ~30 LOC) and wire it under a `REDIS_URL` env gate.
- **Effort:** M.
- **Links:** [`specs/release_plan/02-security-hardening.md`](../release_plan/02-security-hardening.md).

### F07-05 — Request-ID never reaches services or event payloads — **RESOLVED (April 2026, theme 07)**

- **Priority:** P1
- **Observation:** `requestIdMiddleware` generates `req-{ts}-{counter}`, stores it via `requestContextStorage.run`, and echoes `X-Request-Id`. Only **7 callsites** use `getRequestId` across `src/` (router, logger×2, api/middleware×2, context file×2) — **zero in `src/services/`**. Detached tasks (`queueMicrotask`, `setImmediate`, stream handlers) lose AsyncLocalStorage. DurableStream event payloads carry no `requestId`.
- **Risk:** No correlation between an API request and the agent run, stream event, or DB write it triggered; when a 500 is reported, the trace chain is broken.
- **Recommendation:** Add `requestId` to the logger context unconditionally; thread it as an explicit field on service calls that publish events; add a regression test asserting `X-Request-Id` appears in at least one downstream log line.
- **Resolution:** Theme 10 F10-03 already plumbed `correlationId` into the durable-streams envelope via `createSessionEventMetadata(...)` — which reads from `getRequestId()` (AsyncLocalStorage) when no explicit id is supplied. Theme 07 verified this end-to-end: added `src/lib/api/__tests__/request-id-propagation.test.ts` which asserts (a) `getRequestId()` picks up the ambient request id, (b) nested async boundaries keep the same id, (c) the structured logger stamps it into output, (d) `createSessionEventMetadata` defaults `correlationId` to the current request id, (e) the "full loop" — response header == logger line == event envelope `correlationId` — holds for a single request. Because `createLogger` already pulls `getRequestId()` on every `.info/.error` call, no per-service wiring is required as long as services run under the AsyncLocalStorage frame the router establishes.
- **Effort:** M.
- **Links:** [`specs/release_plan/03-observability.md`](../release_plan/03-observability.md).

### F07-06 — No OpenAPI schema; frontend types duplicate server types

- **Priority:** P2
- **Observation:** No `@hono/zod-openapi`, no swagger route, no `hc<AppType>` typed client. `src/lib/api/client.ts` is ~1,600 LOC of hand-typed wrappers; many use inline `apiServerFetch<{id:string;…}>` generics (marketplaces, terraform) instead of named types. Drizzle `$inferSelect` types are not reused for wire shapes.
- **Risk:** Silent drift on server renames; onboarding requires editing both sides per endpoint.
- **Recommendation:** Cheapest — move route Zod schemas to `validation.ts`, export `z.infer<>` types, import into the client. Richer — adopt `@hono/zod-openapi` and serve `/api/openapi.json`.
- **Effort:** M / L.

### F07-07 — Two route modules are oversized and mix concerns

- **Priority:** P2
- **Observation:** `events.ts` (1,168 LOC, 19 endpoints) hosts sources/subscriptions CRUD, log queries, the SSE stream, and inline auth helpers (`:7-11` defers splitting). `sandbox.ts` (1,341 LOC, 15 endpoints) covers K8s/Nomad/config CRUD, DNS validation, minikube start, CRD install, and credential encryption — overlapping `sandbox-k8s.ts` (680) and `sandbox-nomad.ts` (447).
- **Risk:** Long review diffs; mixed concerns in one file; hard to extract tests.
- **Recommendation:** Extract shared helpers (`getUserTeamIds` → `src/lib/rbac/team-scope.ts`, SSE → `events-stream.ts`, event-log → `events-log.ts`); for sandbox, move shared body schema and credential encryption to `src/lib/sandbox/config-schema.ts`.
- **Effort:** M.
- **Links:** parallels F01-07 in [`./01-service-architecture.md`](./01-service-architecture.md).

### F07-08 — Zod validation usage is inconsistent

- **Priority:** P2
- **Observation:** ~17 modules use the canonical `parseJsonBody(c, schema)`. The rest call `c.req.json()` directly and cast (`cli-monitor.ts`, some `workflow-designer.ts` handlers, one `settings.ts` handler) or wrap in bespoke try/catch (`webhooks.ts:22-28` returns `INVALID_JSON`). Error codes vary: `INVALID_JSON`, `VALIDATION_ERROR`, `INVALID_PARAMS`, `MISSING_PARAMS`, `INVALID_ID`, `INVALID_STATE`, `CONFIG_ERROR`.
- **Risk:** Inconsistent client error handling; Zod field messages (`issues[0]?.message`) dropped in some routes.
- **Recommendation:** Mandate `parseJsonBody` via a Biome rule catching raw `c.req.json()`. Standardise on `VALIDATION_ERROR` with optional `details.issues` (the `ApiFailure` shape already supports `details`).
- **Effort:** S.

### F07-09 — Endpoint discoverability: no live index; docs stale

- **Priority:** P3
- **Observation:** `CLAUDE.md` lists "33 route modules, 60+ endpoints" — reality is 39 and ~240. No `/api/routes` or `/api/openapi.json`. Support and new contributors grep `src/server/routes/` to start a `curl` session.
- **Risk:** Doc-code drift; security reviews miss endpoints.
- **Recommendation:** Adopt `@hono/zod-openapi` (see F07-06) or add admin-only `GET /api/routes` that introspects Hono's `showRoutes()`; update CLAUDE.md count.
- **Effort:** S.

### F07-10 — `tags.ts` exports three factories for one data model

- **Priority:** P3
- **Observation:** `tags.ts` (413 LOC) ships `createTagsRoutes` (`/api/tags`), `createProjectTagRoutes` (`/api/codespaces/:id/tags`), and `createTaskTagRoutes` (`/api/tasks/:id/tags`) — three factories for the same model. `memory.ts` achieves similar scope variants with a single factory.
- **Risk:** Three places to fix when tag rules change; URL-shape split masquerading as behaviour split.
- **Recommendation:** Collapse to one factory exposing sub-routers per parent scope, or inline assoc routes into `codespaces.ts`/`tasks.ts`.
- **Effort:** S.

### F07-11 — No body-size cap; large JSON bodies parse before Zod rejects

- **Priority:** P3
- **Observation:** Bun's `c.req.json()` enforces no size cap by default. No route sets `maxBodyLength`; no global body-size middleware. Memory routes cap `content` at 4096 chars via Zod, but JSON is parsed in full before Zod runs.
- **Risk:** Memory amplification via oversized JSON; slow handling under load.
- **Recommendation:** Add body-size middleware under `/api/*` (reject `Content-Length > 1 MB` for most, higher cap for webhooks).
- **Effort:** S.
- **Links:** [`specs/release_plan/02-security-hardening.md`](../release_plan/02-security-hardening.md).

### F07-12 — Mixed middleware-level vs handler-level RBAC

- **Priority:** P3
- **Observation:** Most routes use middleware role guards (`router.ts:324-390`). Team routes use handler-level `requireTeamRole` because the role depends on the `:id` param (AR-008 comment). The two styles coexist silently: a future dev writing `/api/codespaces/:id/members` can miss the check or duplicate it.
- **Risk:** Missed or double authorisation; reviewer can't see the RBAC story for a route without opening the handler.
- **Recommendation:** Add a `useScopedRoleGuard(app, '/api/teams/:id', 'viewer')` helper resolving per-resource role once; document the "middleware vs handler" decision matrix inline.
- **Effort:** S.
- **Links:** [`specs/application/security/rbac.md`](../application/security/rbac.md).

## Cross-theme pointers

- Rate limit, auth exemptions, and body-size caps intersect with [`specs/release_plan/02-security-hardening.md`](../release_plan/02-security-hardening.md).
- Request-ID propagation and structured logging are the backbone of [`specs/release_plan/03-observability.md`](../release_plan/03-observability.md).
- Pagination re-implementation should pair with [`specs/arch_review_april/02-data-layer.md`](./02-data-layer.md) (cursor-based queries need compound index support).
- "Empty list masks error" mirrors error-bubbling gaps in [`specs/arch_review_april/03-agent-execution.md`](./03-agent-execution.md) F3.
