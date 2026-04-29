# 06 — Security (April 29 Review)

Theme scope (re-confirmed against April 20 baseline): injection surfaces (shell, YAML, HTML, SQL, path, CRLF), authentication & OAuth flow, RBAC enforcement parity, token storage & rotation, secret handling, CORS/CSP, supply chain (Dependabot), sandbox escape, multi-tenant isolation, markdown rendering, GitHub issue body sanitization.

This review verifies the remediation in PRs #163, #176, #178, #179 against the prior April-20 finding set, then layers on **new** findings discovered while re-reading the post-fix code.

---

## Verification of April 20 fixes

Before listing new findings, confirm the prior remediation status. Each verification is grounded in `path:line`.

| Prior ID | Title | Verified status | Evidence |
|---|---|---|---|
| F06-02 | Shell interpolation in `createBunCommandRunner` | **Partially fixed** — `execArgs` added but `exec(sh -c)` retained as the default for legacy callers. See **F06-NEW-01** below for residual risk. | `src/server/bootstrap/service-container.ts:70-114`, `src/services/codespace.service.ts:600-632`, `src/services/worktree.service.ts:160-200` |
| F06-03 | YAML injection via skill frontmatter | **Fixed (with regression)** — `yaml` package now serialises frontmatter, hostile tags filtered through `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. See **F06-NEW-04** for the agent-runner regex parser bypass. | `src/lib/sandbox/skill-injector.ts:51-58`, `:142-175` |
| F06-04 | Plan body → GitHub issue not sanitised | **Fixed** — `sanitizeIssueBody` neutralises `closes/fixes/resolves #N` and `@mentions`; `sanitizeLabels` filters comma/control. | `src/lib/github/issue-creator.ts:24-71`, applied at `:119`, `:191`, `:224` |
| F06-05 | Dev-mode bypass two-layer drift | **Fixed** — single `isDevAuthAllowed()` helper consumed by bootstrap + auth + rbac middleware; bootstrap parity check at `server-config.ts:160-168`. | `src/lib/api/dev-auth.ts:33-46`, `src/server/bootstrap/server-config.ts:153-168`, `src/lib/api/rbac-middleware.ts:65-79` |
| F06-06 | Empty `allowedTools` fail-open | **Fixed** — `[]` now DENIES; `['*']` is the explicit open sentinel; `ALLOW_ALL_TOOLS = ['*']`. | `src/lib/agents/hooks/tool-whitelist.ts:8-51`, `src/lib/constants/tools.ts:32-35`, `src/services/container-agent/container-exec.service.ts:454-455` |
| F06-09 | Token rotation columns | **Fixed** — `rotated_at`/`expires_at` added to `api_tokens`, `api_keys`, `github_tokens` (SQLite migration `0017`, PG migration `0006`); `/api/tokens/rotation-due` endpoint live. | `src/db/migrations/0017_add_token_rotation_columns.sql:1-12`, `src/db/migrations-pg/0006_add_token_rotation_columns.sql:1-9`, `src/server/routes/rbac-tokens.ts:392-460` |
| F06-11 | Shiki HTML reaching DOM unsanitised | **Fixed** — shared `HighlightedCode` wrapper runs `DOMPurify.sanitize(html, {ALLOWED_TAGS:[pre,code,span,div], FORBID_ATTR:[onerror,onload,...]})` before injection. | `src/app/components/ui/highlighted-code.tsx:41-76` (consumed at `markdown-content.tsx:78-88`, `terraform-right-panel.tsx:239-247`) |
| F06-01 | Dependabot 42 advisories | **Reduced but not cleared** — current count (verified live via `gh api .../dependabot/alerts?state=open`): **3 critical, 4 high, 5 medium = 12 open**. Down from 42 on April 20 but still includes `protobufjs` (critical, RCE) and `aquasecurity/trivy-action` (critical, supply-chain). See **F06-NEW-12**. | `gh api repos/agentdevsl/agentpane/dependabot/alerts?state=open` (run 2026-04-29) |
| F06-07 | Rate limiter restart-bypassable | **Documented but not fixed** — backend pluggable; in-memory remains default with one-time warn at boot. Hard constraint says "no Redis" — see **F06-NEW-08** for an in-process strengthening. | `src/lib/api/rate-limiter.ts:12-18`, `:131-141`, `:163-185` |
| F06-08 | Tenant isolation in shared sandbox | **Not fixed** — `container-exec.service.ts:242` still defaults to shared sandbox; no `MULTI_TENANT` gate; credentials still injected to a single `~/.claude/.credentials.json`. See **F06-NEW-02**. | `src/services/container-agent/container-exec.service.ts:242`, `src/lib/sandbox/credentials-injector.ts:14-16` |
| F06-10 | CSP overly restrictive | **Not fixed (deferred)** — `router.ts:188` still emits `script-src 'self'` only; Shiki uses dynamic WASM that needs `'wasm-unsafe-eval'`; no avatar host allow-list. | `src/server/router.ts:184-191` |
| F06-13 | `Secure` cookie keyed on NODE_ENV | **Not fixed** — still `process.env.NODE_ENV === 'production'` at `auth.ts:196`; `oauth_state` cookie unconditionally `Secure` at `:50` (asymmetric). | `src/server/routes/auth.ts:194-199` |
| F06-14 | Stream IDs cross tenant boundaries unsigned | **Not fixed** — `assertStreamIdKind` validates *prefix kind* but stream-ID body is a bare CUID, no tenant signing, no HMAC. Direct subscribe to `/v1/stream/sessions/:id` bypasses API auth. | `src/lib/streams/stream-id.ts:38-100`, `src/server/routes/sessions.ts:439-440` |
| F06-15 | Body size unbounded | **Partially fixed** — `cli-monitor.ts:176` added a 5MB cap; main `/api/*`, `/hooks/*`, webhook routes have **no body limit**. See **F06-NEW-09**. | `src/server/router.ts:344-396`, `src/server/routes/cli-monitor.ts:176-208` |
| F06-16 | Secrets in `Env` argv | **Mitigated for credentials file**, **not fixed for env-var path** — `docker-provider.ts:339-357` writes `~/.claude/.credentials.json` via `putArchive` (good). But `docker-provider.ts:648` still emits `Env: [...config.env]`, and `container-exec.service.ts:798` still passes `CLAUDE_OAUTH_TOKEN` as an env var to the container. See **F06-NEW-05**. | `src/lib/sandbox/providers/docker-provider.ts:339-357`, `:648`; `src/services/container-agent/container-exec.service.ts:793-802` |

