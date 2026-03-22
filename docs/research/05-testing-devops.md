# Testing, CI/CD, Deployment, Monitoring & Security Scanning Research

**Date:** March 2026
**Current Stack:** Vitest 4.0.16 | Playwright 1.58.1 | agent-browser 0.7.6 | GitHub Actions (3-shard) | Docker | gitleaks | bun pm audit

---

## 1. Vitest Improvements

### Current Setup

Vitest 4.0.16 with `projects` config (3 projects: unit, jsdom, db). V8 coverage at 50% thresholds. `forks` pool for DB tests. 65+ test files.

### Vitest 4.x Features Worth Adopting

- **Browser Mode (Stable):** Replaces jsdom with real Chromium/Firefox/WebKit via `@vitest/browser-playwright`. More accurate DOM testing for React Flow, dnd-kit, Radix UI
- **Visual Regression Testing:** Built-in `toMatchScreenshot()` for catching unintended UI changes
- **Playwright Traces:** First-class trace generation for debugging flaky tests

### Comparison

| Criteria | Vitest 4.x | Jest 30 | Bun Test |
|---|---|---|---|
| ESM Support | Native | Experimental | Native |
| Browser Mode | Stable, real browsers | None | None |
| Speed (async) | 15x faster than Bun for async tests | Comparable | Slower |
| Test Isolation | Excellent (threads/forks) | Excellent | Weak — side effects leak |

### Recommendation

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Vitest 4.x** | **ADOPT (stay)** | Right choice. Add browser mode and visual regression |
| **Jest 30** | **HOLD** | ESM still experimental, no browser mode |
| **Bun Test** | **HOLD** | Async performance worse, test isolation issues |

### Sharding

3 shards is reasonable for 65+ files. Measure actual execution times — if any shard takes >2x the fastest, consider 4. The `db` project (forks pool) is likely the slowest.

---

## 2. E2E Testing

### Current Setup

Playwright 1.58.1 with custom helpers (goto, click, fill, drag, screenshot). Tests cover smoke, Kanban, agent sessions, navigation, settings.

### For AgentPane's Specific Needs (SSE/drag-drop/streaming)

- **SSE Testing:** Playwright's `page.route()` intercepts SSE endpoints. Cypress cannot natively intercept SSE
- **Drag-and-Drop:** Playwright's native `dragAndDrop()` works with dnd-kit. Cypress requires unreliable plugins
- **Agent Streams:** Playwright listens to network frames with timestamps

### Recommendation

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Playwright** | **ADOPT (stay)** | Best for SSE, drag-drop, and real-time UIs |
| **Cypress 14** | **HOLD** | Single-browser limitation, weak SSE testing |

### Visual Regression

| Tool | Free Tier | Recommendation |
|------|-----------|---------------|
| **Vitest 4 built-in** | Unlimited | **TRIAL** (zero cost, no external dependency) |
| **Percy** | 5K screenshots/mo | ASSESS |
| **Chromatic** | 5K snapshots/mo | ASSESS |
| **Argos** | Open source | **ASSESS** (lower cost alternative if needed) |

---

## 3. Agent/AI Testing

### Recommended Testing Strategy

**Layer 1 — Deterministic Unit Tests (current, expand):**
Mock Claude Agent SDK at session level. Expand to cover:

- Plan mode exit with `launchSwarm: true/false`
- Tool call sequences (file edits, bash commands)
- Event emission ordering
- Error paths (turn limits, API failures, credential issues)

**Layer 2 — Promptfoo for Prompt Regression:**
Test compose system prompt and agent planning prompts for expected outputs. Red-team for injection vulnerabilities.

**Layer 3 — Braintrust for Production Evaluation (future):**
LLM-as-judge on production traces when real user traffic exists.

### Recommendation

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Promptfoo** | **TRIAL** | Low-effort GitHub Action. Start with Terraform compose prompts. Red teaming valuable for agent platform |
| **Braintrust** | **ASSESS** | Evaluate when production traffic justifies it |
| **DIY mocking** | **ADOPT (expand)** | Current factory pattern is solid. Add agent execution flow factories |

---

## 4. CI/CD Pipeline Optimization

### Current Pipeline

GitHub Actions: `install` -> parallel (`build`, `lint-and-typecheck`, `test[1/3, 2/3, 3/3]`). `actions/cache@v5` for `node_modules`. Bun 1.3.10.

### Platform Comparison

| Platform | Recommendation | Rationale |
|---|---|---|
| **GitHub Actions** | **ADOPT (stay)** | For current scale (<10 min CI), optimal. Pipeline well-structured |
| **Buildkite** | **HOLD** | Only if CI costs exceed $200/month or self-hosted runners needed |
| **Dagger** | **ASSESS** | "Write CI in TypeScript" appealing but young ecosystem |
| **Earthly** | **DEAD** | Shut down July 2025 |

### Quick CI Wins (no new tools)

1. Parallelize lint and typecheck (currently sequential in one job)
2. Use `actions/cache/restore` + `actions/cache/save` separately
3. Add `--reporter=verbose` to test shards
4. Cache Vite build output with source file hash key

### Build Caching

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Turborepo** | **ASSESS** | Only if monorepo grows beyond 4+ packages |
| **GitHub Actions cache** | **ADOPT (improve)** | Better key strategies for 10-20% improvement |

