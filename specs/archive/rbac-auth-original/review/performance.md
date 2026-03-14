# Performance Issues

> Performance analysis of the RBAC implementation on `feature/rbac`.

## Summary

| Issue | Severity | Endpoint | Impact |
|-------|----------|----------|--------|
| H1: Duplicate token DB lookup | HIGH | All API token requests | 2x hash + 2x DB query per request |
| H2: N+1 team member counts | HIGH | GET /api/teams | N queries for N teams |
| H3: N+1 tag counts | HIGH | GET /api/tags | 2N queries for N tags |
| M7: Per-request auth queries | MEDIUM | All /api/* requests | 2 DB queries per request |
| L5: Unpaginated tag listing | LOW | GET /api/tags | Unbounded result set + 2N enrichment |

---

## H1: Duplicate Token DB Lookup in Middleware Chain

### Location
- `src/server/router.ts:118-127` — `createAuthMiddleware.validateApiKey`
- `src/lib/api/rbac-middleware.ts:107-184` — `enrichAuthContext` token lookup

### Problem

Every API token request goes through two middleware functions sequentially:

**Step 1: `createAuthMiddleware`** (router.ts:118-127)
```typescript
validateApiKey: async (key: string) => {
  const tokenHash = createHash('sha256').update(key).digest('hex');  // Hash #1
  const apiToken = await db.query.apiTokens.findFirst({              // Query #1
    where: and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.status, 'active')),
  });
  if (!apiToken) return null;
  if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) return null;
  return apiToken.userId;
},
```

**Step 2: `enrichAuthContext`** (rbac-middleware.ts:107-184)
```typescript
const rawToken = authHeader.substring(7).trim();
const tokenHash = createHash('sha256').update(rawToken).digest('hex');  // Hash #2
const tokenRecords = await db.select()                                  // Query #2
  .from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
```

### Cost
- 2 SHA-256 hash computations (CPU cost, ~microseconds)
- 2 database queries against `api_tokens` table (I/O cost, ~1-5ms each)
- Per-request overhead: ~2-10ms unnecessary latency

### Fix

Store the full token record on Hono context in `createAuthMiddleware`:

```typescript
// router.ts — store token metadata
validateApiKey: async (key: string) => {
  const tokenHash = createHash('sha256').update(key).digest('hex');
  const apiToken = await db.query.apiTokens.findFirst({
    where: and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.status, 'active')),
  });
  if (!apiToken) return null;
  if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) return null;
  // Store for enrichAuthContext to read
  c.set('_resolvedApiToken', apiToken);
  return apiToken.userId;
},
```

```typescript
// rbac-middleware.ts — read from context instead of re-querying
if (auth.authMethod === 'api_token') {
  const cached = c.get('_resolvedApiToken');
  if (cached) {
    // Use cached token record directly
    rbacAuth.tokenScope = { ... };
  }
}
```

**Estimated savings**: ~2-5ms per API token request (eliminates 1 hash + 1 DB query).

---

## H2: N+1 Query in Team Listing

### Location
`src/server/routes/teams.ts:132-144`

### Current Code
```typescript
const items = await Promise.all(
  pagedTeams.map(async (team) => {
    const [memberCountResult] = await db
      .select({ total: count() })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, team.id));
    return {
      ...team,
      memberCount: memberCountResult?.total ?? 0,
      myRole: null as string | null,
    };
  })
);
```

### Problem
For a page of N teams (default likely 20-50), executes N individual `SELECT COUNT(*)` queries against `team_members`. While `Promise.all` parallelizes them, SQLite is single-writer and processes queries sequentially at the engine level.

### Performance at Scale
| Teams | Queries | Estimated Latency |
|-------|---------|-------------------|
| 10 | 10 | ~5-10ms |
| 50 | 50 | ~25-50ms |
| 100 | 100 | ~50-100ms |

### Fix
Single `GROUP BY` query:

```typescript
const memberCounts = await db
  .select({ teamId: teamMembers.teamId, total: count() })
  .from(teamMembers)
  .where(inArray(teamMembers.teamId, teamIds))
  .groupBy(teamMembers.teamId);

const countMap = new Map(memberCounts.map(r => [r.teamId, r.total]));

const items = pagedTeams.map(team => ({
  ...team,
  memberCount: countMap.get(team.id) ?? 0,
  myRole: null as string | null,
}));
```

**Estimated savings**: N queries → 1 query. For 50 teams: ~25-50ms → ~1-2ms.

---

## H3: N+1 Query in Tag Listing

### Location
`src/server/routes/tags.ts:98-111`

### Current Code
```typescript
const enrichedTags = await Promise.all(
  teamTags.map(async (tag) => {
    const [projectCountResult, taskCountResult] = await Promise.all([
      db.select({ total: count() }).from(projectTags).where(eq(projectTags.tagId, tag.id)),
      db.select({ total: count() }).from(taskTags).where(eq(taskTags.tagId, tag.id)),
    ]);
    return {
      ...tag,
      projectCount: projectCountResult[0]?.total ?? 0,
      taskCount: taskCountResult[0]?.total ?? 0,
    };
  })
);
```

### Problem
For N tags, executes 2N COUNT queries (one for `project_tags` and one for `task_tags` per tag).

### Performance at Scale
| Tags | Queries | Estimated Latency |
|------|---------|-------------------|
| 10 | 20 | ~10-20ms |
| 50 | 100 | ~50-100ms |
| 100 | 200 | ~100-200ms |

### Fix
Two `GROUP BY` queries, join in memory:

```typescript
const tagIds = teamTags.map(t => t.id);

const [projectCounts, taskCounts] = await Promise.all([
  db.select({ tagId: projectTags.tagId, total: count() })
    .from(projectTags)
    .where(inArray(projectTags.tagId, tagIds))
    .groupBy(projectTags.tagId),
  db.select({ tagId: taskTags.tagId, total: count() })
    .from(taskTags)
    .where(inArray(taskTags.tagId, tagIds))
    .groupBy(taskTags.tagId),
]);

const projectCountMap = new Map(projectCounts.map(r => [r.tagId, r.total]));
const taskCountMap = new Map(taskCounts.map(r => [r.tagId, r.total]));

const enrichedTags = teamTags.map(tag => ({
  ...tag,
  projectCount: projectCountMap.get(tag.id) ?? 0,
  taskCount: taskCountMap.get(tag.id) ?? 0,
}));
```

**Estimated savings**: 2N queries → 2 queries. For 50 tags: ~50-100ms → ~2-4ms.

---

## M7: Per-Request Auth Context Queries

### Location
`src/lib/api/rbac-middleware.ts:61-104`

### Current Code
```typescript
// Query 1: User lookup
const user = await db.query.users.findFirst({
  where: eq(users.id, auth.userId),
});

// Query 2: Team memberships
const memberships = await db
  .select({ teamId: teamMembers.teamId, role: teamMembers.role })
  .from(teamMembers)
  .where(eq(teamMembers.userId, user.id));
```

### Problem
These 2 queries run on **every** `/api/*` request for authenticated session users. User profile and team membership data changes infrequently (minutes to hours between changes) but is fetched every request (~100ms intervals during active use).

### Cost
- 2 queries per request × ~1-2ms each = ~2-4ms overhead per request
- For a session making 100 API calls: ~200-400ms total unnecessary I/O

### Fix
Add short-lived in-memory cache with user-scoped invalidation:

```typescript
const AUTH_CACHE = new Map<string, { data: AuthContextData; expiry: number }>();
const CACHE_TTL = 60_000; // 60 seconds

function getCachedAuthContext(userId: string): AuthContextData | null {
  const entry = AUTH_CACHE.get(userId);
  if (entry && entry.expiry > Date.now()) return entry.data;
  AUTH_CACHE.delete(userId);
  return null;
}

function setCachedAuthContext(userId: string, data: AuthContextData): void {
  AUTH_CACHE.set(userId, { data, expiry: Date.now() + CACHE_TTL });
}
```

Invalidate cache on membership changes (team join/leave/role update).

**Estimated savings**: Reduces 2 DB queries to 0 for ~98% of requests (cache hit rate).

---

## L5: Unpaginated Tag Listing

### Location
`src/server/routes/tags.ts:95-113`

### Problem
`GET /api/tags` returns all tags for a team without pagination. Combined with the 2N enrichment queries (H3), this creates compounding performance issues for teams with many tags.

### Risk
- 100 tags → 200 count queries + full result set serialization
- No upper bound on response size

### Fix
Add cursor-based pagination consistent with other list endpoints:

```typescript
const { teamId, cursor, limit: rawLimit } = c.req.query();
const limit = Math.min(Number(rawLimit) || 50, 100);

let query = db.select().from(tags).where(eq(tags.teamId, teamId));
if (cursor) {
  query = query.where(gt(tags.id, cursor));
}
query = query.orderBy(tags.id).limit(limit + 1);
```

---

## Performance Impact Matrix

| Fix | Effort | Latency Savings | Frequency |
|-----|--------|-----------------|-----------|
| H1: Eliminate duplicate lookup | Low | ~2-5ms/req | Every API token request |
| H2: GROUP BY team counts | Low | ~25-50ms/req | Every team list request |
| H3: GROUP BY tag counts | Low | ~50-100ms/req | Every tag list request |
| M7: Auth context cache | Medium | ~2-4ms/req | Every authenticated request |
| L5: Paginate tags | Low | Unbounded → bounded | Large tag sets only |

**Recommended implementation order**: H2 → H3 → H1 → M7 → L5 (highest impact per effort first).
