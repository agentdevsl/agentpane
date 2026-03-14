# Security Findings

> Security-focused analysis of the RBAC implementation on `feature/rbac`.

## Security Posture Summary

The RBAC implementation has strong security fundamentals after 4 hardening commits (45+ issues resolved). Key strengths: SHA-256 token hashing, token ceiling enforcement, fail-closed invitation validation, transactional ownership transfer. The findings below are residual issues.

| Rating | Finding | Impact |
|--------|---------|--------|
| CRITICAL | C4: Token format validation logic bug | Bypasses format check, allows DB queries with garbage tokens |
| HIGH | M5: Tag filtering absent on list endpoints | Tag-restricted tokens see all resources in list views |
| MEDIUM | M1: TOCTOU race in token creation | Could bypass name uniqueness or 25-token limit |
| MEDIUM | M6: Invitation tokens stored in plaintext | DB breach exposes valid invite tokens (7-day window) |
| LOW | L6: 403 reveals team existence | Information leakage to non-members |
| LOW | L7: Fire-and-forget expiry update | Expired tokens not marked in DB on failure |

---

## CRITICAL: Token Format Validation Logic Bug (C4)

### Location
`src/lib/api/rbac-middleware.ts:111`

### Current Code
```typescript
if (!rawToken || (!rawToken.startsWith('ap_') && rawToken.length < 20))
```

### Problem
The `&&` operator means both conditions must be true to reject the token. A string like `"AAAAAAAAAAAAAAAAAAAAAAAAA"` (25 chars, no `ap_` prefix) passes validation because:
- `!rawToken.startsWith('ap_')` → `true`
- `rawToken.length < 20` → `false`
- `true && false` → `false` → token is **not rejected**

This allows arbitrary strings to reach the SHA-256 hash computation and database lookup.

