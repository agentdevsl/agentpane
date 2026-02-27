# Spec-vs-Implementation Gap Analysis

> Complete gap analysis comparing 9 spec documents in `specs/rbac-auth/` against the RBAC implementation on `feature/rbac`.

## CRITICAL Issues

### C1: Spec Contradiction — Untagged Resource Access

| Aspect | Detail |
|--------|--------|
| **Spec A** | `tags.md` line 153: "Resources with no tags are **invisible** to tag-restricted tokens" |
| **Spec B** | `middleware.md` line 569: "If the resource has no tags, it's accessible by any token" |
| **Implementation** | `src/lib/api/rbac-middleware.ts:365` — follows `tags.md` (deny when no tags match) |
| **Impact** | Developers referencing `middleware.md` will expect allow behavior; implementation correctly denies |
| **Fix** | Update `middleware.md` to match `tags.md` and the implementation (deny-by-default) |

### C2: Role Name Mismatch — `member` vs `agent_operator`

| Aspect | Detail |
|--------|--------|
| **Spec** | `api-endpoints.md` uses `member` as role level 2 with schema `z.enum(['viewer', 'member', 'admin'])` |
| **Implementation** | `src/server/validation.ts:102` — `z.enum(['owner', 'admin', 'agent_operator', 'viewer'])` |
| **Impact** | Spec's Zod schema would reject `agent_operator` values; API consumers referencing spec will use wrong role name |
| **Fix** | Update `api-endpoints.md` to use `agent_operator` throughout — the implementation name is more descriptive and intentional |

### C3: Zero RBAC Test Coverage

| Aspect | Detail |
|--------|--------|
| **Spec** | `middleware.md` lines 687-737 defines 20+ unit tests and 7+ integration tests |
| **Implementation** | 0 test files for RBAC service, middleware, or any route handler |
| **Impact** | No regression safety net; security-critical code untested |
| **Missing tests** | ~85+ tests across 9 test files (see [test-coverage.md](./test-coverage.md)) |
| **Fix** | Implement test suite with factories, service tests, middleware tests, and route integration tests |

### C4: Token Format Validation Logic Bug

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/api/rbac-middleware.ts:111` |
| **Code** | `if (!rawToken \|\| (!rawToken.startsWith('ap_') && rawToken.length < 20))` |
| **Bug** | Uses `&&` — a 20+ character garbage string not starting with `ap_` passes validation and hits the database |
| **Spec** | `tokens.md` lines 75-80 defines `isValidTokenFormat()`: `/^ap_[A-Za-z0-9_-]{42,44}$/` |
| **Fix** | Replace with: `if (!rawToken \|\| !/^ap_[A-Za-z0-9_-]{42,44}$/.test(rawToken))` |

---

## HIGH Issues

### H1: Duplicate Token DB Lookup in Middleware Chain

| Aspect | Detail |
|--------|--------|
| **Files** | `src/server/router.ts:118-127` + `src/lib/api/rbac-middleware.ts:107-184` |
| **Issue** | `createAuthMiddleware.validateApiKey` hashes the token and queries `api_tokens` for userId. Then `enrichAuthContext` hashes the **same** token and queries `api_tokens` **again** for full scope metadata |
| **Impact** | 2x hash + 2x DB query on every API token request |
| **Fix** | Store validated token metadata on Hono context in `createAuthMiddleware`, read it in `enrichAuthContext` |

### H2: N+1 Query in Team Listing (member counts)

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/teams.ts:132-144` |
| **Code** | `Promise.all(pagedTeams.map(async (team) => { db.select({total: count()}).from(teamMembers)... }))` |
| **Impact** | For N teams, executes N individual `COUNT(*)` queries |
| **Fix** | Single `GROUP BY` query: `db.select({teamId, total: count()}).from(teamMembers).where(inArray(teamId, ids)).groupBy(teamId)` |

### H3: N+1 Query in Tag Listing (project + task counts)

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/tags.ts:98-111` |
| **Code** | `Promise.all(teamTags.map(async (tag) => { Promise.all([countProjects, countTasks]) }))` |
| **Impact** | For N tags, executes 2N COUNT queries |
| **Fix** | Two `GROUP BY` queries (one for project_tags, one for task_tags), join counts in memory |

### H4: Missing `effectiveRole` in Project Members Response

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/project-members.ts:97-137` |
| **Spec** | Requires `teamRole`, `projectRole`, `effectiveRole`, `source` fields |
| **Implementation** | Returns raw DB rows: `userId`, `role`, `grantedByTeamId`, `createdAt`, `name`, `email`, `avatarUrl` |
| **Fix** | Compute effective role via `rbacService.resolveUserRole()` for each member; add `source` field ("direct" vs "team") |

