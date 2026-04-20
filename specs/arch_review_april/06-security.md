# 06 — Security

Theme scope: injection surfaces (shell, YAML, SQL, path, CRLF), authentication & OAuth flow, RBAC enforcement parity, token storage & rotation, secret handling, CORS/CSP, supply chain (Dependabot), sandbox escape, tenant isolation.

This review consolidates status against the prior assessment in `specs/release_plan/02-security-hardening.md` (3 critical + 5 high) and adds new findings. The security foundation is demonstrably stronger than the code of three months ago — path validation helpers, array-form `Bun.spawn` for git clone, AES-256-GCM at rest for API keys, `CapDrop: ['ALL']` + `no-new-privileges` on Docker containers, cookie hashing (SHA-256) for session tokens, OAuth CSRF state cookie, token ceiling on API tokens, and a dedicated `enrichAuthContext` + `requireRole` middleware pair have all landed. The remaining risk is weighted toward supply-chain, multi-tenant rate limiting, policy drift (CSP, tenant isolation in shared sandbox), and a small set of shell surfaces that still interpolate. Sixteen findings follow.

---

## Consolidated status — prior findings in `02-security-hardening.md`

| Prior ID | Title | Prior P | Status now |
|---|---|---|---|
| C1 | Docker `CapDrop` / `SecurityOpt` | CRITICAL | **Resolved** — `docker-provider.ts:570-574` drops `ALL`, re-adds minimal caps, sets `no-new-privileges`. |
| C2 | Path traversal in GitHub clone destination | CRITICAL | **Resolved** — `isValidClonePath()` applied in `github.ts:127` + `create-from-template`. |
| C3 | Shell interpolation in `codespace.service.cloneRepository` | CRITICAL | **Partially resolved** — input validation rejects shell-breaking chars and `..`, but the `mkdir -p "${resolved}"` / `git clone "${url}" "${targetPath}"` pattern remains in the runner path. See F06-03. |
| C4 | Hardcoded CORS origin in SSE headers | HIGH | **Resolved** — `shared.ts` reads `CORS_ORIGIN`. |
| H1 | No expired session cleanup / revoke-all | HIGH | **Resolved** — hourly purge + `POST /api/auth/revoke-all`. |
| H2 | XFF spoofing in rate limiter | HIGH | **Resolved** — `TRUSTED_PROXIES` + right-to-left walk added. |
| H3 | Audit hook empty catch | HIGH | **Resolved** — `log.error()` added. |
| H4 | In-memory rate limiting bypassed by restart / multi-instance | HIGH | **Still live** — see F06-07. |
| H5 | Empty tool whitelist allows all | HIGH | **Still live** — see F06-06. |
| H6 | `Secure` cookie only in NODE_ENV=production | MEDIUM-HIGH | **Still live** — see F06-13. |

---

## F06-01 — P0 — Dependabot: 42 open advisories (2 critical, 17 high)

Current inventory from GitHub security alerts: 2 critical, 17 high, 22 moderate, 1 low. For an application that handles OAuth tokens, executes untrusted agent code in shared containers, and ingests arbitrary markdown/YAML, carrying two critical advisories into any production push is not acceptable.

Direction: treat the alert list as a release blocker. Triage in this order — (a) criticals and highs on server-side packages (Hono, octokit, drizzle, better-sqlite3, dockerode, @kubernetes/client-node, react-markdown), (b) transitive advisories against dev-only tooling that run inside CI (vite, playwright) where supply-chain exposure is still real because CI has write access to the registry, (c) browser-side (react, @xyflow, @radix-ui). Wire `npm audit --audit-level=high` into the CI `lint-and-typecheck` job as a non-blocking comment first, then promote to blocking once criticals are clear. Add a weekly Dependabot auto-merge for patch-level advisories on pinned internal packages.

Cross-ref: F07-* (release), F12-* (supply chain cross-cutting).

## F06-02 — P0 — Shell interpolation in `createBunCommandRunner`

`src/server/bootstrap/service-container.ts:62` shells out via `Bun.spawn(['sh', '-c', command])` where `command` is a pre-composed string. This is the host-process `CommandRunner` that `WorktreeService`, `GitService`, and `CodespaceService.cloneRepository` consume when not routed through a sandbox. The runner has no `validateShellCommand()` guard on this path; validation lives in the sandbox runner only (`agent-sandbox-provider.ts`). Every caller that composes a command string — including `git clone "${url}"` in `codespace.service.ts:528`, `mkdir -p "${resolved}"` on :527, and every `git worktree` / `git fetch` that does string interpolation — inherits this surface.