### Attack Surface
- No direct data breach (hashed token won't match any stored hash)
- Enables timing-based token existence probing
- Unnecessary hash computation and DB queries on invalid input
- Violates defense-in-depth principle

### Fix
Replace with spec-defined regex from `tokens.md` lines 75-80:

```typescript
if (!rawToken || !/^ap_[A-Za-z0-9_-]{42,44}$/.test(rawToken)) {
  return c.json(
    { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API token format' } },
    401
  );
}
```

---

## HIGH: Tag Filtering Absent on List Endpoints (M5)

### Location
`src/lib/api/rbac-middleware.ts:355-533`

### Problem
`requireTagAccess` middleware only validates individual resource access when a `:id` route parameter is present. List endpoints (`GET /api/projects`, `GET /api/tasks`) skip tag validation entirely, returning **all** resources regardless of the token's `scopeTags` restriction.

### Attack Scenario
1. Admin creates a token scoped to tag `"frontend"` for a CI system
2. CI token calls `GET /api/projects` and receives all projects, including `"infrastructure"` and `"secrets-management"`
3. Violates spec requirement: "Resources with no matching tags are invisible to tag-restricted tokens"

### Fix
Two-part fix:

**Option A (Recommended): Query-level filtering in route handlers**
```typescript
// In GET /api/projects handler
let query = db.select().from(projects);
if (auth.tokenScope?.tags?.length) {
  const taggedProjectIds = db
    .select({ projectId: projectTags.projectId })
    .from(projectTags)
    .where(inArray(projectTags.tagId, auth.tokenScope.tags));
  query = query.where(inArray(projects.id, taggedProjectIds));
}
```

**Option B: Middleware-level response filtering** (less efficient, filters after fetch)

---

## MEDIUM: TOCTOU Race in Token Creation (M1)

### Location
`src/server/routes/rbac-tokens.ts:128-188`

### Problem
Name uniqueness check (line 130) and active token count check (line 155) are performed as separate SELECT queries outside a transaction. The INSERT happens later at line 175.

### Attack Scenario
1. Two concurrent `POST /api/tokens` requests with same name
2. Both pass uniqueness check (neither has inserted yet)
3. Both pass count check (both see 24 active tokens)
4. Both insert → violates name uniqueness and 25-token limit

### Impact
Low severity in practice (requires tight timing), but the pattern is a security anti-pattern for resource limits.

### Fix
```typescript
return await db.transaction(async (tx) => {
  const existingWithName = await tx.select({id: apiTokens.id}).from(apiTokens)
    .where(and(eq(apiTokens.userId, auth.userId), eq(apiTokens.name, name), ne(apiTokens.status, 'revoked')));
  if (existingWithName.length > 0) { /* return 409 */ }

  const activeCount = await tx.select({total: count()}).from(apiTokens)
    .where(and(eq(apiTokens.userId, auth.userId), eq(apiTokens.status, 'active')));
  if (activeCount[0]?.total >= 25) { /* return 429 */ }

  // ... insert within transaction
});
```

---

## MEDIUM: Invitation Tokens Stored in Plaintext (M6)

### Location
`src/db/schema/sqlite/team-invitations.ts:18`

### Problem
API tokens use SHA-256 hash storage (defense-in-depth against DB breach). Invitation tokens are stored as raw text in the `token` column.

### Mitigations Already in Place
- 7-day expiry significantly limits exposure window
- Tokens are single-use (status changes to `accepted` on use)
- Token format is validated on acceptance (`/^[A-Za-z0-9_-]+$/`)

### Risk Assessment
Low risk due to short TTL, but inconsistent with the security model applied to API tokens. A database breach within the 7-day window would expose valid invitation tokens.

### Fix (Lower Priority)
Hash invitation tokens at storage, send raw token via email/link. Acceptance endpoint would hash the submitted token before lookup — same pattern as API tokens.

---

## LOW: 403 Reveals Team Existence (L6)

### Location
`src/server/shared.ts` — `requireTeamRole` helper

### Problem
Non-members receive `403 Forbidden` when accessing team endpoints, confirming the team exists. Standard practice (GitHub, GitLab) returns `404 Not Found` to prevent information leakage.

### Fix
```typescript
// Instead of:
return json({ ok: false, error: { code: 'INSUFFICIENT_ROLE', message } }, 403);
// Return:
return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Team not found' } }, 404);
```

---

## LOW: Fire-and-Forget Token Expiry Update (L7)

### Location
`src/lib/api/rbac-middleware.ts:135-139`

### Problem
When a token is detected as expired, the middleware updates its status to `'expired'` asynchronously (fire-and-forget). If this update fails, the token remains `active` in the database but is still rejected on every request (because the expiry check runs inline).

### Impact
Minimal — the token is correctly rejected regardless. The only effect is the stale `active` status in the DB and the repeated expiry check on subsequent requests.

### Fix
Add a periodic sweep job that marks expired tokens:
```typescript
// Sweep every hour
await db.update(apiTokens)
  .set({ status: 'expired' })
  .where(and(
    eq(apiTokens.status, 'active'),
    lt(apiTokens.expiresAt, new Date().toISOString())
  ));
```

---

## Existing Security Hardening (Positive Findings)

The following security patterns are correctly implemented:

| Pattern | Location | Notes |
|---------|----------|-------|
| SHA-256 token hashing | `rbac-tokens.ts:168` | Tokens never stored in plaintext |
| Token ceiling enforcement | `rbac-middleware.ts:170-180` | `effective = min(membership, token)` |
| Fail-closed email validation | `invitation-accept.ts:105-130` | Rolls back on email mismatch |
| Transactional ownership transfer | `teams.ts:285-362` | Atomic promote + demote |
| Last owner protection | `team-members.ts:230-260` | Transactional count check |
| Self-demotion prevention | `team-members.ts:185-190` | Can't change own role |
| Token count limit | `rbac-tokens.ts:155-163` | Max 25 active tokens per user |
| Role ceiling on creation | `rbac-tokens.ts:82-100` | Can't create token with higher role |
| Scope validation | `rbac-tokens.ts:102-126` | Project and tag scopes validated against team |
| Fire-and-forget usage tracking | `rbac-middleware.ts:135-155` | Non-blocking `useCount` / `lastUsedAt` updates |
| Input sanitization | `invitation-accept.ts:37` | Token format regex validation |
| Cascading team delete | `teams.ts:375-405` | Removes invitations, tokens, tags, projects, members |
