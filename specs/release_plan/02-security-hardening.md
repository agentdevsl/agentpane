# Security Hardening Assessment

## Current Security Posture

AgentPane has a solid security foundation with several well-implemented patterns:

**Authentication & Authorization:**
- GitHub OAuth with PKCE-like state parameter for CSRF protection (SHA-256 hashed session tokens stored in DB)
- SKIP_AUTH dev bypass is double-gated on `SKIP_AUTH=true` AND `NODE_ENV=development` with defense-in-depth in RBAC middleware
- Server config (`server-config.ts:79-82`) hard-exits if `SKIP_AUTH=true` is set in production
- 4-role RBAC hierarchy (owner > admin > agent_operator > viewer) with proper role level comparison
- API token scope enforcement with codespace and tag-based access restrictions
- Token ceiling: API token role cannot exceed the user's team membership role
- Invitation acceptance uses `githubEmail` (immutable from OAuth) not user-editable email for verification

**Cryptography:**
- Session tokens: 32 random bytes, SHA-256 hashed before DB storage, raw value in HttpOnly cookie
- API keys encrypted at rest with AES-256-GCM, key file has 0o600 permissions
- Webhook signatures verified with HMAC-SHA256

**Input Validation:**
- Centralized Zod schemas in `src/server/validation.ts` for all major route inputs
- `isValidId()` regex `^[a-zA-Z0-9_-]+$` prevents injection in ID parameters
- `isValidBranchName()` rejects `..` and restricts to `[a-zA-Z0-9_\-/.]+`
- `isValidGitHubUrl()` validates protocol and hostname
- `validateShellCommand()` rejects dangerous shell metacharacters (`;|` + `` ` `` + `$(` + `&&` + `||` + newlines)
- `escapeShellString()` for shell argument escaping
- `skillId` validated with `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` regex

**Security Headers & CORS:**
- X-Content-Type-Options: nosniff, X-Frame-Options: DENY, X-XSS-Protection: 1; mode=block
- HSTS and CSP applied in production
- Single-origin CORS design (configurable via `CORS_ORIGIN` env var)

**Sandbox Security:**
- Containers run as non-root user
- Credentials injected via base64 encoding (prevents shell injection)
- Credentials file set to 600 permissions inside container
- Docker exec uses array-based `Cmd` (no shell interpolation)

**Static Analysis:**
- 7 custom Semgrep rules covering shell safety, path safety, container security, deserialization, error handling, invariant enforcement, type safety

---

## Critical Vulnerabilities

### C1. No `CapDrop` or `SecurityOpt` on Docker Containers
**File:** `src/lib/sandbox/providers/docker-provider.ts:532-548`
**Severity:** CRITICAL

Docker containers are created without dropping Linux capabilities or setting `no-new-privileges`:

```typescript
HostConfig: {
  Binds: binds,
  Memory: config.memoryMb * 1024 * 1024,
  NanoCpus: config.cpuCores * 1e9,
  NetworkMode: config.networkMode ?? 'bridge',
  AutoRemove: false,
  // Missing: CapDrop: ['ALL'], CapAdd: [...only needed...]
  // Missing: SecurityOpt: ['no-new-privileges']
  // Missing: ReadonlyRootfs: true (with writable tmpfs mounts)
}
```

The Semgrep rules (`container-security.yml`) detect this pattern but it has not been fixed. A compromised agent process inside the container retains default Linux capabilities (NET_RAW, SYS_CHROOT, MKNOD, etc.) enabling potential privilege escalation.

**Fix:** Add `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges']`, and only add back specific capabilities that are needed.

### C2. Path Traversal in GitHub Clone Destination
**File:** `src/server/routes/github.ts:124-128`
**Severity:** CRITICAL

The clone `destination` parameter undergoes only tilde expansion -- no path traversal protection:

```typescript
const destination = body.destination.replace(/^~/, homeDir);
const repoName = body.url.split('/').pop()?.replace('.git', '') || 'repo';
const fullPath = `${destination}/${repoName}`;
```

The Zod schema (`cloneSchema`) only validates `z.string().min(1)` with no path restrictions. An attacker with admin access (the route requires `viewer` minimum via GitHub RBAC) could clone to arbitrary filesystem locations like `../../etc/` or `/tmp/malicious`. The same issue exists in the `create-from-template` endpoint at line 257.

**Fix:** Validate that the resolved destination is under an allowed set of directories (similar to the `filesystem.ts` approach), or at minimum ensure it resolves to a path under the user's home directory.

### C3. Shell Injection via `codespace.service.ts` Clone Operations
**File:** `src/services/codespace.service.ts:518-529`
**Severity:** CRITICAL

The `cloneRepository` method interpolates user-controlled `url` and `targetPath` values directly into shell commands:

```typescript
await this.runner.exec(`mkdir -p "${resolved}"`, '/tmp');
await this.runner.exec(`git clone "${url}" "${targetPath}"`, resolved);
```

While double-quoting prevents basic injection, a `url` or path containing `"` would break out of the quotes. The `url` parameter comes from user input and is not validated with `isValidGitHubUrl()` in this service method (validation only happens in the route handler). The `exec` calls pass through `validateShellCommand()` in the sandbox runner, but the direct runner path (non-sandbox) does not have this guard.

**Fix:** Use array-based arguments (like the `Bun.spawn(['git', 'clone', url, path])` pattern used in `github.ts:162`) or ensure `validateShellCommand` is applied to all command runner paths.

### C4. Hardcoded CORS Origin in SSE Headers
**File:** `src/server/shared.ts:87-91`
**Severity:** HIGH (production-impacting)

The `corsHeaders` constant used for SSE endpoints hardcodes `http://localhost:3000`:

```typescript
export const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  // ...
};
```

This is used in `src/server/routes/task-creation.ts:440` for SSE responses. In production, the origin will differ from `localhost:3000`, causing CORS failures for SSE connections. The main Hono CORS middleware respects `CORS_ORIGIN`, but these manual SSE headers do not.

**Fix:** Read from `process.env.CORS_ORIGIN` or pass the configured origin from the router.

---

## High Priority Issues

### H1. No Expired Session Cleanup
**Severity:** HIGH

Session tokens have a 30-day expiration (`SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60`), and the auth middleware checks expiration at login time (`src/server/router.ts:135`). However, there is **no background job or scheduled task to purge expired sessions** from the `user_sessions` table. Over time, this table grows unboundedly with stale records.

Additionally, there is no mechanism to revoke all sessions for a user (e.g., "log out everywhere" or after a security incident).

**Fix:** Add a periodic cleanup job (e.g., delete sessions where `expiresAt < NOW()`) and add a revoke-all-sessions endpoint.

### H2. IP Spoofing in Rate Limiter
**File:** `src/lib/api/rate-limiter.ts:95-98`
**Severity:** HIGH

The rate limiter trusts `X-Forwarded-For` and `X-Real-IP` headers without any trusted proxy configuration:

```typescript
rateLimitKey =
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
  c.req.header('x-real-ip') ??
  'unknown';
```

An attacker can set `X-Forwarded-For: <random-ip>` on each request to bypass rate limiting entirely, since each request appears to come from a different IP. Behind a trusted reverse proxy (Caddy), the rightmost non-trusted IP should be used, not the leftmost.

**Fix:** Configure trusted proxy IPs and use the last non-trusted IP from the `X-Forwarded-For` chain. In single-proxy deployments, use the second-from-right entry. Consider using the socket remote address directly when no proxy is configured.

### H3. Audit Hook Silently Swallows All Errors
**File:** `src/lib/agents/hooks/audit.ts:37`
**Severity:** HIGH

The audit logging hook has a completely empty catch block:

```typescript
} catch (_error) {}
```

This means if the audit log database write fails (disk full, schema mismatch, connection error), the failure is completely invisible. Audit logs are a critical security control for tracking what agents do -- silently dropping them undermines security monitoring.

**Fix:** At minimum log the error: `catch (error) { log.error('Audit log write failed', { error, data: { agentId, tool: input.tool_name } }); }`.

### H4. In-Memory Rate Limiting is Bypassed by Restarts
**File:** `src/lib/api/rate-limiter.ts`
**Severity:** HIGH

Rate limit counters are stored in process memory. A server restart clears all counters, and in multi-instance deployments each instance has independent counters. This is documented with a TODO for Redis-backed rate limiting but remains unimplemented.

For production: during a deploy (rolling restart), all rate limit state is lost, allowing burst attacks. An attacker can also force-restart by triggering resource exhaustion.

**Fix:** Implement Redis-backed rate limiting (e.g., `@upstash/ratelimit`) or use a persistent rate limit store.

### H5. Empty Tool Whitelist Allows All Tools
**File:** `src/lib/agents/hooks/tool-whitelist.ts:8-9`
**Severity:** HIGH

When `allowedTools` is an empty array, the whitelist check returns early and allows all tools:

```typescript
if (allowedTools.length === 0) {
  // If no tools specified, allow all
  return {};
}
```

This is an unsafe default. If the caller forgets to specify allowed tools (or the config is missing), the agent gets unrestricted tool access. This should be an explicit opt-in rather than the default.

**Fix:** Require callers to explicitly pass `allowedTools: ['*']` (or similar) to allow all tools, making open access a conscious decision.

### H6. No Session Cookie `Secure` Flag in Development
**File:** `src/server/routes/auth.ts:196-199`
**Severity:** MEDIUM-HIGH (varies by deployment)

The session cookie only gets the `Secure` flag in production:

```typescript
const secureSuffix = process.env.NODE_ENV === 'production' ? '; Secure' : '';
```

This is documented as intentional for local dev, but if the app is deployed to a staging environment that uses HTTPS but has `NODE_ENV !== 'production'`, session cookies will be sent over unencrypted connections.

**Fix:** Key on the protocol (is the connection HTTPS?) rather than `NODE_ENV`, or ensure staging environments always set `NODE_ENV=production`.

---

## Medium Priority Issues

### M1. 27+ Empty Catch Blocks Across Services
**Files:** Multiple (see grep results above)
**Severity:** MEDIUM

There are 27+ instances of `catch (_error) {}` across production code including:
- `src/services/api-key.service.ts:164` -- `markInvalid()` silently fails
- `src/services/durable-streams.service.ts:691,963` -- Caddy stream operations
- `src/services/template-sync-scheduler.ts:99,107,136` -- template sync operations
- `src/services/git.service.ts:209,310,345,383` -- git operations
- `src/lib/sandbox/providers/docker-provider.ts:365,465,479,499,807` -- docker operations

The Semgrep rule `agentpane.error-handling.empty-catch-block` exists but these instances persist.

**Fix:** Add at minimum `log.warn()` calls in all catch blocks, or add `// nosemgrep: intentional` comments with justification where swallowing is genuinely desired.

### M2. `ISecurityService` Interface Not Implemented
**Severity:** MEDIUM

The security spec defines an `ISecurityService` interface that is not implemented anywhere in the codebase (confirmed via grep). This means security-critical operations that should be centralized (audit logging, security event tracking, anomaly detection) are scattered or missing.

**Fix:** Implement the `ISecurityService` interface as defined in the spec, or explicitly document that the interface has been superseded by the current distributed approach.

### M3. Webhook Signature Verification Optional in Non-Production
**File:** `src/server/routes/webhooks.ts:30-45`
**Severity:** MEDIUM

Webhook signature verification is only mandatory in production. In development/staging, webhooks can be received without any signature verification if `GITHUB_WEBHOOK_SECRET` is not set:

```typescript
const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
if (!secret && process.env.NODE_ENV === 'production') { ... }
if (secret) { /* verify */ }
```

This means staging environments could process spoofed webhooks.

**Fix:** Default to rejecting unsigned webhooks unless explicitly opted out with a flag.

### M4. CSP Too Restrictive for Production Use
**File:** `src/server/router.ts:111-114`
**Severity:** MEDIUM

The production CSP is:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'
```

This blocks:
- External fonts (Google Fonts, etc.)
- External avatar images (GitHub `avatars.githubusercontent.com`)
- WebSocket connections (`ws://` or `wss://` for SSE/real-time features)
- CDN resources

The CSP needs to be tuned for the actual production asset sources, or it will break the frontend.

**Fix:** Add `img-src 'self' data: https://avatars.githubusercontent.com;` and `connect-src 'self' wss:;` at minimum. Audit all external resources used by the frontend.

### M5. All Agents Share a Single OAuth Token
**Severity:** MEDIUM

All agents use the same static OAuth token (resolved from DB or environment in `shared-helpers.ts:230-251`). There is no per-agent identity or token rotation. If the token is compromised, all agent operations are compromised. There is also no way to attribute API calls to specific agents for billing or audit purposes.

**Fix:** Implement per-agent token provisioning or at minimum log the agent ID alongside all SDK calls for attribution.

### M6. Missing Request Body Size Limits
**Severity:** MEDIUM

No explicit request body size limit is configured in the Hono middleware chain. The only protection is Bun's default limits. Large payloads could cause memory exhaustion.

**Fix:** Add a body size limit middleware (e.g., 10MB for general API, 1MB for webhook endpoints).

### M7. No CSRF Protection for Session-Authenticated State-Changing Requests
**Severity:** MEDIUM

While the OAuth flow has CSRF protection (state parameter), the session cookie uses `SameSite=Lax`. This protects against most CSRF attacks but not top-level navigations (e.g., a malicious link that triggers a GET request with side effects). All state-changing operations should use POST/PATCH/DELETE (which `SameSite=Lax` blocks from cross-origin), but this should be verified systematically.

There is no CSRF token mechanism for API requests authenticated via session cookie.

**Fix:** Verify all state-changing operations use non-GET methods. Consider adding `SameSite=Strict` or a custom CSRF token header requirement for session-authenticated requests.

---

## Recommendations

Ordered by priority and with effort estimates:

| # | Item | Priority | Effort | Status | Description |
|---|------|----------|--------|--------|-------------|
| 1 | Docker CapDrop & SecurityOpt | Critical | Small (1h) | **DONE** | Added `CapDrop: ['ALL']`, `CapAdd` for needed caps, and `SecurityOpt: ['no-new-privileges']` to `docker-provider.ts` |
| 2 | Path traversal in clone destinations | Critical | Medium (2-3h) | **DONE** | Added `isValidClonePath()` in `shared.ts`, applied to both `/clone` and `/create-from-template` in `github.ts` |
| 3 | Shell injection in codespace service | Critical | Medium (2-3h) | **DONE** | Added input validation rejecting shell-breaking characters and `..` traversal in `codespace.service.ts` before shell interpolation |
| 4 | Fix hardcoded CORS in SSE headers | High | Small (30m) | **DONE** | `corsHeaders` in `shared.ts` now reads `process.env.CORS_ORIGIN` |
| 5 | Expired session cleanup | High | Medium (2h) | **DONE** | Added hourly expired session purge job + `POST /api/auth/revoke-all` endpoint in `auth.ts` |
| 6 | IP spoofing in rate limiter | High | Medium (3h) | **DONE** | Added `TRUSTED_PROXIES` env var support, right-to-left XFF walk, fallback to `X-Real-IP` in `rate-limiter.ts` |
| 7 | Fix empty catch in audit hook | High | Small (15m) | **DONE** | Added `log.error()` with context in `audit.ts` catch block |
| 8 | Redis-backed rate limiting | High | Large (1-2d) | Replace in-memory store with Redis |
| 9 | Default-deny tool whitelist | High | Small (1h) | Require explicit opt-in for unrestricted tools |
| 10 | Fix empty catch blocks (27+) | Medium | Medium (3-4h) | Add logging to all empty catch blocks |
| 11 | Implement ISecurityService | Medium | Large (2-3d) | Centralize security operations |
| 12 | Tune CSP for production | Medium | Medium (2-3h) | Audit frontend resources and update policy |
| 13 | Add request body size limits | Medium | Small (30m) | Add body size middleware |
| 14 | Enforce webhook signatures in staging | Medium | Small (30m) | Default to requiring signatures |
| 15 | Per-agent token provisioning | Medium | Large (3-5d) | Agent identity and token management |

---

## Missing Security Infrastructure

The following items are defined in specifications or security best practices but are **not implemented**:

| Item | Spec Reference | Status |
|------|---------------|--------|
| `ISecurityService` interface | Security spec | Not implemented -- no file found in codebase |
| Redis-backed rate limiting | `rate-limiter.ts` TODO comment | Acknowledged but unimplemented |
| Session revocation (log out everywhere) | Security best practice | No endpoint or mechanism exists |
| Expired session garbage collection | Security best practice | No cleanup job exists |
| Per-agent identity / token rotation | CLAUDE.md background section | Single shared token for all agents |
| Security event logging / SIEM integration | Production security | No centralized security event stream |
| Brute-force protection for OAuth callback | Security best practice | No lockout after failed attempts |
| API token rate limiting per endpoint | Security best practice | Only global per-token limit exists |
| Container network policies | Container security best practice | Containers use default bridge networking |
| Secrets scanning in CI | CLAUDE.md pre-commit hooks | `detect-secrets` hook exists in pre-commit but no CI-level scanning |
| Request logging with PII redaction | Production compliance | Logger exists but no PII redaction layer |
| Dependency vulnerability scanning | Supply chain security | Dependabot configured (per commit history) but no runtime SCA |