Even with the C3 input validation landed, any future caller that forgets to pre-validate will silently inherit shell-injection potential. The CLAUDE.md "Key patterns found in reviews" section calls this out explicitly (positional args with `--`, never string interpolation).

Direction: convert `CommandRunner.exec` to take `(argv: string[], cwd)` and delete the `sh -c` shim. Migrate callers one at a time; any remaining string-command path goes through a single `validateShellCommand()` helper with a failure mode that throws, not logs. Track the migration as a semgrep rule that forbids `sh -c` spawns outside a specific allowlist.

## F06-03 — P0 — YAML injection via skill/agent metadata → SKILL.md frontmatter

`src/lib/sandbox/skill-injector.ts:42-48` escapes `"`, `\`, `\n`, `\r` for values written inside YAML double-quoted strings, which handles the main double-quoted attack vector. However: the `tags` field at line 132 writes `tags: ${skill.tags.join(', ')}` with zero escaping — a tag containing `\n` or `#` or `:` or `` ` `` breaks the frontmatter and can inject arbitrary YAML keys (e.g. `pre_tool_use: bash -c "..."` if the Claude runner reads hook config from frontmatter, which it does via the Claude Agent SDK). The `source` and `executionSkill` fields are written unquoted / partially quoted respectively. Skill/template content originates from marketplaces, which per the release plan are explicitly "untrusted" ingestion paths.

Direction: emit frontmatter through a real YAML serializer (`yaml` package) rather than string concatenation. Validate every tag against `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` at ingestion (same regex used for skill IDs) and reject on mismatch. Add a test that feeds a hostile tag containing `\n---\nhooks:` and asserts the materialized file still parses as a single frontmatter block.

---

## F06-04 — P1 — Plan content → GitHub issue body is neither escaped nor sanitized

`src/lib/github/issue-creator.ts:47-54` passes the plan `body` straight to `octokit.rest.issues.create`. The body originates from LLM output in `extractIssueContent()` at :169 (last assistant message) and `formatConversationSummary()` at :202 which interpolates raw session values (`session.id`, `session.taskId`, `turn.interaction.answers`) with no escaping. GitHub renders markdown, and `@mention`, `#<number>`, and `Fixes #<id>` are all action-triggering tokens. A hostile plan can post back-references, auto-close unrelated issues via `closes #N`, or post mentions that spam notifications. `labels` defaults to `['plan', 'agent-generated']` but is concatenated with `input.labels ?? []` at `:102` with no validation — a label named `"evil,urgent"` would round-trip as one label but looks like two in the UI.

Direction: when building the issue body, strip / escape `closes #`, `fixes #`, `resolves #` keywords (prepend with zero-width space or wrap in a code fence), escape `@` mentions, and reject labels that don't match a safe regex. Add a test harness fixture that feeds a hostile plan text and asserts the resulting body contains only inert markdown.

## F06-05 — P1 — Dev-mode bypass depends on env-var alignment across two layers

`rbac-middleware.ts:62` rejects `auth.authMethod === 'dev'` when `NODE_ENV !== 'development'`, which is a correct defense-in-depth. But the production gate upstream relies on `server-config.ts` aborting when `SKIP_AUTH=true` in production, and on the auth middleware never tagging a request as `dev` unless both conditions are met. Any future refactor that introduces a third auth mode or renames `NODE_ENV` (e.g. `APP_ENV` in k8s) re-opens the hole.

Direction: introduce a single `isDevAuthAllowed()` helper that hard-codes the gate and is consumed by (a) bootstrap, (b) auth middleware, (c) rbac middleware. Add a functional test that boots with `SKIP_AUTH=true NODE_ENV=production` and asserts the server fails to start. Audit for any code path that sets `auth.authMethod='dev'` without going through the helper.

## F06-06 — P1 — Default-allow tool whitelist when `allowedTools` is empty

Restated from prior H5 and still live. `tool-whitelist.ts:8-9` treats empty array as "allow all" — a failure-open default. The blast radius is the Claude Agent SDK tool surface (Bash, Write, Edit, WebFetch), which in a container with any credentials mounted is effectively arbitrary code execution against the host-visible filesystem.

Direction: require an explicit `allowedTools: ['*']` sentinel for open access and make empty-array a hard deny. Sweep callers to verify none rely on the old semantics. This is a 1-hour change blocked only by the caller sweep.

## F06-07 — P1 — In-memory rate limiter: bypassable by restart + multi-instance drift

Restated from prior H4. Currently a single-process `Map` holds counters. Under any rolling restart, counters reset; under multi-instance deployment (which the release plan envisages), each replica has independent counters, so effective limits are `limit × N`. For a multi-tenant install, the per-IP key is also insufficient — every tenant shares the same IP space behind the same Caddy, so a single abusive tenant can exhaust the per-IP budget for everyone else on that address.