---

## 5. Container Orchestration for Testing

### Testcontainers

Programmatic Docker container lifecycle in tests. TypeScript support. Pre-built modules.

**Relevant use cases for AgentPane:**

1. Agent sandbox integration tests — spin up actual `agent-sandbox` container
2. PostgreSQL mode testing — real Postgres instead of in-memory SQLite
3. Docker-in-Docker for container creation flow testing

### Recommendation

| Approach | Recommendation | Rationale |
|---|---|---|
| **Testcontainers** | **TRIAL** | Start with PostgreSQL integration tests via `@testcontainers/postgresql`. Validates dual-database mode |
| **Docker-in-Docker in CI** | **ASSESS** | Add separate CI job for container integration tests on PRs touching `docker/`, `agent-runner/`, container services |

---

## 6. Database Testing

### Current Setup

In-memory SQLite via better-sqlite3. Manual migration SQL execution (not Drizzle Kit). Monkey-patches `transaction()` for async. Factory functions for test data. `clearTestDatabase()` uses raw SQL batch for speed.

### Improvements

| Area | Recommendation | Rationale |
|------|---------------|-----------|
| **Drizzle pushSchema for tests** | **ADOPT** | Replace manual migration SQL with `pushSchema()` from `drizzle-kit/api`. Eliminates schema drift and fragile patching |
| **Migration sequence testing** | **TRIAL** | Add test that runs each migration in order. Catches ordering issues |
| **Schema snapshot testing** | **TRIAL** | Use `toMatchSnapshot()` on `drizzle-kit generate --dry-run` output |

---

## 7. Deployment Architecture

### Critical Constraint

AgentPane spawns Docker containers for agent sandboxes via Docker socket. This eliminates platforms without Docker socket access.

### Comparison

| Platform | Docker Socket | Recommendation | Rationale |
|---|---|---|---|
| **Coolify** | Yes | **TRIAL** | Best for self-hosted. Web UI, SSL/reverse proxy, multi-server. 50k+ GitHub stars. Free (self-hosted) |
| **Kamal** | Yes (SSH-based) | **ASSESS** | CLI-first alternative. Battle-tested at 37signals. No web dashboard |
| **Docker Compose** | Yes | Keep for dev | No scheduling, no auto-recovery |
| **Fly.io** | No | **HOLD** | No Docker socket |
| **Railway** | No | **HOLD** | No Docker socket |
| **SST** | No | **HOLD** | Serverless model incompatible |

---

## 8. Monitoring & Observability

### Current State

Structured logging implemented, health checks implemented, request ID middleware implemented. Metrics, distributed tracing, alerting all "Planned."

### Recommended Phased Approach

**Phase 1 (immediate):**

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Sentry** | **ADOPT** | Error tracking + performance monitoring + session replay. 30-minute SDK install. Free tier: 5K errors/month |
| **UptimeRobot** | **ADOPT** | External health check for `/api/health`. Free tier: 50 monitors |

**Phase 2 (when scaling):**

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Prometheus + Grafana** | **TRIAL** | Custom agent execution metrics (turns/task, planning duration, tool call frequency, container startup time). Add `/metrics` endpoint |
| **Grafana Loki** | **TRIAL** | Centralize logs from main app and agent containers |

**Phase 3 (when distributed):**

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **OpenTelemetry** | **ASSESS** | Wait until architecture spans multiple services/nodes |

---

## 9. Security Scanning

### Current Setup

gitleaks v8.22.1, detect-private-key, `bun pm audit` (non-blocking), check-added-large-files (500KB).

### Recommended Additions

| Tool | Recommendation | Rationale |
|------|---------------|-----------|
| **Socket.dev** | **ADOPT** | Supply chain protection. Detects typosquatting, install scripts, obfuscated code. Free GitHub App. 40+ dependencies = high supply chain risk surface |
| **Semgrep / Opengrep** | **TRIAL** | SAST with custom rules for AgentPane patterns (raw SQL bypassing Drizzle, path traversal in sandbox, shell injection). Run in CI |
| **CodeQL** | **TRIAL** | Free for GitHub repos. Add as nightly CI job. Deeper semantic vulnerabilities |
| **Snyk** | **ASSESS** | Comprehensive but overlaps with Socket.dev + Semgrep. 200 tests/month free tier may be insufficient |
| **Make `bun pm audit` blocking** | **ADOPT** | Change `continue-on-error: true` to fail on critical/high vulnerabilities |

---

## Priority Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | **Adopt Sentry** | Low (30 min) | Error tracking + performance monitoring |
| 2 | **Adopt Socket.dev** | Low (GitHub App) | Supply chain security |
| 3 | **Vitest Browser Mode** | Low | Replace jsdom with real browser testing |
| 4 | **Drizzle pushSchema for tests** | Low | Eliminate fragile manual migration SQL |
| 5 | **Trial Promptfoo** | Low | AI prompt regression testing |
| 6 | **Trial Semgrep/Opengrep** | Low | SAST with custom rules |
| 7 | **Trial Coolify** | Low | Self-hosted deployment platform |
| 8 | **Make bun pm audit blocking** | Minimal | Catch critical vulnerabilities |
