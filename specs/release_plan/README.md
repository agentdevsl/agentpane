# AgentPane Production Release Plan

## Executive Summary

8 parallel OPUS agent reviews assessed the codebase across security, testing, observability, deployment, error handling, database integrity, performance, and frontend readiness. The application has a **solid foundation** -- the test suite is fully green (7,328 tests passing), authentication/RBAC is well-designed, the CI pipeline is comprehensive, and the core agent execution architecture is functional. However, **10 priority items** must be addressed before production.

---

## Top 10 Priorities

### Priority 1: Fix Critical Security Vulnerabilities
**Risk:** HIGH | **Effort:** 2-3 days | **Report:** [02-security-hardening.md](02-security-hardening.md)

Three critical vulnerabilities must be fixed:

| Issue | File | Fix |
|-------|------|-----|
| Docker containers created without `CapDrop`/`SecurityOpt` -- agents retain all default Linux capabilities | `src/lib/sandbox/providers/docker-provider.ts:532-548` | Add `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges:true']` to HostConfig |
| Path traversal in GitHub clone -- `body.destination` validated only as `z.string().min(1)` | `src/server/routes/github.ts:124-128` | Validate destination against allowed paths, reject `..` traversal |
| Shell injection in codespace clone -- user-controlled URL/path interpolated into shell commands | `src/services/codespace.service.ts:518-529` | Use array-based command execution, validate inputs |

**Additional high-priority security:**
- IP spoofing bypass in rate limiter via `X-Forwarded-For` manipulation
- Audit hook silently drops all DB write failures (empty catch)
- Empty tool whitelist defaults to allowing all tools
- No expired session cleanup (unbounded table growth)

---

### Priority 2: Fix Silent Error Swallowing
**Risk:** HIGH | **Effort:** 3-4 days | **Reports:** [03-observability.md](03-observability.md), [05-error-resilience.md](05-error-resilience.md)

**50+ silent catch blocks** across the codebase swallow errors with no logging, creating invisible failure modes in production. Key locations:

- 27 empty `catch {}` blocks across 22 files
- 17 `.catch(() => {})` patterns
- `session-stream.service.ts`, `template-sync-scheduler.ts`, `docker-provider.ts` are worst offenders
- `validateTransition()` return value discarded in `agent-execution.service.ts:775` allowing invalid state transitions
- Worktree/session resources not cleaned up on failed agent start transaction (orphaned records)

**Fix approach:** Audit all catch blocks. Add structured logging with context. For fire-and-forget patterns, add `.catch(err => logger.error(...))`.

---

### Priority 3: Add Sensitive Data Masking to Logger
**Risk:** HIGH | **Effort:** 2 days | **Report:** [03-observability.md](03-observability.md)

The logger has **zero redaction capability**. Any `logger.info('data', { key: apiKey })` call leaks credentials to stdout/log aggregation. Only one manual `[REDACTED]` exists in the entire codebase (`container-exec.service.ts:137`).

**Fix:**
- Add field-level masking to `src/lib/logging/logger.ts` for known sensitive patterns (API keys, tokens, passwords, credentials)
- Mask `Authorization` headers, `ANTHROPIC_API_KEY`, `CLAUDE_OAUTH_TOKEN`, `GITHUB_PRIVATE_KEY` patterns
- Add masking to `serializeError()` which captures full stack traces with potential credential context
- ~200 lines of code

---

### Priority 4: Build CD Pipeline
**Risk:** MEDIUM-HIGH | **Effort:** 3-5 days | **Report:** [04-release-deployment.md](04-release-deployment.md)

CI is solid (lint, typecheck, test, build, semgrep, integration tests) but there is **no automated path from code to deployment**. Missing:

| Component | Status | Effort |
|-----------|--------|--------|
| Docker image build/push workflow | Missing | 1 day |
| Container image scanning (Trivy) | Missing | 0.5 days |
| Release versioning & tagging | Missing (stuck at 1.0.0) | 0.5 days |
| Deployment workflow (staging/prod) | Missing | 1-2 days |
| `.dockerignore` for build context | Missing | 0.5 hours |

**Additional deployment concerns:**
- Source code (`src/`) ships in production Docker image (Bun runs TS directly)
- `durable-streams-server` binary downloaded at build time without checksum verification
- Docker vs K8s architectural divergence (Helm chart bypasses Caddy)

---

### Priority 5: Fix PostgreSQL Migration Lag
**Risk:** MEDIUM-HIGH | **Effort:** 3-5 days | **Report:** [06-database-integrity.md](06-database-integrity.md)

PostgreSQL migrations are **19 versions behind SQLite**. The PG schema is missing:
- Codespace rename (still references `projects`)
- RBAC tables
- Event system tables
- Memory/Honcho tables
- Project folders
- 10+ other schema additions

A PostgreSQL deployment would crash immediately. The CI schema drift check only compares module file parity, not actual migration content.

**Fix:** Generate comprehensive PG migration catching up all SQLite changes. Add column-level schema drift detection to CI.

---

### Priority 6: Add SQLite `busy_timeout` Pragma
**Risk:** MEDIUM | **Effort:** 0.5 days | **Report:** [07-performance-scalability.md](07-performance-scalability.md)

SQLite will return `SQLITE_BUSY` immediately under concurrent agent writes (multiple agents working simultaneously). The `busy_timeout` pragma is not set, so any write contention causes instant failures instead of retrying.

**Fix:** Add `PRAGMA busy_timeout = 5000` (or similar) in the database bootstrap at `src/db/client.ts`. This is a one-line change with massive impact on concurrent agent stability.

---

