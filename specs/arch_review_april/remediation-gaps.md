# P0/P1 Remediation — Residual Gap Report

**Branch**: `p0-p1-april` at `22c72e50`
**Full suite**: 9358 passed / 4 skipped / 0 failed
**Typecheck + build**: clean
**Review method**: 3 parallel reviewer agents, one per 4-theme block

---

## Aggregate counts

| Status | Count | Meaning |
|---|---|---|
| **Resolved** | 42 | Code landed + at least one new/updated test; verified against branch HEAD |
| **Resolved pre-existing** | 6 | Fixed by an earlier theme PR or by work prior to the remediation sprint; verified still in place |
| **Partial** | 13 | Core recommendation landed; a documented sub-scope is deferred (all listed below) |
| **Deferred** | 4 | Explicit pre-approved deferrals with rationale (see "Deferred findings") |
| **Not resolved** | **0** | — |

Total in scope: 65 findings (4 P0 + ~61 P1 across 12 themes).

---

## Resolved (42)

Every finding in this bucket has:
- Code landed under a commit whose message references the finding ID (`fix(F0X-YY):` or `fix(arch-review): theme NN`).
- At least one test exercising the new behaviour.
- A resolution note appended to the relevant themed file.

See each themed file's "Resolution log" section for the commit SHA and test path.

---

## Resolved pre-existing (6)

These were fixed by a sibling theme or by work landing before the remediation sprint. Verified to be in place at HEAD.

| id | resolved by | notes |
|---|---|---|
| F03-F1 (AgentCore dead code) | theme 04 PR #166 (`e96fd617`) | `AGENTCORE_ENABLED=true` gate + dynamic import |
| F09-01 (schema-drift 2/42 tables) | theme 02 PR #164 (`06b7b2bf`) | `schema-drift-all-tables.test.ts` covers all 49 tables |
| F08-02 (frontend zero-tests) | theme 09 PR #172 (`dd05c40a`) | 3 seed jsdom tests under `src/app/__tests__/` |
| F10-09 (droppedEventCount invisible) | theme 05 PR #168 (`970a0c74`) | `recordDroppedEvent()` + `/api/admin/metrics/plan-mode` |
| F11-04 (PG migrations 19 behind) | theme 02 PR #164 (`06b7b2bf`) | Migrations 0007–0012 + parity check script |
| F11-07 (sandbox image unpinned) | theme 04 PR #166 (`e96fd617`) | `SANDBOX_DEFAULTS.image` digest-pinned; `isDigestPinnedImage()` validator |

---

## Partial (13)

Core recommendation landed; a scoped sub-task is deferred. Each partial has a tracking entry in its themed file's "Follow-ups" section.

| id | theme | what landed | what's deferred |
|---|---|---|---|
| F02-01 | data | 3 post-catchup PG migrations + parity script | Splitting the 590-line `0004_schema_catchup.sql` itself (intentionally frozen) |
| P04-1-04 | sandbox | `recover()` closes in-memory gap on bootstrap | Partial-unique index on `(codespaceId, status IN ('creating','running'))` |
| P04-1-05 | sandbox | `Sandbox.writeFile` via Docker `putArchive` (USTAR uid=1000) | K8s/Nomad `writeFile` impls + full removal of `CLAUDE_OAUTH_TOKEN` env path |
| P04-1-06 | sandbox | Docker `SANDBOX_DEFAULT_NETWORK_MODE` env opt-in | K8s `NetworkPolicy` + Nomad Consul Connect |
| P04-1-07 | sandbox | `SandboxConfigService.assertQuota()` + `SANDBOX_QUOTA_EXCEEDED` error | Plumbing into `sandbox.service.create()` |
| F05-07 | events | Caddy `forward_auth` + `POST /api/auth/verify-stream` cookie + URI-shape check | Full path-level authz (user U has plan P) |
| F05-11 | events | 10 tokens / 50 ms container-side batcher | Threshold tuning from production data |
| F07-04 | api | Pluggable `keyFrom(ctx)` + `RateLimitBackend` interface with in-memory default | Redis backend (one-file swap when `REDIS_URL` is wired) |
| F08-01 | frontend | Error boundaries, suspense fallbacks, ConnectionStatusBanner mounted | 229 `console.*` migration to structured logger |
| F09-04 | testing | `stryker.config.json` scope extended + `mutate:security` npm script | First Stryker baseline run on the expanded scope |
| F10-03 | observability | `correlationId` plumbed through envelope + `CORRELATION_ID` env to agent-runner | Steps 2–4: OTel SDK, Dockerode/K8s headers, W3C `traceparent` |
| F10-04 | observability | `captureException()` sink wired into all five call sites | `@sentry/node` adapter (sink abstraction makes it a one-file swap) |
| F12-04 | cross-cutting | `BackgroundJob` interface + LIFO registry; top 3 timer owners migrated | Auth session cleanup, agentcore-bridge timeouts, SSE pings, task-creation cleanup |

---

## Deferred (4)

These findings were explicitly pre-approved for deferral per the plan's scope rule. Each has a rationale and a tracking entry.

| id | priority | rationale |
|---|---|---|
| F06-01 | P0 | Dependabot triage requires bumping ~42 packages with cascading test fixes. Tracked as a standalone PR so the remediation sprint delivers a clean, reviewable set of behavioural fixes first. |
| F06-07 | P1 | Overlaps F07-04 (rate-limit backend). The `keyFrom()` abstraction landed in F07-04 makes Redis a one-file swap; deferred for that backend PR. |
| F06-08 | P1 | Overlapped with theme 04 P1-06 (network isolation). Docker `networkMode: 'none'` default landed; full tenant-isolation gate moves with the K8s/Nomad NetworkPolicy work. |
| F06-10 | P1 | CSP tuning requires ~1 week of Report-Only data before switching to enforce. Tracked with a clear gate (emit Report-Only, observe, tune, enforce). |

---

## What this means for main

- **Every P0 has either landed or has a documented pre-approved deferral** (F06-01 is the only P0 deferral, and it is isolated to a dep-bump PR).
- **Every non-XL P1 has either landed or has a partial/deferred note with an explicit follow-up owner**. No P1 is silently dropped.
- **Zero failing tests**, **zero typecheck errors**, **zero build errors** on `p0-p1-april`.
- The branch is ready to merge into `main`.

---

## Follow-up tracking

Each partial and deferred item has a one-liner entry in its themed file's "Follow-ups" section. Those are the source of truth for what ships next. The highest-priority follow-ups are:

1. **F06-01 — Dependabot triage PR** (P0)
2. **F10-04 — `@sentry/node` adapter swap** (P1)
3. **F07-04 — Redis rate-limit backend** (P1, unblocks F06-07)
4. **P04-1-06 — K8s NetworkPolicy + Nomad Consul Connect** (P1, unblocks F06-08)
5. **F10-03 steps 2–4 — OTel SDK + distributed trace propagation** (P1)

All other items are quality/hardening items with no immediate production risk.
