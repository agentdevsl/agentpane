# 12 — Cross-Cutting (April 29 Review)

## Summary

Compared to the April 20 review the picture is mixed. Real progress on a few P1 items: `BackgroundJob` interface adopted by 3 services (F12-04 partial), throws-from-services has dropped from 9 to 8 production sites and most are now in narrow defensive paths, the stream-id factory exists at `src/lib/streams/stream-id.ts` (F12-08). But a meaningful list of items has not moved at all and a few new issues have surfaced. The `useRoleGuard` rename (F12-11) was not done — 8 identical biome-ignores still in `src/server/router.ts:413-428`. The `@ts-nocheck` headers on memory tests (F12-10) are still there. There is a *new* duplicate-symbol problem: `ALLOW_ALL_TOOLS` is declared twice with different shapes (`'*'` string vs `['*']` array). `src/lib/api/schemas.ts` has 41 Zod schemas but only 4 are imported anywhere — substantial dead surface that drifts from the canonical set in `src/server/validation.ts` (e.g. `updateTaskSchema.title.max(200)` vs the active server schema's `max(500)`). 36 stream-prefix concatenation sites still bypass the typed factory. 41 distinct `process.env.*` vars are read inline; no typed precedence layer. 84 `Result` import paths fragment across 5+ string variants.

No P0. Several P1 because the gap is concrete and an existing bug magnet (schema drift, dual `ALLOW_ALL_TOOLS`, project/codespace API surface).

## Map

| Concern | Hot files | Count |
|---|---|---|
| Type escapes | 75 `as unknown as` (60 prod, ~15 test); 4 `: any`, 123 `as any` (105 in autogen `routeTree.gen.ts`) | grep |
| `@ts-nocheck` | `src/app/routeTree.gen.ts` (autogen, OK), 5 memory test files (still hidden) | 6 |
| `@ts-ignore`/`@ts-expect-error` | 0 in `src/`/`agent-runner/`/`packages/` | 0 |
| Throws in services | `agent-review.service.ts`, `container-exec.service.ts`, `session-stream.service.ts`, `terraform-compose.service.ts`, `github-app.service.ts` | 8 prod sites |
| Throws in routes | `sandbox.ts:255,266,1094`, `sandbox-k8s.ts:31,42`, `sandbox-nomad.ts:200`, `workflow-designer.ts:154,162,200` | 9 prod sites |
| Dead Zod schemas | `src/lib/api/schemas.ts` (32 of 36 unused, including 5 names that conflict with server canonical schemas) | 41 declared / 4 used |
| Stream-prefix concat (F12-08 still open) | `services/sandbox.service.ts`, `services/plan-mode.service.ts`, others | 36 untyped concat |
| Magic timing numbers | `services/scheduler.service.ts`, `services/cli-monitor/cli-monitor.service.ts`, `services/agent/agent-retry-queue.ts`, etc. | 28+ literal ms numbers |
| Project naming leftover | `src/server/routes/project-folders.ts`, `project-members.ts`, `validation.ts:161,167`, `templates.ts:71`, `config-service.ts:18,20,22,56,58,64` | 100+ identifier sites |
| `Result` import paths | `'../lib/utils/result.js'` (45), `'../../lib/utils/result.js'` (34), `'../utils/result.js'` (30), `'../../utils/result.js'` (21), `'@/lib/utils/result'` (5), 4 other variants | 9 distinct strings |
| `BackgroundJob` adoption | `EventCleanupService`, `SchedulerService`, `EventOutboxRelayService` adopted; `TaskCreationService.destroy()` still standalone; `auth.ts` cleanup, `agentcore-bridge` per-task timer, `cli-monitor.service.ts` heartbeats not on the interface | 3/8+ |

## What's working

- `BackgroundJobRegistry` exists, has tests, and 3 services implement it via `satisfies BackgroundJob` — F12-04 is partially closed and the framework is now drop-in for the holdouts.
- `src/lib/streams/stream-id.ts` exists, has branded types `PlanStreamId|SandboxStreamId|...`, runtime `assertStreamIdKind`, and 5 factory functions — F12-08 has the *infra* even if the *adoption* is partial.
- Service-layer throws have dropped from "9 throws across services" to 8, almost all narrow validation guards (eg `agent-review.service.ts:238` on missing text content) rather than wide error paths.
- `tool-whitelist` whitelist now fails closed for `[]`; `ALLOW_ALL_TOOLS = ['*']` is the documented sentinel.
- `noEmptyBlockStatements` is still `error` in non-test files (`biome.json:160`), and grep finds zero empty catch blocks in production code.
- `@ts-ignore` and `@ts-expect-error` are absent from production code (only third-party `agent-runner/node_modules/zod` produces hits).

## Findings

### F12-01: Dead-but-divergent `src/lib/api/schemas.ts` is a schema drift trap
- **Priority**: P1
- **Size**: M
- **Observation**: `src/lib/api/schemas.ts` exports 41 Zod schemas. A direct usage scan shows only 4 are imported anywhere outside the file: `createTaskSchema`, `updateTaskSchema`, `moveTaskSchema`, `createSessionSchema` (each 3 hits, all in tests), and `createWorkflowSchema` (the one real use, `src/server/routes/workflows.ts:8`). The remaining 32 schemas are dead. Worse, the shared names *diverge* from the canonical schemas in `src/server/validation.ts`:
  - `src/server/validation.ts:62` `updateTaskSchema.title.max(500)` vs `src/lib/api/schemas.ts:60` `updateTaskSchema.title.max(200)`.
  - `description.max(10000)` vs `max(5000)`.
  - `labels.array(string).max(20)` vs `max(10)`.
  - `src/lib/api/schemas.ts:5` even comments "canonical source in `src/server/validation.ts`" but then redefines the same names with *tighter* limits.
- **Risk**: A future contributor importing `updateTaskSchema` from `lib/api/schemas` (auto-import suggests both) silently applies the wrong limits client-side; clients reject titles 201–500 chars even though the server happily accepts them. The 32 dead schemas are also a maintenance footgun — knip will keep flagging them, and any reader trying to find "the" schema for a route hits two answers.
- **Recommendation**: Delete the 32 unused schemas from `src/lib/api/schemas.ts`. For the 4 schemas that must be shared (the task/session/workflow ones), re-export from the canonical `src/server/validation.ts` rather than redeclare. Add a Biome `noRestrictedImports` rule that forbids `src/lib/api/schemas` from declaring `*Schema` names that already exist in `src/server/validation.ts`.

### F12-02: `ALLOW_ALL_TOOLS` is declared twice with incompatible types
- **Priority**: P1
- **Size**: S
- **Observation**: Two exports with the same name but different shapes:
  - `src/lib/agents/hooks/tool-whitelist.ts:8` — `export const ALLOW_ALL_TOOLS = '*';` (a `string`)
  - `src/lib/constants/tools.ts:32` — `export const ALLOW_ALL_TOOLS: string[] = ['*'];` (a `string[]`)
  Both files comment "F06-06" and both are treated as the open-gate sentinel. Production callers `src/lib/github/config-sync.ts:86`, `services/container-agent/container-exec.service.ts:455`, `services/agent/agent-crud.service.ts:43,142`, `services/agent/agent-execution.service.ts:596` import the *array* version; the hook in `tool-whitelist.ts:31` checks `allowedTools.includes(ALLOW_ALL_TOOLS)` against its *string* version. The two happen to produce the same runtime behaviour — `['*'].includes('*')` is `true` — but a refactor that swaps imports without realising the type difference produces silent drift.
- **Risk**: Type confusion. If a caller assigns `ALLOW_ALL_TOOLS` from `tool-whitelist.ts` (the string `'*'`) to a `string[]` field, TypeScript catches it. But if the imports cross over, `tool-whitelist.ts:31`'s `.includes(ALLOW_ALL_TOOLS)` becomes `['*'].includes(['*'])` which is `false`, silently denying every tool. Knip flagged `ALLOW_ALL_TOOLS|DEFAULT_AGENT_TOOLS` as a duplicate export.
- **Recommendation**: Rename the hook-side constant to `ALLOW_ALL_TOOLS_SENTINEL = '*'` (or `WILDCARD_TOOL`) and have `tool-whitelist.ts:31` use that bare string. Keep `src/lib/constants/tools.ts` as the single `ALLOW_ALL_TOOLS = ['*']` constant and re-export the sentinel from there. One canonical name for the array form, a clearly-named singleton for the string form.

### F12-03: `useRoleGuard` rename was not applied — 8 duplicate biome-ignores remain
- **Priority**: P3
- **Size**: XS
- **Observation**: The April 20 review (F12-11) recommended renaming `useRoleGuard` → `requireRole`/`roleGuard` to delete 9 duplicate `// biome-ignore lint/correctness/useHookAtTopLevel` comments. Status check: `src/server/router.ts:305` still defines `function useRoleGuard(...)`, and lines 413, 415, 417, 419, 421, 423, 425, 427 still each carry `// biome-ignore lint/correctness/useHookAtTopLevel: useRoleGuard is a Hono middleware helper, not a React hook` — 8 copies in a 16-line block.
- **Risk**: Same as before — visual noise invites cargo-culting and a real misuse would be camouflaged. None of the prior risks materialised, hence P3 not P2.
- **Recommendation**: Rename `useRoleGuard` to `attachRoleGuard` (or `roleGuard`/`requireRoleOnPath`). One rename across `src/server/router.ts:305,413-428` and the 8 `biome-ignore` comments delete cleanly. ~30 minutes including `npx tsc --noEmit`.

### F12-04: `ts-nocheck` still hides the memory test suite — F12-10 not actioned
- **Priority**: P2
- **Size**: M
- **Observation**: `src/services/memory/__tests__/dream.service.test.ts:1`, `insight-deriver.service.test.ts:1`, `memory.service.test.ts:1`, `memory-store.service.test.ts:1`, `skill-tracking.service.test.ts:1` — all five files still open with `// @ts-nocheck — test mocks use loose types`. April 20's F12-10 recommended deleting these and creating typed mock factories. Verified with `grep -rn "// @ts-nocheck" src/`.
- **Risk**: Memory subsystem tests don't exercise type contracts. A `MemoryStoreService.recordExecution()` signature change passes both `tsc --noEmit` and the test file because typing is disabled. Real bugs caught only in functional/integration runs.
- **Recommendation**: Same as April 20 — delete the headers, create `src/services/memory/__tests__/mocks.ts` with `createMockSettingsService(overrides?)` and `createMockSkillTrackingService(overrides?)` factory functions returning `Partial<T>` cast through one well-commented `as unknown as T`. Then fix whatever errors surface (estimated 30–60 surface-level, mostly missing `vi.fn()` return-type annotations).

### F12-05: 36 stream-id concatenation sites bypass the typed factory
- **Priority**: P2
- **Size**: M
- **Observation**: `src/lib/streams/stream-id.ts` exists with `planStreamId(id)`, `sandboxStreamId(id)`, `terraformStreamId(id)`, `sessionStreamId(id)` factories and branded types — F12-08 from April 20 was infrastructurally addressed. But `grep -rEn '`(plan|sandbox|terraform):${' src/ --include='*.ts'` returns **36 sites** that still build IDs by string concatenation:
  - `src/services/sandbox.service.ts:139,269,300,320,369,470` — six sandbox stream IDs constructed inline.
  - `src/services/plan-mode.service.ts:234,308,315,435,440,452,458,502,509,584,590` — eleven plan stream IDs.
  - Plus more in container-agent, durable-streams, codespace.service, terraform-compose.
  Outside `stream-id.ts` itself, **zero** files import `planStreamId`/`sandboxStreamId`/`terraformStreamId`/`sessionStreamId`. The factory is unused.
- **Risk**: The typed-stream-ID layer cannot prevent typos (`"plan-"` vs `"plan:"`) or kind mismatches (publish a plan event to a session stream) until callers are migrated. The branding is still ineffective — the strings flow as raw `string` everywhere.
- **Recommendation**: Sweep PR migrating the 36 sites. Concrete steps: (a) replace each `\`plan:${id}\`` with `planStreamId(id)`; (b) tighten `DurableStreamsService.publish(streamId: StreamId, ...)` to require the branded union; (c) at the route boundary where raw strings come in (e.g. `/api/sessions/:id/stream`), validate with `assertStreamIdKind` before passing on. Estimated 2–3 hours mechanical, plus type-error fan-out resolution.

### F12-06: Project/codespace naming has not migrated at the API boundary
- **Priority**: P1
- **Size**: L
- **Observation**: CLAUDE.md states "always use `codespace`/`codespaceId` in code, API params, routes, and tests — never `project`/`projectId`". Live counterexamples in production code:
  - **API routes**: `/api/project-folders` (`src/server/router.ts:422,516`, `src/server/routes/project-folders.ts:43,65,90,107,127,144,167`); the file declares `createProjectFoldersRoutes`, `ProjectFoldersDeps`, `createProjectFolderSchema`, `updateProjectFolderSchema`, `projectFolderService`.
  - **Routes**: `src/server/routes/project-members.ts` exists alongside the new `codespace-members` table — the file imports `codespaceMembers` from the new schema *but* the route is mounted at `/api/codespaces/:id/members` (good) yet keeps the file/symbol naming `Project*` (bad): `addProjectMemberSchema`, `updateProjectMemberSchema`, `addProjectMemberSchema` still in `src/server/validation.ts:161,167`, parsed at `src/server/routes/project-members.ts:13,32,154`.
  - **User-visible string**: `src/server/routes/templates.ts:71` returns `error.message: 'scope must be "org" or "project"'` — but the actual accepted enum at line 18 is `'org' | 'codespace'`. The error message lies to the API consumer.
  - **Internal config**: `src/lib/config/config-service.ts:17-22,56-64` — `loadCodespaceConfigFrom({ projectPath })` and `loadCodespaceConfig({ projectPath })` still take a `projectPath` argument and assign it to a local `projectConfigPath`. Pure post-rename leftover — function name says "Codespace" but parameter says "project".
  - **DB schema**: `src/db/schema/sqlite/project-folders.ts`, `team-project-folders.ts` (and PG mirrors) — the `project-folders` standalone naming is ambiguous: is a "project folder" a folder on disk, or a folder of codespaces? Without a rename there's no way to tell.
- **Risk**: Two coexisting names for the same entity is the canonical source of API client/server mismatches. CLAUDE.md states the rule but the code isn't holding it. New code added near these symbols will pattern-match the wrong name; OpenAPI/Hono route announcements expose `/api/project-folders` to users who learn the wrong vocabulary.
- **Recommendation**: Three-step rename (one PR, mechanical):
  1. Rename `addProjectMemberSchema` → `addCodespaceMemberSchema` and `updateProjectMemberSchema` → `updateCodespaceMemberSchema` in `src/server/validation.ts:161,167`. Update the 3 import sites.
  2. Rename `src/server/routes/project-members.ts` → `codespace-members.ts`; update symbols `addProjectMember*` → `addCodespaceMember*`, function `createProjectMembersRoutes` → `createCodespaceMembersRoutes`.
  3. Fix `src/server/routes/templates.ts:71` error message to match the actual enum (`'org' or 'codespace'`).
  4. Rename `loadCodespaceConfigFrom`/`loadCodespaceConfig` parameter `projectPath` → `codespacePath` (`src/lib/config/config-service.ts:17-22,56-64`). Same line count, no behaviour change.
  5. Defer "project-folders" rename — it's a deliberate distinct concept (organisational folder of codespaces), but document this in CLAUDE.md so the next reviewer doesn't flag it again. Or rename to `codespace-folders` — the public API path matters here.

### F12-07: Three setInterval owners still outside `BackgroundJob`
- **Priority**: P2
- **Size**: M
- **Observation**: `BackgroundJob` adoption is real but partial. The 3 adopters: `EventCleanupService`, `SchedulerService`, `EventOutboxRelayService`. The remaining timer owners that the April 20 review flagged still run in legacy mode:
  - `src/server/routes/auth.ts:391` — 1-hour `cleanupTimer = setInterval(...)` for expired session purge. Relies on `unref()` only; not registered with the registry; not exposed to tests.
  - `src/services/container-agent/agentcore-bridge.service.ts:306` — per-task `setTimeout` for `maxRuntimeMs`. Now does have `clearTimeout` cleanup at lines 473 and 494, so the leak risk is gone — but it's still per-task, not registry-tracked, and the `unref()` swallows test-time deterministic shutdown.
  - `src/services/task-creation.service.ts:214` — `setInterval` for session cleanup; `destroy()` exists at line 262; bootstrap calls `services.taskCreationService.destroy()` at `src/server/bootstrap/server-bootstrap.ts:193`. Safe but ad-hoc — should implement `BackgroundJob` to share the registry's per-job error isolation.
  - `src/services/cli-monitor/cli-monitor.service.ts:500,526` — `heartbeatTimer` and `maintenanceTimer` (every 15s); `destroy()` at line 329; not on the interface.
  - `src/services/memory/dream-scheduler.service.ts:120` — tick loop; same shape as `SchedulerService` but not yet on the interface.
  - `src/services/agent/agent-execution.service.ts:1595` — `orphanSweepTimer`; explicit `stopOrphanSweep()` at line 1603, hooked into shutdown at `server-bootstrap.ts:221-222`. Safe but ad-hoc.
- **Risk**: A failing `stop()` in any of these unhooked services strands sibling timers — the explicit `BackgroundJobRegistry.stopAll()` catches per-job errors and continues; the ad-hoc shutdown in `server-bootstrap.ts` does not (any `await ... .destroy()` that throws aborts the rest of the LIFO chain).
- **Recommendation**: Migrate `TaskCreationService`, `CliMonitorService`, `DreamSchedulerService`, `AgentExecutionService.orphanSweep`, and the `auth.ts` cleanup to implement `BackgroundJob`. Each rename `destroy()` → `stop()`, add a `start()` if missing, move into the registry. Estimated 90 minutes total. The agentcore per-task timer is a different beast (per-instance, not lifecycle) — leave it but consider an "aggregate" job that drains all in-flight timeouts on shutdown.

### F12-08: 5 `Result` import path variants produce import noise and dead-symbol risk
- **Priority**: P3
- **Size**: S
- **Observation**: Across `src/`, the canonical `Result` module is `src/lib/utils/result.ts`. But import strings fragment 9 ways (count-grouped):
  - 45 `import type { Result } from '../lib/utils/result.js';`
  - 34 `import type { Result } from '../../lib/utils/result.js';`
  - 30 `import { err, ok } from '../utils/result.js';`
  - 21 `import { err, ok } from '../../utils/result.js';`
  - 5 `from '@/lib/utils/result';` (no `.js`)
  - 4 `from '../../../lib/utils/result.js';`
  - 2 `from '../lib/utils/result';` (no `.js`)
  - 1 `from '../result.js';` (relative-2)
  Inconsistent extension (some `.js`, some not), inconsistent base (`../utils/`, `../lib/utils/`, `@/lib/utils/`). 84 import sites total, 9 distinct strings.
- **Risk**: When a refactor moves a file (worktree promotion, agent-runner extraction), some import strings break and others don't because the relative depth changes inconsistently. ESM-style import resolution + node16 mode also distinguishes `.js`-suffix imports from extension-less ones — depending on `tsconfig.json`'s `moduleResolution`, mixing the two can compile-pass in dev but fail in prod build.
- **Recommendation**: Pick one form (recommend `'@/lib/utils/result.js'` with `.js` for ESM correctness) and do a one-shot sed across `src/`. Add a Biome `noRestrictedImports` rule limiting `result` imports to the `@/` form.

### F12-09: 41 inline env-var reads, no typed precedence layer (F12-07 from April 20 not actioned)
- **Priority**: P2
- **Size**: L
- **Observation**: April 20's F12-07 recommended introducing `AppConfig` keyed by config name. Status: `src/lib/env.ts` has been there since before, and exports a single flag (`e2eSeed`). 41 distinct `process.env.*` symbols are read inline across `src/`:
  ```
  AGENTCORE_ENABLED, AGENTPANE_MAX_TURNS, AGENT_MAX_RUNTIME_MS, ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, APP_URL, CADDY_STREAMS_URL,
  CLAUDE_OAUTH_TOKEN, CORS_ORIGIN, DATABASE_URL, DB_MODE, DB_PATH,
  ENCRYPTION_KEY_PATH, GITHUB_APP_ID, GITHUB_CALLBACK_URL, GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET, GITHUB_PRIVATE_KEY, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET,
  HOME, LOG_LEVEL, NODE_ENV, PORT, SANDBOX_DEFAULT_NETWORK_MODE,
  SANDBOX_INIT_TIMEOUT_MS, SCHEDULER_CONCURRENCY_LIMIT, SCHEDULER_ENABLED,
  SCHEDULER_TICK_INTERVAL_MS, ...
  ```
  `src/services/settings.service.ts:32` does the right thing for `AGENT_MAX_RUNTIME_MS` (env > DB > default 4hr). `src/services/scheduler.service.ts:64` uses `Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 30_000` — env-or-default but no DB layer. 14 `settingsService.get*()` call sites and 41 `process.env.` reads do not share a precedence convention.
- **Risk**: An admin sets `agent.maxRuntimeMs` in the UI, restarts; if `AGENT_MAX_RUNTIME_MS` is set in the launcher env, the UI value silently loses (correct per code, but invisible to the user). The opposite assumption is just as likely. Tests can't easily mock — `vi.stubEnv` works but `settingsService.get` requires a DB.
- **Recommendation**: As April 20 recommended, introduce `src/lib/config/app-config.ts` exporting a typed `AppConfig` map: `{ key: 'agent.maxRuntimeMs', envVar: 'AGENT_MAX_RUNTIME_MS', settingsKey: 'agent.maxRuntimeMs', default: 4 * 60 * 60 * 1000, schema: z.number().min(60_000) }`. One `AppConfig.get(name, db)` call site replaces both env+settings lookups, applies the schema, and returns a typed value. Migrate 5–10 hot keys first (`SCHEDULER_TICK_INTERVAL_MS`, `AGENT_MAX_RUNTIME_MS`, `SANDBOX_INIT_TIMEOUT_MS`, `LOG_LEVEL`, `PORT`); leave the rest until next touch.

### F12-10: 28+ inline timing magic numbers — no `timing.ts` constants module
- **Priority**: P3
- **Size**: M
- **Observation**: April 20's F12-09 suggested `src/lib/constants/timing.ts`. Status: `src/lib/constants/` contains `models.ts`, `node-colors.ts`, `sandbox.ts`, `tools.ts` — no `timing.ts`. Inline literals representing milliseconds:
  - `src/services/scheduler.service.ts:64` — `30_000` tick fallback
  - `src/services/scheduler.service.ts:105` — `30_000` deadline
  - `src/services/git.service.ts:75-76` — `FETCH_THROTTLE_MS = 30_000`, `PATH_CACHE_TTL_MS = 60_000`
  - `src/services/cli-monitor/cli-monitor.service.ts:504` — `15_000` heartbeat
  - `src/services/agent/agent-retry-queue.ts:47-50` — `30_000` initial backoff, `300_000` max, `10_000` poll
  - `src/services/durable-streams.service.ts:529` — `PUBLISH_LAG_WINDOW_MS = 30_000`
  - `src/services/memory/skill-tracking.service.ts:425`, `memory-store.service.ts:97` — `30 * 24 * 60 * 60 * 1000` (30-day half-life) computed twice in two files
  - `src/server/routes/team-invitations.ts:82`, `auth.ts:17`, `rbac-tokens.ts:194,410` — `7 * 24 * 60 * 60 * 1000`, `30 * 24 * 60 * 60`, etc., inline.
  - `src/server/routes/cli-monitor.ts:480` — SSE ping `15s` inline
  - `src/server/routes/task-creation.ts:406` — SSE ping `5s` inline
  - `src/server/routes/events.ts:1175` — SSE ping `30s` inline
  Three different SSE ping intervals across three routes is the symptom — they should be one constant.
- **Risk**: Drift between frontend poll interval and backend expiry (when one is updated and the other isn't). Three SSE ping intervals already exist with no obvious reason for them to differ.
- **Recommendation**: Add `src/lib/constants/timing.ts` exporting at minimum:
  ```ts
  export const SECOND_MS = 1_000;
  export const MINUTE_MS = 60 * SECOND_MS;
  export const HOUR_MS = 60 * MINUTE_MS;
  export const DAY_MS = 24 * HOUR_MS;
  export const SSE_PING_INTERVAL_MS = 15 * SECOND_MS;
  export const SCHEDULER_TICK_DEFAULT_MS = 30 * SECOND_MS;
  export const AGENT_MAX_RUNTIME_DEFAULT_MS = 4 * HOUR_MS;
  export const SKILL_HALF_LIFE_MS = 30 * DAY_MS;
  // ...
  ```
  Migrate the ~28 inline literals. No behaviour change. Removes `30 * 24 * 60 * 60 * 1000` from being typed by hand.

### F12-11: Empty-body throws in `session-stream.service.ts` are still genuine
- **Priority**: P2
- **Size**: S
- **Observation**: April 20's F12-05 ("services never throw") status is *much* better — most service-layer throws have been removed. But `src/services/session/session-stream.service.ts:480,484` retains:
  ```ts
  if (!metadataResult.ok) {
    throw new Error(metadataResult.error.message);
  }
  if (metadataResult.value.streamId !== sessionId) {
    throw new Error(
      `Realtime session event '${type}' targets stream '${metadataResult.value.streamId}' but was published to '${sessionId}'.`
    );
  }
  ```
  This is `publishRealtimeOnly()`, called from `ChunkBatcher`. The contract throws an `Error` (not an `AppError`) which loses the original `metadataResult.error.code`. Same pattern at `src/services/terraform-compose.service.ts:212` (`throw new Error(result.error.message)`).
- **Risk**: A real failure (mismatched stream ID — the exact bug pattern flagged in the F12-08 documentation) loses the typed error code on the way up. Caller sees a generic 500 rather than `STREAM_ID_MISMATCH`.
- **Recommendation**: Change the signature of `publishRealtimeOnly` to `Promise<Result<number, AppError>>`. Caller `ChunkBatcher` is internal and easy to update. Same for `terraform-compose.service.ts:212`. Estimated 30 minutes per site.

### F12-12: Two `sleep`/`delay` utilities — no canonical "wait n ms" helper
- **Priority**: P3
- **Size**: XS
- **Observation**: Two functional duplicates:
  - `src/index.ts:25` — `export async function delay(ms: number): Promise<void>`
  - `src/lib/terraform/registry-client.ts:79` — `function sleep(ms: number): Promise<void>` (file-private)
  Plus 13 additional inline `await new Promise((resolve) => setTimeout(resolve, ms))` constructions across `src/server/bootstrap/sandbox/k8s-init.ts:67`, `src/server/bootstrap/sandbox/heal-intervals.ts:111`, `src/server/routes/github.ts:86`, `src/server/routes/sandbox.ts:309`, `src/server/routes/sandbox-k8s.ts:85`, `src/lib/terraform/registry-client.ts:80`, `src/lib/github/rate-limit.ts:91`, `src/services/task-creation.service.ts:288`, `src/services/scheduler.service.ts:107`, `src/services/event-outbox-relay.service.ts:89`, `src/services/container-agent/container-exec.service.ts:101,531`. None call `delay()` or `sleep()`.
- **Risk**: Tiny — but `withRetry()` from `src/lib/utils/retry.ts` has a tested backoff that none of these use, so the *real* duplication is "we keep reinventing retry/backoff loops." This finding is the entry point for that conversation.
- **Recommendation**: Add `export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));` to `src/lib/utils/sleep.ts`. Migrate the 15 sites. Then on the next pass: replace polling-with-sleep loops (`src/services/container-agent/container-exec.service.ts:101`) with `withRetry({ retries, baseDelayMs })`.

### F12-13: AgentCore's per-task `setTimeout` clears on cleanup paths but not on every error path
- **Priority**: P2
- **Size**: S
- **Observation**: `src/services/container-agent/agentcore-bridge.service.ts:306` sets `runningAgent.timeoutHandle = setTimeout(() => stopAgentCoreAgent(runningAgent), maxRuntimeMs)` per task. April 20 noted this could leak. Verified: `clearTimeout(agent.timeoutHandle)` is called at lines 473 (in `stopAgentCoreAgent`'s `finally` block) and 494 (in `cleanupAgentCoreRunState`). Both are in cleanup paths, so the common case is fine. But the timer is registered before the bridge's `instance.start()` call; if `start()` throws synchronously *before* `runningAgent` is added to `state.setRunningAgentCoreAgent`, the timer is set but the entry isn't tracked, so subsequent `stop()` calls won't find it.
- **Risk**: A failing AgentCore start under retry pressure could leave a 4-hour timer that fires against a stale closure. Each occurrence costs ~80 bytes; not a memory crisis, but the timer firing a `void this.stopAgentCoreAgent(runningAgent)` against a no-longer-tracked agent could log spurious errors.
- **Recommendation**: Move the `setTimeout` registration *after* `setRunningAgentCoreAgent`. If creation fails, the timer doesn't exist, the cleanup doesn't need to find it. Two-line move; trivially testable with a spy on `setTimeout` and a thrown `instance.start()`.

### F12-14: `: any` and `as any` are concentrated in 3 explainable places — but `(proxiedCallbacks as any)[key] = (event: any)` is genuine
- **Priority**: P3
- **Size**: XS
- **Observation**: `: any` count is just **4** in `src/`, 3 of which are documented exceptions:
  - `src/lib/db/use-collection-query.ts:16,20` — TanStack DB v0.5.29 type regression with biome-ignore comments.
  - `src/lib/config/validate-secrets.ts:6` — comment context only ("any key not in allowlist").
  - `src/services/agent/__tests__/agent-execution.service.test.ts:41` — mock helper.
  - `src/app/hooks/use-session-subscription.ts:90` — `(proxiedCallbacks as any)[key] = (event: any) => {...}` for a generic callback proxy. The biome-ignore says "generic callback proxy" — the code is iterating `keys` and assigning `(cb as any)(event)` at line 94. This is a real unsafe-cast that loses event-type information.
  - `as any` count: **123** total but **105 are in `src/app/routeTree.gen.ts`** (autogenerated by TanStack Router and headed `// @ts-nocheck`). Real `as any` outside autogen is ~18.
- **Risk**: Low. The genuine concern is `use-session-subscription.ts:90,94` — a wrong-type event callback is a silent runtime bug.
- **Recommendation**: Refine `proxiedCallbacks` to a discriminated union: `Record<EventKey, (event: EventForKey<EventKey>) => void>`. The biome-ignores can stay if paired with a structural type instead of `any`. Smaller fix: even `Record<string, (event: unknown) => void>` is strictly better than `any`-on-key + `any`-on-event.

## Cross-references with other April 29 themes

- F05 (event streaming) — F12-05 (stream-id factory adoption) is a hard prerequisite for type-safe event publishing.
- F06 (security) — F12-02 (`ALLOW_ALL_TOOLS` collision) is a security adjacency. Two sentinel definitions for the same gating decision is exactly the kind of subtle drift that re-opens F06-06.
- F11 (operations) — F12-07 (`BackgroundJob` adoption) directly affects shutdown reliability.
- F09 (testing) — F12-04 (`@ts-nocheck` on memory tests) caps the value of memory subsystem test coverage at "shape passes."

## Counts (April 20 → April 29 delta)

| Metric | April 20 | April 29 | Change |
|---|---|---|---|
| `as unknown as` (total) | 60 | 75 | +15 |
| `as unknown as` (prod, non-test) | 29 | ~60 | +31 (mostly state-machine sentinels in `lib/state-machines/*/machine.ts`) |
| `: any` annotations | "a number" | 4 | meaningfully ↓ |
| `as any` (excluding autogen) | not counted | ~18 | — |
| `@ts-ignore`/`@ts-expect-error` (prod) | 0 (rule on) | 0 | unchanged |
| `@ts-nocheck` (prod tests) | 5 | 5 | unchanged |
| Throws in services | ~9 | 8 | ↓1 (most of those left are validation guards) |
| `biome-ignore` (total) | 37 | 37 | unchanged |
| `biome-ignore` in `router.ts` | 9 | 8 | ↓1 (one was removed but the underlying `useRoleGuard` rename was not) |
| Service-layer TODOs (prod) | not counted | 3 (marketplace.service:400, sessions/collections:138, agentcore-sandbox-instance:197) | low |
| Background job adopters | 0 | 3 | ↑3 (EventCleanup, Scheduler, EventOutboxRelay) |
| Stream-id concat sites | "81 createId" | 36 prefixed concat | infra exists, adoption pending |
| Result import string variants | not counted | 9 | high fragmentation |

## Disposition

P1 items (act this cycle): F12-01 (dead-but-divergent schemas), F12-02 (`ALLOW_ALL_TOOLS` duplicate), F12-06 (project/codespace API surface).
P2 items (next cycle, batch with related themes): F12-04 (memory `@ts-nocheck`), F12-05 (stream-id factory adoption), F12-07 (`BackgroundJob` migration), F12-09 (`AppConfig` precedence), F12-11 (`session-stream` throws), F12-13 (agentcore timer order).
P3 items (opportunistic, on next-touch): F12-03 (`useRoleGuard` rename), F12-08 (`Result` import paths), F12-10 (`timing.ts` constants), F12-12 (`sleep` utility consolidation), F12-14 (callback proxy typing).