### H5: Missing `search` Query Parameter on GET /api/teams

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/teams.ts:106-209` |
| **Spec** | Defines `search: z.string().optional()` for filtering teams by name |
| **Implementation** | No search parameter accepted or applied |
| **Fix** | Add `LIKE` filter on `teams.name` and/or `teams.slug` when `search` param present |

### H6: Missing `role` Filter on GET /api/teams/:id/members

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/team-members.ts:95-158` |
| **Spec** | Defines `role` filter parameter to list members by specific role |
| **Implementation** | Returns all members regardless of role |
| **Fix** | Add `.where(eq(teamMembers.role, role))` clause when filter param present |

### H7: Missing `projectCount` in GET /api/teams/:id Response

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/teams.ts:222-246` |
| **Spec** | Response should include `memberCount`, `projectCount`, `myRole` |
| **Implementation** | Returns `memberCount` and `myRole` but not `projectCount` |
| **Fix** | Add count query on `teamProjects` table |

### H8: Missing `teamName` in Invitation Accept Response

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/invitation-accept.ts:143-147` |
| **Spec** | Requires `teamName` in acceptance response |
| **Implementation** | Returns `{ teamId, role, joinedAt }` only |
| **Fix** | Join with `teams` table to include `name` in response |

### H9: Missing Email Uniqueness Check on PATCH /api/me

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/me.ts:96-137` |
| **Spec** | Should return `EMAIL_ALREADY_EXISTS` (409) when email conflicts |
| **Implementation** | No uniqueness check before update; raw SQLite UNIQUE constraint error would surface as 500 |
| **Fix** | Check `users` table for email conflict before update; return 409 with `EMAIL_ALREADY_EXISTS` code |

### H10: Per-Token Rate Limit Differs from Spec

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/router.ts:199` |
| **Implementation** | `rateLimiter({ max: 100, windowMs: 60_000, keyOnToken: true })` |
| **Spec** | `tokens.md:535` — `max: 200` per token per 60s |
| **Fix** | Reconcile: either update implementation to 200 or update spec to 100 (100 is more conservative) |

---

## MEDIUM Issues

### M1: TOCTOU Race in Token Creation

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/rbac-tokens.ts:128-188` |
| **Issue** | Name uniqueness check (line 130) and count limit check (line 155) are outside a transaction |
| **Impact** | Concurrent requests could bypass name uniqueness or the 25-token limit |
| **Fix** | Wrap lines 128-188 in `db.transaction()` |

### M2: Token Creation Returns 200 Instead of 201

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/rbac-tokens.ts:198` |
| **Spec** | POST endpoints creating resources should return 201 Created |
| **Fix** | `return json({...}, 201)` |

### M3: Missing `useCount` in Token List Response

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/rbac-tokens.ts:269-286` |
| **Spec** | `TokenListItem` includes `useCount` |
| **Implementation** | `useCount` not selected in query |
| **Fix** | Add `useCount: apiTokens.useCount` to select statement |

### M4: Tag Color is Optional, Spec Says Required

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/validation.ts:177-180` |
| **Spec** | `color: z.string().regex(/^#[0-9a-fA-F]{6}$/)` (required) |
| **Implementation** | `color` is `.optional()` with DB default `#6B7280` |
| **Fix** | Either make required in validation or update spec (optional with DB default is reasonable) |

### M5: `requireTagAccess` Doesn't Filter List Endpoints

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/api/rbac-middleware.ts:355-533` |
| **Issue** | Only checks individual resource access via `:id` param; list endpoints (`GET /api/projects`, `GET /api/tasks`) return all resources even for tag-restricted tokens |
| **Spec** | Resources should be "invisible" to tag-restricted tokens |
| **Fix** | Add query-level WHERE filtering in list handlers when `auth.tokenScope.tags` is set |

### M6: Invitation Tokens Stored in Plaintext

| Aspect | Detail |
|--------|--------|
| **File** | `src/db/schema/sqlite/team-invitations.ts:18` |
| **Issue** | API tokens use SHA-256 hash storage; invitation tokens stored as raw text |
| **Mitigation** | 7-day expiry limits exposure window |
| **Fix** | Hash invitation tokens at storage (lower priority due to short TTL) |

### M7: `enrichAuthContext` Runs 2 DB Queries on Every Request

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/api/rbac-middleware.ts:61-104` |
| **Issue** | User lookup + team memberships query on every `/api/*` request; no caching |
| **Impact** | User/membership data rarely changes but is fetched on every request |
| **Fix** | Add short-lived in-memory cache (60s TTL) keyed by `userId` |

### M8: Token `expiresInDays` vs `expiresAt` Spec Inconsistency