Direction: move to a shared store (Redis/Valkey). Scope the key to `(tenantId|userId|tokenId, endpoint-class, window)` with per-IP as a secondary envelope. Distinguish unauthenticated limits (IP-only) from authenticated limits (user/token-keyed). Keep the in-memory path as a fallback when `REDIS_URL` is not set, but log loudly at boot.

## F06-08 — P1 — Tenant isolation in shared sandbox mode

With `sandbox.mode = Shared Container` (the default per CLAUDE.md), a single Docker container services every codespace. All `/workspace` bind mounts land inside the same filesystem namespace, and the agent-runner executes with a single OAuth credential file (`~/.claude/.credentials.json`). There is no per-tenant uid mapping, no per-tenant seccomp profile, no mount namespace split. A hostile codespace writing to `/workspace/../.claude/.credentials.json` reads every other tenant's OAuth token.

Direction: treat "Shared Container" as single-tenant-only and gate it on a `MULTI_TENANT=false` flag. For multi-tenant deployments, force per-codespace container + per-codespace credentials file scoped to a chroot/namespaced mount. K8s provider should use per-pod ServiceAccount with a scoped secret mount. Add a startup self-check that refuses to boot a shared container when more than one team exists in the database.

## F06-09 — P1 — API keys and GitHub OAuth tokens: no rotation, no expiry

`api-key.service.ts` handles save/get/delete/markInvalid but has no `rotateKey`, no `expiresAt` field, no scheduled rotation job. Same for `github-token.service.ts` — decrypted tokens live indefinitely once stored, and the refresh logic (if any — grep shows none) is not exercised. For the GitHub OAuth App path, tokens are not short-lived user tokens, so this is an accepted but undocumented posture; for the GitHub **App** path (installation tokens, `github-app.service.ts:399`), tokens are short-lived and refreshed correctly. Clarity should be in the model.

Direction: add `expiresAt` and `rotatedAt` columns, default Anthropic API keys to a 90-day rotation reminder (banner, not hard expiry), and emit a `key:rotation_due` event into the same event subsystem used for task lifecycle. For installation tokens, document the 1-hour TTL and confirm the cache honours it (a cursory read of `getInstallationToken` suggests yes, but write a test).

## F06-10 — P1 — CSP blocks required external resources; likely unused in production

`src/server/router.ts:110` CSP allows only `'self'` + `data:` for images and `'self'` for connect. The UI loads GitHub avatars (`avatars.githubusercontent.com`), fetches from Anthropic/GitHub APIs via the backend (fine) but also opens EventSource connections to `/api/sessions/:id/stream` (same-origin so OK), and, via Shiki, dynamically imports WASM/JSON grammars at runtime. Production CSP will either break the UI on first load or be silently disabled by the reverse proxy — both outcomes undermine the control.

Direction: run the app once with `CSP-Report-Only` for a week, collect violations, then tune. Add `img-src 'self' data: https://avatars.githubusercontent.com;`, `script-src 'self' 'wasm-unsafe-eval';` (Shiki needs WASM eval), `connect-src 'self' https://api.github.com;`. Add a Playwright test that loads the dashboard in a production build and asserts zero CSP violations in the console.

## F06-11 — P1 — Markdown rendering trusts Shiki's HTML but the input path is agent-controlled

`markdown-content.tsx:82` and `terraform-right-panel.tsx:242` both use `dangerouslySetInnerHTML` with Shiki-produced HTML. The biome-ignore comment says "shiki escapes code input and returns safe HTML" — correct for current Shiki versions, but the input code comes from LLM-generated or user-pasted content and the surrounding markdown renderer (`react-markdown`) escapes HTML tags by default. The risk window is a Shiki regression or a grammar-specific escape gap. Given both files contain the same pattern with the same comment, a single Shiki CVE affects both panels.

Direction: route all Shiki output through a single `<HighlightedCode html={...} />` wrapper that additionally runs DOMPurify on the HTML string before injecting. Keep the wrapper in one file so a future upgrade / CVE response is one edit. Add a regression test that feeds `<script>alert(1)</script>` into the code block and asserts the DOM has no `<script>` node.

## F06-12 — P2 — RBAC enforcement parity: six route modules miss `useRoleGuard`