**Net April-20 status:** 7 of 16 prior findings are fully fixed; 5 are partially fixed; 4 remain unaddressed. The fix quality is high — the YAML serialiser, DOMPurify wrapper, and rotation columns are all clean implementations — but the most operationally consequential items (multi-tenant isolation, in-memory rate limiter, CSP, body limits, Dependabot critical advisories) still ship as-is.

---

## New findings — F06-NEW-01 through F06-NEW-15

Numbering continues from the April-20 set so cross-references in other themes remain stable. Findings prefixed `F06-NEW-` to distinguish new from previous.

---

## F06-NEW-01 — P0 — `CommandRunner.exec` `sh -c` path is still the default and several callers compose strings

**Size: M** · `src/server/bootstrap/service-container.ts:70-88`, `src/services/worktree.service.ts:368-372`, `:447`, `:525`, `:572-575`, `:651-655`

The April 20 review (F06-02) was marked Resolved, but verification shows the fix is *partial*. `createBunCommandRunner` still exposes `exec(command: string, cwd)` as the legacy `Bun.spawn(['sh', '-c', command])` path (`service-container.ts:73`) and **multiple production callers still compose shell strings** that interpolate user-influenced data:

- `worktree.service.ts:368-369` — `git worktree remove "${escapedPath}" ${forceFlag}` where `worktree.path` is shell-escaped only via `escapeShellString` (a custom escaper that replaces `\\`, `"`, `` ` ``, `$`, `\n` — but **does not escape `;` or `|` or `\\r`**).
- `worktree.service.ts:447` — `cp "${escapedSource}" "${escapedTarget}"` interpolates a path read from `codespace.config.envFile`. A team admin who can write codespace config can set `envFile: 'a.env"; rm -rf $HOME; #'` → escapeShellString lets `;` through.
- `worktree.service.ts:525` — `git commit -m "${escapedMessage}"` where `message` originates from agent code-completion text (LLM-controlled). The escaper drops `\n` to `\\n` (literal) but `escapeShellString` does **not** validate against `;`/`|`/`&&`/`||`/`\r`.
- `worktree.service.ts:651-655` — `git diff --numstat ${escapedBaseBranch}` — base branch comes from codespace config.
- `worktree.service.ts:499` — `runner.exec(sanitizedScript, worktree.path)` — the `initScript` codespace config field is **explicitly user-authored shell**, sanitised only for null bytes / control chars (`:489-492`). A team-admin compromise becomes RCE on the host runner. Documented as "Security relies on access control for codespace config modifications" at `:487-488` — this is acceptable only if `requireRole('admin')` enforces it; verify with a test that a `member` role cannot edit `initScript`.
- `codespace.service.ts:631` — fallback path `git clone "${url}" "${targetPath}"` runs only when `runner.execArgs` is unavailable. Production runners always supply `execArgs`, but tests and any future runner that omits it inherit the unsafe path. The branch should be deleted and `execArgs` made non-optional.

`validateShellCommand` (`worktree.service.ts:150-155`) blocks `; | ` `` ` `` `$( && || \n \r` but is **only invoked from `createSandboxCommandRunner`** at `:170`, not from `createBunCommandRunner`. The host-process Bun runner still accepts arbitrary strings into `sh -c`.

**Direction**: (a) make `execArgs` required on `CommandRunner`, delete the optional `execArgs?` from `worktree.service.ts:140` and `codespace.service.ts:108`; (b) thread every `worktree.service` `exec(...)` call through `execArgs` (`git worktree remove`, `git branch -D`, `cp`, `git commit -m`, `git diff --numstat`); (c) wrap the remaining string-form `exec` in `validateShellCommand` at the runner level so the legacy path can never accept a hostile string at all; (d) add a semgrep rule banning new `runner.exec` callers — only `runner.execArgs` permitted. The work is scoped to ~25 sites, all in `worktree.service.ts` and `codespace.service.ts`.

Cross-ref: F06-02 (April), CLAUDE.md "shell commands: positional args".

---

## F06-NEW-02 — P0 — Shared sandbox tenant isolation: still single-credential, still single-FS namespace

**Size: XL** · `src/services/container-agent/container-exec.service.ts:242`, `src/lib/sandbox/credentials-injector.ts:14-16`, `src/lib/sandbox/providers/docker-provider.ts:615-680`

The "Shared Container" sandbox mode is the **default** (`CLAUDE.md` line 322 confirms; setting key `sandbox.mode` defaults to `'shared'` at `src/app/routes/settings/sandbox/-sandbox-page.tsx:257`). In this mode every codespace shares one Docker container. Inside that container:

- **Single credentials file at a hard-coded path**: `getContainerCredentialsPath()` returns `${SANDBOX_DEFAULTS.userHome}/.claude/.credentials.json` (`credentials-injector.ts:14-16`) for all tenants. The Anthropic OAuth token is the same for every codespace's agent-runner.
- **Single bind mount of `/workspace`**: `docker-provider.ts:636` writes `${config.codespacePath}:/workspace:rw`. Every tenant agent has filesystem access to the same `/workspace`.
- **No per-tenant uid mapping, no seccomp split, no mount namespace partitioning**.
- A `member`-role user who can move a task into `in_progress` controls an agent that runs in the same container as every other tenant's agent. A hostile agent can read `/home/node/.claude/.credentials.json` and exfiltrate the global Anthropic token to a remote endpoint.

The April 20 finding noted this as P1; April 29 it remains unfixed and has propagated — `container-exec.service.ts:242` reads "Use shared sandbox mode by default (fastest path - no per-codespace container creation)" with no `MULTI_TENANT` gate. The hard-coded comment treats the unsafe path as the *fast path*.

**Direction (within constraints — no Redis, no external secret store)**:
1. Add a boolean setting `security.allowSharedSandbox` (admin-only). Default to `true` for **single-team installs** (detect via `SELECT count(*) FROM teams` at boot — refuse to start in shared mode if >1 team exists).
2. For multi-team installs, force per-codespace container with the codespace's own `~/.claude/.credentials.json` written via `putArchive` to a **codespace-scoped** uid (`User: '1000:1000'` via Docker `User` field, with the host bind mount chowned correspondingly). The infra is already in place — `docker-provider.ts` accepts `User` and the `node` user is `uid 1000`.
3. The startup self-check belongs in `bootstrap/phases/schema.ts` (post-migration, pre-routes) so a misconfigured deployment fails fast instead of leaking tokens.

Cross-ref: F06-08 (April).

---

## F06-NEW-03 — P0 — `escapeShellString` does NOT escape `;`, `|`, `&`, `\r`, `(`, `)`

**Size: S** · `src/services/worktree.service.ts:73-81`

Shell escape sequence at `:73-81`:

```
return str
  .replace(/\0/g, '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/`/g, '\\`')
  .replace(/\$/g, '\\$')
  .replace(/\n/g, '\\n');