### Priority 7: Add Error Boundaries to Key Frontend Views
**Risk:** MEDIUM | **Effort:** 2 days | **Report:** [08-frontend-readiness.md](08-frontend-readiness.md)

Only the root `__root.tsx` and 3 component-level error boundaries exist. Critical interactive views are unprotected:

| View | Risk if Crash | Current Protection |
|------|--------------|-------------------|
| Kanban board | Entire app crashes | None |
| Workflow designer (React Flow) | Entire app crashes | None |
| Session history/timeline | Entire app crashes | None |
| Terminal/code views | Entire app crashes | None |

**Fix:** Wrap each major view in a `<ErrorBoundary>` with a recovery UI. Also fix 4 `<Suspense fallback={null}>` locations that show no loading feedback.

---

### Priority 8: Reduce Frontend Bundle Size
**Risk:** MEDIUM | **Effort:** 1-2 days | **Report:** [08-frontend-readiness.md](08-frontend-readiness.md)

The production build is **484 JS chunks / ~14 MB** total. The biggest offender is CodeMirror language grammars -- hundreds of unused language packs are bundled:

| Grammar | Size | Needed? |
|---------|------|---------|
| emacs-lisp | 762 KB | No |
| cpp | 611 KB | No |
| php | 550 KB | No |
| python | 400 KB | Possibly |

**Fix:** Replace the full `@codemirror/lang-*` imports with dynamic imports for only the languages actually used (HCL, TypeScript, JSON, YAML, Markdown). Could cut 5-8 MB from the bundle.

---

### Priority 9: Add Basic Metrics & Alerting
**Risk:** MEDIUM | **Effort:** 3-5 days | **Report:** [03-observability.md](03-observability.md)

Production will be completely blind without metrics. Currently:
- No Prometheus/metrics endpoint
- No error rate tracking
- No latency histograms
- No alerting integration (Sentry, PagerDuty)
- 69 `console.*` calls in server-side code bypassing structured logger

**Minimum viable monitoring:**
1. Add `/metrics` endpoint with basic counters (requests, errors, agent starts/completions)
2. Add Sentry or equivalent for error reporting with stack traces
3. Replace 69 `console.*` calls with structured logger
4. Track agent execution duration, success/failure rates

---

### Priority 10: Add Release Versioning & Process
**Risk:** LOW-MEDIUM | **Effort:** 1-2 days | **Report:** [04-release-deployment.md](04-release-deployment.md)

No release process exists:
- `package.json` version stuck at `1.0.0`
- No git tags
- No CHANGELOG
- No rollback strategy documented
- No semantic versioning automation

**Fix:**
- Add `standard-version` or `semantic-release` for automated versioning
- Create CHANGELOG.md
- Tag releases in git
- Document rollback procedures (database migration rollback, image rollback)

---

## Summary Table

| # | Priority | Risk | Effort | Category |
|---|----------|------|--------|----------|
| 1 | Fix critical security vulnerabilities | HIGH | 2-3d | Security |
| 2 | Fix silent error swallowing (50+ catches) | HIGH | 3-4d | Resilience |
| 3 | Add sensitive data masking to logger | HIGH | 2d | Security/Compliance |
| 4 | Build CD pipeline | MED-HIGH | 3-5d | Operations |
| 5 | Fix PostgreSQL migration lag (19 versions behind) | MED-HIGH | 3-5d | Database |
| 6 | Add SQLite busy_timeout pragma | MED | 0.5d | Performance |
| 7 | Add error boundaries to key frontend views | MED | 2d | Frontend |
| 8 | Reduce frontend bundle size (~14 MB) | MED | 1-2d | Frontend |
| 9 | Add basic metrics & alerting | MED | 3-5d | Observability |
| 10 | Add release versioning & process | LOW-MED | 1-2d | Operations |

**Total estimated effort: 21-33 developer-days**

---

## What's Already in Good Shape

- **Test suite**: 7,328 tests passing, 0 failures, strong integration/functional coverage
- **CI pipeline**: Comprehensive with lint, typecheck, sharded tests, SAST, mutation testing
- **Authentication**: GitHub OAuth with SHA-256 hashed tokens, proper cookie security
- **RBAC**: 4-role hierarchy with token ceiling, tag scoping, codespace-level resolution
- **Error architecture**: Typed error catalog (23 modules), `Result<T, E>` pattern, invariant assertions
- **Graceful shutdown**: LIFO cleanup, signal handling, tini for PID 1
- **Health checks**: Liveness/readiness probes with component checks
- **Transaction safety**: 16 transaction sites covering critical multi-step operations
- **Input validation**: 68 Zod validation points across 21 route files
- **Agent execution**: Plan/execute flow, worktree isolation, streaming, team mode

---

## Detailed Reports

| Report | Focus |
|--------|-------|
| [01-test-suite-health.md](01-test-suite-health.md) | Test suite status, skipped tests, coverage gaps |
| [02-security-hardening.md](02-security-hardening.md) | Vulnerabilities, auth, RBAC, sandbox security |
| [03-observability.md](03-observability.md) | Logging, metrics, tracing, alerting gaps |
| [04-release-deployment.md](04-release-deployment.md) | CI/CD, Docker, Helm, release process |
| [05-error-resilience.md](05-error-resilience.md) | Error handling, retry logic, graceful degradation |
| [06-database-integrity.md](06-database-integrity.md) | Schema, migrations, transactions, backup |
| [07-performance-scalability.md](07-performance-scalability.md) | Memory, connections, scaling blockers |
| [08-frontend-readiness.md](08-frontend-readiness.md) | Error boundaries, bundle size, accessibility |