`router.ts` applies `useRoleGuard`/`requireRole` to most routes but notably not to: `/api/me`, `/api/invitations`, `/api/auth`, `/api/teams/*` (intentional — handler-level RBAC per AR-008/AR-009), `/api/sandbox-configs` child resource paths if any land post-review, and the `/api/codespaces/:id/members`, `/api/tokens`, `/api/tags`, `/api/codespaces/:id/tags`, `/api/tasks/:id/tags` routes which rely on handler-level checks. The pattern "handler-level RBAC" is risky because any future handler added without reading the AGENTS.md note inherits zero authz. The middleware-level guard enforces by default; handler-level requires opt-in.

Direction: for `tags`, `rbac-tokens`, `codespace-members` — wrap their create factories with a `withHandlerRbac()` higher-order helper that throws at route registration time if the handler does not call `requireTeamRole()` / `requireMemberRole()` before any DB access. Add a test that iterates every registered `app.route` and asserts either a middleware guard or a handler-level marker exists. Document the split in `specs/application/security/` and cross-link from the route AGENTS.md.

## F06-13 — P2 — Session cookie `Secure` flag keyed on NODE_ENV, not protocol

Restated from prior H6. `auth.ts:196` sets `Secure` only when `NODE_ENV === 'production'`. A staging deployment with HTTPS and `NODE_ENV=staging` (or any non-production label) sends session cookies over TLS without the `Secure` flag, which is harmless in practice but fails security scanners and leaves the door open if TLS termination ever bypasses Caddy. The `oauth_state` cookie at `:50` is already `Secure` unconditionally — inconsistent.

Direction: derive `secure` from `c.req.url.startsWith('https://')` rather than env. Keep an override env for local HTTP-to-HTTPS testing. Apply the same logic to the post-logout clear-cookies at `:236`, `:252`, `:276`, `:295`.

## F06-14 — P2 — Plan/sandbox/terraform stream IDs cross boundaries without origin checks

The durable-streams table has no FK on `sessionId` (documented in CLAUDE.md), and the stream-ID prefixing convention (`plan:`, `sandbox:`, `terraform:`) is enforced by convention only. A caller who passes a bare CUID expecting a session subscribes to a different tenant's session because the stream server has no tenant scoping. The SSE endpoint `/api/sessions/:id/stream` enforces tag-based RBAC via `requireTagAccess`, but plan and sandbox streams (subscribed via `/v1/stream?streamId=...` direct to Caddy) bypass the API server entirely.

Direction: sign stream IDs with an HMAC keyed per tenant, include the tenant in the key, and require the HMAC on every stream subscribe. Alternatively, move all stream access through the API server so RBAC runs on the subscribe handshake — Caddy can still do the persistence, but subscription auth lives in the app.

## F06-15 — P2 — Request body size is bounded only by Bun defaults

Hono has no explicit body-size middleware. Large multipart or JSON payloads on `/api/tasks` or webhook routes can burn memory. Bun's default is generous (~100MB). For an auth-gated API this is a minor risk; for `/hooks/events/*` which is unauthenticated, it is a DoS vector even with the 60/min rate limiter because one request is enough to OOM.

Direction: add a 1MB limit on public webhook routes (`/hooks/*`) and a 10MB limit on authenticated routes, with a 50MB opt-in for `/api/memory/*` if large embeddings round-trip. Configure via env with conservative defaults.

## F06-16 — P3 — Env vars injected into sandbox containers are visible in `ps auxe`

`docker-provider.ts:562` writes `Env: [...config.env]` which includes any credential strings the service passes through. On Linux, a privileged process inside the namespace can read `/proc/<pid>/environ`. In the Shared Container mode, the container already violates per-tenant isolation so this is moot; in Per-Project mode, the container is single-tenant and the risk is limited to an attacker already inside the container, which is the threat the sandbox exists to contain.

Direction: for secret-shaped env vars (`*_TOKEN`, `*_KEY`, `ANTHROPIC_*`), write them to a `tmpfs`-mounted file at `/run/secrets/<name>` and point the runner at the file via a non-secret `*_FILE` env var. The Claude Agent SDK already prefers `~/.claude/.credentials.json` (per CLAUDE.md) — extend the same pattern to every secret. Drop secret env vars entirely from the container spec.

---

## Cross-references

- Prior security assessment: `specs/release_plan/02-security-hardening.md` — consolidated status table above.
- Dependabot inventory: F06-01 is a blocker for the release plan in `specs/release_plan/04-release-deployment.md`.
- Multi-tenant posture (F06-07, F06-08, F06-12): informs `specs/arch_review_april/07-performance-scalability.md` and `12-cross-cutting.md`.
- Supply-chain and CSP (F06-10, F06-01): informs `08-frontend-readiness.md`.
- Durable-stream auth (F06-14): informs `05-events-streaming.md` and `03-agent-execution.md`.

---

**Summary:** 3 P0, 8 P1, 4 P2, 1 P3 across 16 findings.