```

This handles characters that break out of double-quoted strings, but the `\\n` replacement converts a real newline to a *literal* `\\n` (not the same as escaping it — bash `echo` would produce `\\n` rather than a newline). More critically, the function does not strip or escape:

- `;` — semicolon, statement separator
- `|` — pipe / boolean OR with `||`
- `&` — background / boolean AND with `&&`
- `\\r` — carriage return (CRLF injection in commit messages, branch names)
- `(` / `)` — subshell
- `>` / `<` — redirection
- `?` / `*` — globbing (rare risk inside double quotes, but `${var}` expansion still occurs)

Inside a double-quoted shell string, `;` and `|` are inert — but every caller that uses `escapeShellString` then **interpolates the result outside the quotes**, e.g. `git worktree remove "${escapedPath}" ${forceFlag}` (`:368`). The `${forceFlag}` is unquoted, and a future addition that interpolates an unquoted `escapeShellString` value would leak immediately. Even inside quotes, `$variable` would be expanded if the source data contains a literal `$` — the function escapes `$` *but only* if not already preceded by a backslash; given the regex order (escape `\\` first, then `$`), the existing input `\\$` becomes `\\\\$` → unescape to `\$` (literal). That works for the existing use pattern; the bigger problem is **escape coverage gaps**.

**Direction**: Replace `escapeShellString` with a one-line helper that calls `validateShellCommand` then `JSON.stringify(value).slice(1, -1)` — the JSON escape covers all bash-meaningful chars including `\\r`, `\\b`, control chars. Better still, eliminate the function entirely by routing every call site through `runner.execArgs` (which is the F06-NEW-01 fix; this finding is the reason that fix can't be deferred).

Cross-ref: F06-NEW-01.

---

## F06-NEW-04 — P1 — Agent-runner YAML frontmatter parsed by hand-rolled regex, can be tricked by injected fields

**Size: M** · `agent-runner/src/index.ts:80-115`

The host-side fix (F06-03) emits SKILL.md / agent.md frontmatter through the `yaml` package. But **inside the container**, the agent-runner re-parses it with hand-rolled regex (`agent-runner/src/index.ts:80-115`):

```
const match = content.match(/^---\\n([\\s\\S]*?)\\n---\\n?([\\s\\S]*)/);
const name = unquote(frontmatter.match(/^name:\\s*(.+)$/m)?.[1]?.trim());
const description = unquote(frontmatter.match(/^description:\\s*(.+)$/m)?.[1]?.trim());
const toolsMatch = frontmatter.match(/^tools:\\n((?:\\s+-\\s+.+\\n?)*)/m);
```

The `unquote` helper just strips outer quotes (`v?.replace(/^['"]|['"]$/g, '')`), so a description value like `"foo\\nname: legitimate-agent"` would split on newline, and the *second* `name:` line would shadow the first via `[m]` flag matching. More serious: a legitimate skill author can write a multi-line description (they pass through the host's `yaml` serialiser as a YAML block scalar with leading `>-` or `|`), and the host emits valid YAML, but the regex parser **does not understand block scalars** — it captures only the first line and throws away the rest, but that first line could be `|` or `>-` itself.

Worse: a hostile **skill marketplace** can publish skills whose `name` contains `\\nallowed-tools:\\n  - Bash` (the `yaml` host serialiser will quote it correctly, but the regex `unquote` strips the quotes and re-interprets the literal `\\n`). The agent-runner then registers a subagent named `legitimate` with `tools: ['Bash', 'Edit']` even though the marketplace skill never declared those tools.

**Direction**: replace the regex parser at `agent-runner/src/index.ts:80-115` with `yaml.parse()` from the `yaml` package. The package is already a runtime dep of the host code; add it to `agent-runner/package.json` (run `cd agent-runner && bun install`). Then assert against a Zod schema before exposing the agent definition to the SDK. Tests must include a hostile description with embedded `\\n` and verify the parser rejects (or normalises) it.

Cross-ref: F06-03 (April).

---

## F06-NEW-05 — P1 — OAuth token still passed as container env var, visible in `/proc/<pid>/environ`

**Size: M** · `src/services/container-agent/container-exec.service.ts:793-802`, `src/lib/sandbox/providers/docker-provider.ts:648`

The April 20 finding (F06-16) noted env-var token leakage to `ps auxe`. The host code now correctly writes the credentials file via `putArchive` (out-of-band), **but it also still passes `CLAUDE_OAUTH_TOKEN` as an env var**:

```
const execResult = await sandbox.execStream({
  cmd: 'node',
  args: ['/opt/agent-runner/dist/index.js'],
  env: {
    ...env,
    CLAUDE_OAUTH_TOKEN: oauthToken,    //  <-- still env var
    AGENT_PROMPT: prompt,
  },
  cwd: worktreePath,
});
```

`agent-runner/src/index.ts:291` reads it back: `oauthToken: process.env.CLAUDE_OAUTH_TOKEN`. So the token lives in two places: the credentials file (good) **and** the env var (bad). A second tenant's agent inside the same container can read `/proc/<pid>/environ` of the first tenant's `node` process and recover the token directly.

The fix is one line: drop `CLAUDE_OAUTH_TOKEN` from the env at `container-exec.service.ts:798` and have the agent-runner **only** read from `~/.claude/.credentials.json`. The agent-runner already does this via `writeCredentialsFile` (`agent-runner/src/index.ts:427-475`), but only after `validateConfig` has already required the env var (`:387`). Reorder so the credentials file (injected by the host before exec) is the canonical source; the env var becomes a fallback for local dev only.

**Direction**:
1. Stop emitting `CLAUDE_OAUTH_TOKEN` from `prepareContainerExec` and `execStream`. Verify by `docker exec <container> cat /proc/<pid>/environ | strings | grep -i sk-ant` returns nothing.
2. Make the agent-runner read `~/.claude/.credentials.json` first (it already does at `:427-475`), and only fall back to `CLAUDE_OAUTH_TOKEN` env var when the file is absent (local dev path).
3. Same treatment for `CLAUDE_OAUTH_REFRESH_TOKEN` and `CLAUDE_OAUTH_EXPIRES_AT` — write a richer credentials file from the host instead of three env vars.

Cross-ref: F06-16 (April), F06-NEW-02 (shared sandbox makes this critical).

---

## F06-NEW-06 — P1 — `validateShellCommand` is bypassable via `\\t` and Unicode line separators

**Size: S** · `src/services/worktree.service.ts:150-155`

`validateShellCommand` blocks `; | ` `` ` `` `$( && || \\n \\r`. But bash respects:

- `\\t` (tab) is a token separator inside double-quoted strings — combined with command substitution `$(...)` it can be split, but the `$(` token is already blocked.
- Unicode line separators `U+2028` / `U+2029` — bash 5+ does *not* treat these as separators, but **node `child_process.exec` and `Bun.spawn(['sh','-c', x])` pass them through to the shell unchanged**. `dash` (Alpine default) treats them as ordinary chars, but a future container migration to `bash` (which is ANSI-C-quote aware) would re-open the gap.
- `\\v` (vertical tab) is a separator in some shells.
- Backslash-escaped variants: `;` is blocked but `\\;` is not — and bash interprets `\\;` as `;`.

Most critically, the regex `/[;|`]|\\$\\(|&&|\\|\\||[\\n\\r]/` treats `;` and `|` as **single-char** matches — but `;;` is two semicolons (which is a *valid* shell statement separator inside `case`). The block triggers on the first `;`; that's fine. However, the regex does not block standalone `&` — only `&&`. A backgrounded malicious command via `cmd1 & cmd2` slips through.

**Direction**: Tighten the regex to `/[;|&` `` ` `` `]|\\$\\(|\\$\\{|>>|<<|\\\\\\n|[\\n\\r\\t\\v\\u2028\\u2029]/`. Add a positive-list check for `[a-zA-Z0-9 _\\-./="@]` only when the command is *not* an `execArgs` payload. This finding's primary mitigation is still F06-NEW-01 (route everything through `execArgs`); validation is defence-in-depth.

Cross-ref: F06-NEW-01, F06-NEW-03.

---

## F06-NEW-07 — P1 — RBAC tag-access skipped on collection endpoints; tag-restricted tokens see all tags via list APIs

**Size: M** · `src/lib/api/rbac-middleware.ts:498-510`, `src/server/router.ts:405`

`requireTagAccess` (`rbac-middleware.ts:451`) enforces tag scope **only when a `:id` route param is present** (`:498-510`). For collection endpoints — `GET /api/codespaces` (no `:id`), `GET /api/tasks?codespaceId=X`, `GET /api/sessions` — the middleware returns 403 with message "Tag-restricted tokens must specify a resource ID". Two issues:

1. The 403-on-collection design means a tag-restricted token cannot list any resources at all. Any UI built on top of a tag-restricted token must already know the resource IDs it wants — which defeats the *list and select* workflow that tag scoping was meant to enable. The intent was probably to **filter the list** to only tagged resources, not refuse the list outright.
2. **Inconsistent**: `requireTagAccess` is registered globally at `router.ts:405`, but routes like `/api/codespaces/:id/tags`, `/api/tasks/:id/tags` have their own RBAC inside the handler factory (`createProjectTagRoutes`, `createTaskTagRoutes` at `router.ts:642-643`) and re-fetch tags directly from the DB. A tag-restricted token can call `GET /api/codespaces/:id/tags` for a codespace it does *not* have tag access to — the route's handler-level RBAC checks `requireTeamRole`, not the token's tag scope.

**Direction**:
1. For collection endpoints, replace the 403 with an in-handler filter: `WHERE id IN (SELECT taskId FROM task_tags WHERE tagId IN (...scopeTags))`. Add a helper `applyTokenTagFilter(query, auth)` and call it in every list route.
2. Audit the `:id` paths under `/api/codespaces/:id/...` and `/api/tasks/:id/...` for any handler that bypasses `requireTagAccess` because the middleware ran before the param sub-route was matched. Add a route-level test that a tag-restricted token cannot read tags it isn't scoped to.

Cross-ref: F06-12 (April).

---

## F06-NEW-08 — P1 — In-process rate limiter has no graceful-shutdown checkpoint; multi-instance design now blocked by no-Redis constraint

**Size: M** · `src/lib/api/rate-limiter.ts:147-185`

The April 20 finding (F06-07) called for Redis. The new constraint forbids Redis. Two consequences:

1. **Restart bypass remains.** The `Map`-backed counters reset every time the process restarts. A Bun rolling restart (e.g. on deploy) effectively grants every limited client a fresh quota. With the in-memory backend, rate-limited brute force against `/api/auth/github/callback` (no rate limit applied — `router.ts:200-202` excludes `/api/auth/*` from auth middleware *and* therefore from the `/api/*` rate limiter at `:398`) is bounded only by GitHub's OAuth code-exchange endpoint.
2. **Multi-instance drift remains.** Documented at `:131-141` as a one-time warn at boot. Acceptable for single-instance deployments.

Within the no-Redis constraint, the strengthening that's still possible:
- **Persist counters to SQLite** every 5s (with `expires_at` TTL). On restart, reload from SQLite; counters survive the restart.
- **Add a per-IP global limiter on auth endpoints** (`router.ts:200-202` exempts `/api/auth/*` from auth middleware *but the rate limiter is on `/api/*` not `/api/auth/*`*). Wrap `/api/auth/github/callback` with a 10/min/IP limiter using the existing in-memory backend.
- **Unauthenticated webhook routes** (`/hooks/events/*`, `/hooks/github-app`) are limited at 60/min/IP (`router.ts:343, 387`). For an authenticated user-keyed limit, this is fine; for the public webhook surface, 60/min is generous given how cheap a webhook can be — drop to 30/min and add a 100KB body cap (see F06-NEW-09).

**Direction**: SQLite-backed rate-limit store as a `RateLimitBackend` implementation. The schema is one table with `(key, count, reset_at)` and a 60s cleanup. Implementation is ~80 lines. The fact that SQLite is the existing data store means we satisfy the no-Redis constraint while still surviving restarts.

Cross-ref: F06-07 (April).

---

## F06-NEW-09 — P1 — `/api/*` and `/hooks/*` accept unbounded request bodies

**Size: S** · `src/server/router.ts:344-396`, `src/server/routes/webhooks.ts:22`, `src/server/routes/github-app-webhooks.ts:31`

`router.ts:347` reads `c.req.text()` on the unauthenticated webhook route with **no size cap**. Bun's default body limit is generous (~100MB). Combined with the in-memory rate limiter that allows 60 req/min/IP, a single attacker can OOM the process by sending 60 × 100MB = 6GB of webhook bodies per minute.

`/api/*` has no body cap either — the rate limit is `200/min`, so 200 × 100MB = 20GB/min into Hono's memory.

`cli-monitor.ts:176-208` correctly defines `MAX_BODY_SIZE_BYTES = 5MB` and validates `Content-Length` — the **only** route in the codebase that does this.

**Direction**:
1. Create a generic `bodyLimit(maxBytes)` Hono middleware that checks `Content-Length` and short-circuits 413 (Payload Too Large) before the handler reads the body.
2. Apply tiered limits: `/hooks/*` 100KB, `/api/auth/*` 10KB, `/api/*` 1MB (default), `/api/memory/*` 50MB (embeddings round-trip), `/api/cli-monitor` keep at 5MB.
3. Make the limit env-overridable for ops (`MAX_BODY_BYTES_HOOKS=102400`) but with conservative defaults that ship in production.

Cross-ref: F06-15 (April).

---

## F06-NEW-10 — P1 — CSP missing `wasm-unsafe-eval` (Shiki) and missing avatar / GitHub allow-list

**Size: S** · `src/server/router.ts:184-191`

Production CSP at `:188`:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'
```

Two real-world breakages:
1. **Shiki uses WebAssembly** for grammar parsing. Without `'wasm-unsafe-eval'` in `script-src`, Chrome blocks the WASM compile; the syntax-highlighting silently fails (the `HighlightedCode` fallback prevents a crash but UX degrades). Verified by the dynamic `import('shiki')` at `markdown-content.tsx:14` and `terraform-right-panel.tsx:132`.
2. **Avatars** load from `https://avatars.githubusercontent.com`. The team-member list, codespace owner, etc. The current `img-src 'self' data:` blocks them — in production the UI shows broken images.

The CSP also includes `style-src 'unsafe-inline'` which is fine because Tailwind injects classes (no inline style attribute is generated by the framework), but is a wide latitude that could mask real CSS-injection bugs.

**Direction**: Tune the production CSP to:
```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://avatars.githubusercontent.com;
connect-src 'self' https://api.github.com;
font-src 'self' data:;
frame-ancestors 'none';
```
Run with `Content-Security-Policy-Report-Only` for one week to collect violation reports (`router.ts:188` becomes `Content-Security-Policy-Report-Only` initially). After tuning, add a Playwright test that loads the dashboard with a production build and asserts no CSP violations in console.

Cross-ref: F06-10 (April).

---

## F06-NEW-11 — P1 — Stream subscribe at `/v1/stream/sessions/:id` bypasses API auth and tenant isolation

**Size: L** · `src/server/routes/sessions.ts:439-440`, `src/lib/streams/stream-id.ts:38-100`, `src/lib/streams/caddy-producer.ts:206-210`

The April 20 review (F06-14) flagged this. April 29 verifies it: there is no SSE endpoint inside the API server (`sessions.ts:439-440` documents the removal). Clients subscribe directly to Caddy at `/v1/stream/sessions/:id`. The subscription handshake never touches Hono, so:

- The session ID is just a CUID — guessable if the attacker observes another tenant's traffic.
- `requireTagAccess` does not run.
- Tag-restricted tokens still receive every event published to a session they shouldn't see.
- Plan and sandbox streams have the same shape (`plan:{id}`, `sandbox:{id}`) and are subscribed the same way — bypassing API server auth entirely.

The stream-id branding (`stream-id.ts:38-100`) prevents *publish-side* mismatches — a plan-event published with a session-shaped ID throws — but the *subscribe side* has no enforcement.

**Direction (within constraints — no Redis, no external secret store)**:
1. Generate a per-stream HMAC token at subscribe time. The HMAC key is the existing `encryption.key` file (`server-encryption.ts:16-31`) — already on disk with `0o600` perms. Hash with `crypto.createHmac('sha256', key)`.
2. Issue an `/api/sessions/:id/subscribe-token` endpoint that returns `{ url, token }` after `requireTagAccess` runs. The client uses `?token=<hmac>` when opening the EventSource.
3. Caddy is configured to require the token via a request matcher; on mismatch, 401. This is a Caddy config change plus a one-line `crypto` helper in the API server. No new infra.

Cross-ref: F06-14 (April).

---

## F06-NEW-12 — P1 — 12 open Dependabot advisories, 3 critical (protobufjs RCE, Trivy supply-chain, golang.org/x/crypto auth bypass)

**Size: L** · Live data: `gh api repos/agentdevsl/agentpane/dependabot/alerts?state=open --paginate` (run 2026-04-29)

Counts as of April 29:
- **3 critical** — `protobufjs` (npm, runtime, RCE arbitrary code execution), `aquasecurity/trivy-action` (GitHub Action, supply-chain compromise), `golang.org/x/crypto` (`ServerConfig.PublicKeyCallback` authorization bypass — note the project uses Go for the CI Trivy action, not for runtime; affects only CI security scanning)
- **4 high** — all `golang.org/x/crypto` SSH (DoS, NULL deref, panic on malformed packet, slow-or-incomplete connection DoS) — same caveat: dev-only via Trivy
- **5 medium** — `uuid` (bounds check), `esbuild` (dev server CORS), 3× `golang.org/x/crypto`

**Critical-runtime exposure**: only `protobufjs` is a direct npm runtime advisory. The package isn't in the top-level `package.json` — it's transitive (likely via `@kubernetes/client-node`). Without a `package-lock.json`/`bun.lock` review I can't confirm the dependency path; verify with `bun pm ls protobufjs` or `npm ls protobufjs`.

**Direction**:
1. Run `bun pm ls protobufjs` (or `npm ls protobufjs`) to identify the consuming package; bump the parent to a version that resolves the advisory. If `@kubernetes/client-node` is the consumer, the latest 1.x has been patched.
2. `aquasecurity/trivy-action`: update the workflow YAML to pin to a post-incident commit SHA. The advisory body includes the safe SHAs.
3. Wire `bun audit --audit-level=high` (or `npm audit --audit-level=critical`) into CI as a non-blocking comment first, then promote to blocking once the inventory is clean.
4. Add `dependabot.yml` weekly schedule for grouped patch updates (already present per `chore(deps): bump ...` commit cadence; verify it's not gated on manual review).

Cross-ref: F06-01 (April).

---

## F06-NEW-13 — P2 — Session cookie `Secure` flag still keyed on `NODE_ENV === 'production'`, asymmetric with `oauth_state`

**Size: XS** · `src/server/routes/auth.ts:194-199` vs `:50`

Repeated from F06-13 (April), still unfixed. The session cookie at `:194` only sets `Secure` when `NODE_ENV === 'production'`. The OAuth state cookie at `:50` is **always** `Secure`. A staging deployment with `NODE_ENV=staging` (or a custom value) sets a session cookie without `Secure`, even if the deployment is HTTPS-only. The asymmetry means a single env-var typo silently downgrades session security but not state-cookie security.

**Direction**: derive `secure` from `c.req.url.startsWith('https://')` for both cookies. Keep an env-override `FORCE_INSECURE_COOKIES=1` for local HTTP testing. Apply to all four cookie clear sites at `:236`, `:252`, `:276`, `:295`.

Cross-ref: F06-13 (April).

---

## F06-NEW-14 — P2 — `cloneUrl` containing GitHub token still appears in container `/proc/<pid>/cmdline`

**Size: M** · `src/lib/sandbox/k8s-workspace-initializer.ts:89`, `:122-150`

```
const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
...
await sandbox.exec('git', ['-C', CONTAINER_WORKSPACE_PATH, 'remote', 'add', 'origin', cloneUrl]);
```

The token is passed as **a literal positional argv** to `git remote add`. While positional argv avoids shell injection (good — that's the F06-02 fix), it does **not** keep the value out of `/proc/<pid>/cmdline`. Inside the container, any sibling process (in shared-sandbox mode, every other tenant's agent) can run `cat /proc/<git-pid>/cmdline` and see the URL with the embedded token. The token is later stripped at `:251` (`set-url origin https://github.com/owner/repo.git`), but only **after** the git fetch has completed; the window is the duration of the fetch (seconds for shallow, minutes for large repos).

**Direction**: Use `git -c http.extraHeader='Authorization: Basic ...' fetch ...` form, where the extra header is set via `-c` config (still in argv but the token isn't in the URL). Better: write a tmpfs-backed credentials file with `git config --global credential.helper 'store --file=/run/secrets/git-creds'` and remove after fetch. Both approaches keep the token out of cmdline.

Cross-ref: F06-NEW-02 (shared sandbox makes this exfiltrable).

---

## F06-NEW-15 — P2 — `containsSecrets` allowlist excludes `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`; codespace config can carry secrets

**Size: S** · `src/lib/config/validate-secrets.ts:13`

The secret-pattern guard at `validate-secrets.ts:11-13` blocks keys matching `/SECRET/i /PASSWORD/i /PRIVATE_KEY/i /_TOKEN$/i /_API_KEY$/i` — but explicitly **allows** `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`. The intent is that these are infra-managed and acceptable in env config; the practical effect is that a codespace config can store these names and the values pass through `validateConfig` (`codespace.service.ts:691-702`) untouched. The codespace config is then synced to GitHub via `syncConfigFromGitHub` (`:478-543`) and pushed to the repo — committing live API keys to a GitHub repo.

**Direction**:
1. Drop `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` from the `ALLOWED_KEYS` list. These belong in env vars or the encrypted SQLite settings, never in codespace config.
2. Add a value-shape check: even for keys not on the blocked-name list, if the value matches `/^(sk-ant-|ghp_|github_pat_|sk-)/`, reject. This catches a key called `notification_url` whose value is actually `sk-ant-oat01-...`.

---

## F06-NEW-16 — P3 — Anthropic API key format check accepts non-OAuth keys

**Size: XS** · `src/services/api-key.service.ts:44-48`

```
if (service === 'anthropic' && !key.startsWith('sk-ant-')) {
  return err({ code: 'INVALID_FORMAT', message: 'Anthropic API keys must start with "sk-ant-"' });
}
```

Both OAuth tokens (`sk-ant-oat01-...`) and API keys (`sk-ant-api03-...`) start with `sk-ant-`. The Claude Agent SDK behaviour differs by token type — OAuth tokens are blocked when passed via `ANTHROPIC_API_KEY` env var (per CLAUDE.md), so an API key stored under the `anthropic` service slot can be ambiguous. `shared-helpers.ts:281` checks `oauthToken?.startsWith('sk-ant-oat')` to *log* whether the token is OAuth, but never to reject the wrong type for the wrong path.

**Direction**: split the `anthropic` service slot into `anthropic-oauth` and `anthropic-api-key` slots; validate the prefix per slot; surface the distinction in the settings UI so users can't paste an API key where an OAuth token is expected (or vice versa). Add `key.length` minimum check (real Anthropic tokens are 100+ chars).

---

## Summary

3 P0, 9 P1, 3 P2, 1 P3 across 16 new findings. The top 3 P0s (F06-NEW-01, F06-NEW-02, F06-NEW-03) are the critical residual surfaces from the April 20 review — incompletely-applied shell-argv migration, unfixed shared-sandbox tenant isolation, and a permissive escape function. F06-NEW-04 (agent-runner regex YAML parser) is the most surprising new finding; the host fix didn't reach the runner.

| ID | P | Size | Status |
|---|---|---|---|
| F06-NEW-01 | P0 | M | Fix existing `worktree.service.ts` callers; make `execArgs` mandatory |
| F06-NEW-02 | P0 | XL | Per-codespace credentials file + multi-tenant gate |
| F06-NEW-03 | P0 | S | Tighten `escapeShellString` or remove entirely |
| F06-NEW-04 | P1 | M | Replace agent-runner regex parser with `yaml` package |
| F06-NEW-05 | P1 | M | Drop `CLAUDE_OAUTH_TOKEN` env var, rely on credentials file |
| F06-NEW-06 | P1 | S | Tighten `validateShellCommand` regex |
| F06-NEW-07 | P1 | M | Filter list endpoints for tag-restricted tokens |
| F06-NEW-08 | P1 | M | SQLite-backed rate-limit persistence |
| F06-NEW-09 | P1 | S | Generic `bodyLimit` middleware with tiered defaults |
| F06-NEW-10 | P1 | S | CSP tuning + Report-Only rollout |
| F06-NEW-11 | P1 | L | HMAC-signed stream subscribe tokens |
| F06-NEW-12 | P1 | L | Resolve 3 critical Dependabot advisories |
| F06-NEW-13 | P2 | XS | `Secure` from URL scheme not env |
| F06-NEW-14 | P2 | M | Move clone token to `-c http.extraHeader` |
| F06-NEW-15 | P2 | S | Drop `ANTHROPIC_API_KEY` from secret allowlist |
| F06-NEW-16 | P3 | XS | Split `anthropic` service slot by token kind |

Cross-references: F06-NEW-02 ↔ `04-sandbox-providers.md` (multi-tenant work), F06-NEW-08 ↔ `07-api-surface.md` (rate limiter persistence), F06-NEW-11 ↔ `05-event-streaming.md` (subscribe auth), F06-NEW-12 ↔ `12-cross-cutting.md` (supply chain).