| Aspect | Detail |
|--------|--------|
| **Spec A** | `tokens.md` uses `expiresAt?: Date \| null` (absolute timestamp) |
| **Spec B + Impl** | `api-endpoints.md` and implementation use `expiresInDays: z.number().int().min(1).max(365)` (relative) |
| **Fix** | Update `tokens.md` to match the `expiresInDays` pattern used in implementation and `api-endpoints.md` |

### M9: Missing `createdAt`/`updatedAt` in GET /api/me Response

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/me.ts:67-85` |
| **Spec** | User profile includes `createdAt` and `updatedAt` |
| **Implementation** | Returns `id`, `githubId`, `githubLogin`, `name`, `email`, `avatarUrl`, `authMethod`, `teams` |
| **Fix** | Add `createdAt: user.createdAt, updatedAt: user.updatedAt` to response |

### M10: Inconsistent Error Codes for Authorization Failures

| Aspect | Detail |
|--------|--------|
| **Issue** | `FORBIDDEN` used in `rbac-tokens.ts:51`, `rbac-middleware.ts:245,300`; `INSUFFICIENT_ROLE` used in `teams.ts:219`, `team-members.ts:108,340` |
| **Fix** | Standardize: `INSUFFICIENT_ROLE` for role-based denials, `FORBIDDEN` for scope-based denials (project/tag restriction) |

### M11: `scopeProjectId` (singular) vs Spec's `scopeProjectIds` (plural)

| Aspect | Detail |
|--------|--------|
| **Spec** | `tokens.md` defines `scopeProjectIds: string[]` (array) |
| **Implementation** | Single `scopeProjectId: text` foreign key (deliberate simplification) |
| **Note** | `api-endpoints.md` also uses singular — internal spec conflict |
| **Fix** | Update `tokens.md` to match singular pattern |

### M12: Admin Role Assignment Spec Mismatch

| Aspect | Detail |
|--------|--------|
| **Spec** | "admin can only assign `viewer` or `member`" |
| **Implementation** | admin can assign `viewer` or `agent_operator` |
| **Note** | Related to C2 role naming; resolves once spec updated to `agent_operator` |

### M13: Extra Endpoints Not in Spec

| Aspect | Detail |
|--------|--------|
| **Endpoints** | `POST /api/teams/:id/transfer-ownership` and `POST /api/teams/:id/invitations/:iid/decline` |
| **Issue** | Both implemented but absent from `api-endpoints.md` |
| **Fix** | Add both to spec — they're useful and well-implemented |

---

## LOW Issues

### L1: No Audit Logging for Token Operations

| Aspect | Detail |
|--------|--------|
| **Spec** | Requires structured audit trail for token create/use/revoke |
| **Implementation** | Only `log.error` for failures; no audit events published |
| **Fix** | Add audit trail (future phase, not blocking) |

### L2: Token Prefix 12 chars vs Spec's 10 chars

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/rbac-tokens.ts:169` — `rawToken.substring(0, 12)` |
| **Spec** | Token prefix should be 10 characters |
| **Fix** | Update spec to 12 (more useful for identification, implementation is intentional) |

### L3: `CANNOT_REMOVE_LAST_OWNER` Returns 409, Spec Says 400

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/team-members.ts:354` |
| **Spec** | 400 Bad Request |
| **Implementation** | 409 Conflict |
| **Fix** | Either change to 400 or update spec (409 is arguably more semantically correct) |

### L4: Missing `invitedBy` Enrichment in Invitation List

| Aspect | Detail |
|--------|--------|
| **File** | `src/server/routes/team-invitations.ts:131` |
| **Spec** | Returns `invitedBy: { userId, name }` object |
| **Implementation** | Returns raw `invitedBy` userId string |
| **Fix** | Join with `users` table to include name |

### L5: No Pagination on Tag Listing

| Aspect | Detail |
|--------|--------|
| **Issue** | Both spec and implementation lack pagination for `GET /api/tags` |
| **Impact** | `Promise.all` enrichment (2N queries) compounds — bottleneck for large tag sets |
| **Fix** | Add cursor pagination (consistent with other list endpoints) |

### L6: 403 Reveals Team Existence to Non-Members

| Aspect | Detail |
|--------|--------|
| **Issue** | `requireTeamRole` returns 403 for non-members, confirming team exists |
| **Security** | Should return 404 to prevent information leakage |
| **Fix** | Return 404 for non-members (same as GitHub's approach) |

### L7: Fire-and-Forget Token Expiry Update Lacks Retry

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/api/rbac-middleware.ts:135-139` |
| **Issue** | If async update fails, expired token stays `active` in DB; expiry check runs on every request |
| **Impact** | Minor — token is still rejected, just not marked as expired in DB |
| **Fix** | Add periodic sweep job or bounded retry (low priority) |
