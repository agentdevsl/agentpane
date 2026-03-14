# Architecture Improvements

> Architectural analysis and refactoring recommendations for the RBAC implementation.

## Summary

| ID | Improvement | Effort | Impact |
|----|-------------|--------|--------|
| A1 | Extract `RbacTokenService` | Medium | Reduces `rbac-tokens.ts` from 470 → ~200 lines; centralizes business logic |
| A2 | Table-driven `requireTagAccess` | Medium | Reduces 210 → ~130 lines; eliminates brittle path matching |
| A3 | Consolidate role resolution helpers | Low | Removes duplication between `shared.ts` and `RbacService` |
| A4 | Standardize check-then-act transactions | Low | Prevents TOCTOU races consistently |
| A5 | Eliminate path-based resource detection | Medium | Prevents silent breakage on route reorganization |

---

## A1: Extract `RbacTokenService`

### Current State
Token CRUD logic lives inline in `src/server/routes/rbac-tokens.ts` (470 lines). The route file mixes HTTP concerns (request parsing, response formatting) with business logic (token generation, role ceiling enforcement, count limits, name uniqueness).

### Spec Reference
`tokens.md` lines 199-278 defines an `RbacTokenService` class with clear responsibilities.

### Proposed Structure

**Target**: `src/services/rbac-token.service.ts`

```typescript
export class RbacTokenService {
  constructor(private db: Database) {}

  /** Generate ap_-prefixed token with SHA-256 hash */
  generateToken(): { raw: string; hash: string; prefix: string }

  /** Validate token format against spec regex */
  isValidFormat(token: string): boolean

  /** Create token with all business validations (transactional) */
  async create(params: CreateTokenParams): Promise<CreateTokenResult>
  // Internally handles: name uniqueness, count limit, role ceiling,
  // scope validation, hash generation

  /** List tokens with pagination and optional admin mode */
  async list(params: ListTokenParams): Promise<PaginatedResult<TokenListItem>>

  /** Get token details with enriched scope tags */
  async getById(tokenId: string, userId: string): Promise<TokenDetail | null>

  /** Revoke a token (idempotent-safe) */
  async revoke(tokenId: string, userId: string): Promise<RevokeResult>

  /** Validate and resolve a raw token for middleware use */
  async resolveToken(rawToken: string): Promise<ResolvedToken | null>
}
```

### Benefits
- Route handler reduces to ~200 lines (HTTP glue only)
- Token logic testable without HTTP layer
- `resolveToken()` consolidates the duplicate lookup (fixes H1)
- Transaction boundary lives in the service where it belongs (fixes M1)

### Migration Path
1. Create `src/services/rbac-token.service.ts` with methods extracted from route handler
2. Update `rbac-tokens.ts` to delegate to service
3. Update `rbac-middleware.ts` to use `resolveToken()` instead of inline lookup
4. Add unit tests against service directly

---

## A2: Refactor `requireTagAccess` to Table-Driven Pattern

### Current State
`src/lib/api/rbac-middleware.ts:328-537` — 210 lines with 4 near-identical code blocks using `c.req.path.startsWith()` for resource type detection:

```typescript
// Block 1: Projects (lines 355-380)
if (path.startsWith('/api/projects/')) {
  const projectId = c.req.param('id');
  const projectTagRows = await db.select({tagId: projectTags.tagId})
    .from(projectTags).where(eq(projectTags.projectId, projectId));
  const resourceTagIds = projectTagRows.map(r => r.tagId);
  if (!scopeTags.some(t => resourceTagIds.includes(t))) { return 403; }
}

// Block 2: Tasks (lines 385-430) — similar but with project fallback
// Block 3: Sessions (lines 435-480) — similar but resolves via task
// Block 4: Agents (lines 485-530) — similar but resolves via project
```

### Problems
1. **Brittle path matching**: Breaks silently if routes are reorganized (e.g., `/api/v2/projects/`)
2. **Code duplication**: 4 blocks share the same "resolve tags → check overlap" pattern
3. **Hard to extend**: Adding a new resource type requires another 45-line block

### Proposed Refactoring

```typescript
type TagResolver = (id: string, db: Database) => Promise<string[]>;

const TAG_RESOLVERS: Record<string, TagResolver> = {
  project: async (id, db) => {
    const rows = await db.select({ tagId: projectTags.tagId })
      .from(projectTags).where(eq(projectTags.projectId, id));
    return rows.map(r => r.tagId);
  },
  task: async (id, db) => {
    const rows = await db.select({ tagId: taskTags.tagId })
      .from(taskTags).where(eq(taskTags.tagId, id));
    if (rows.length > 0) return rows.map(r => r.tagId);
    // Fallback to parent project tags
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    if (!task?.projectId) return [];
    return TAG_RESOLVERS.project(task.projectId, db);
  },
  session: async (id, db) => {
    const session = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    if (session?.taskId) return TAG_RESOLVERS.task(session.taskId, db);
    if (session?.projectId) return TAG_RESOLVERS.project(session.projectId, db);
    return [];
  },
  agent: async (id, db) => {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
    if (!agent?.projectId) return [];
    return TAG_RESOLVERS.project(agent.projectId, db);
  },
};

export function requireTagAccess(db: Database) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');
    const scopeTags = auth.tokenScope?.tags;
    if (!scopeTags?.length) return next();

    const resourceType = c.get('resourceType'); // Set by route handler
    const resourceId = c.req.param('id');

    if (!resourceType || !resourceId || !TAG_RESOLVERS[resourceType]) {
      return next();
    }

    const resourceTags = await TAG_RESOLVERS[resourceType](resourceId, db);

    // Deny if resource has no tags (invisible to tag-restricted tokens)
    if (resourceTags.length === 0) {
      return c.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Resource not accessible' } }, 403);
    }

    if (!scopeTags.some(t => resourceTags.includes(t))) {
      return c.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Token tags do not match' } }, 403);
    }

    return next();
  };
}
```

### Benefits
- **~210 → ~130 lines** (40% reduction)
- Eliminates path string matching (uses route metadata instead)
- Easy to add new resource types (one resolver function)
- Resolver functions are independently testable

---

## A3: Consolidate Role Resolution Helpers

### Current State
Role checking logic is split across three locations:

1. **`src/server/shared.ts:99-139`** — `requireTeamRole()` and `requireProjectRole()` helpers
2. **`src/services/rbac.service.ts:65-114`** — `resolveUserRole()`, `resolveTeamRole()`, `hasMinimumRole()`
3. **Route handlers** — Manual `rbacService.resolveTeamRole()` + level comparison

### Problem
- `shared.ts` helpers duplicate `RbacService` logic (both resolve roles and compare levels)
- Multiple routes call `rbacService.resolveTeamRole()` then manually compare with `RBAC_ROLE_LEVEL`
- Pattern: resolve role → check level → if insufficient return 403 → else continue with resolved role

### Proposed Consolidation

```typescript
// In RbacService
async requireTeamRole(
  userId: string,
  teamId: string,
  minimumRole: RbacRole
): Promise<{ ok: true; role: RbacRole } | { ok: false; status: 403 | 404 }> {
  const role = await this.resolveTeamRole(userId, teamId);
  if (!role) return { ok: false, status: 404 }; // non-member → 404
  if (!this.hasMinimumRole(role, minimumRole)) return { ok: false, status: 403 };
  return { ok: true, role };
}
```

Routes consume it cleanly:
```typescript
const result = await rbacService.requireTeamRole(auth.userId, teamId, 'admin');
if (!result.ok) return json({ ok: false, error: ... }, result.status);
const { role } = result; // Available for downstream use
```

### Benefits
- Single source of truth for role resolution + authorization
- Resolved role available for downstream use without re-querying
- `shared.ts` helpers become thin wrappers (or removed entirely)

---

## A4: Standardize Check-Then-Act Transactions

### Current State

| Operation | Transactional? | File |
|-----------|---------------|------|
| Team creation (slug uniqueness) | Yes | `teams.ts:50-100` |
| Ownership transfer | Yes | `teams.ts:305-355` |
| Last owner check (remove member) | Yes | `team-members.ts:290-360` |
| Token creation (name + count check) | **No** | `rbac-tokens.ts:128-188` |
| Invitation creation | **No** | `team-invitations.ts:30-110` |

### Problem
Teams correctly uses `db.transaction()` for check-then-act patterns, but tokens and invitations do not. This inconsistency means some paths are vulnerable to TOCTOU races while others aren't.

### Fix
Establish a project convention: **all check-then-act patterns must be transactional**.

Add to AGENTS.md or a coding conventions doc:
```
Rule: When a handler performs a uniqueness/limit check followed by an INSERT,
wrap both in db.transaction(). This prevents TOCTOU races from concurrent requests.
```

Apply to:
- `rbac-tokens.ts:128-188` — name uniqueness + count limit + insert
- `team-invitations.ts:30-110` — duplicate invitation check + existing member check + insert

---

## A5: Eliminate Path-Based Resource Detection

### Current State
`requireTagAccess` in `rbac-middleware.ts:355` uses `c.req.path.startsWith('/api/projects/')` to determine resource type. This is fragile — any route reorganization (versioning, nesting, aliasing) breaks tag access control **silently**.

### Proposed Pattern
Set route metadata in route handlers using Hono's context:

```typescript
// In route handler setup
app.get('/api/projects/:id', async (c) => {
  c.set('resourceType', 'project');
  // ... handler logic
});

app.get('/api/tasks/:id', async (c) => {
  c.set('resourceType', 'task');
  // ... handler logic
});
```

Or use a lightweight decorator middleware per route group:

```typescript
function tagResource(type: string) {
  return (c: Context, next: Next) => {
    c.set('resourceType', type);
    return next();
  };
}

// In router setup
app.use('/api/projects/:id/*', tagResource('project'));
app.use('/api/tasks/:id/*', tagResource('task'));
```

### Benefits
- Route metadata is explicit and co-located with route definitions
- Survives route reorganization
- Middleware reads structured data instead of parsing URL strings
- Combines naturally with A2 (table-driven tag resolvers)

---

## Architecture Dependency Graph

```
A5 (route metadata) ──→ A2 (table-driven tag access)
                              │
A4 (transactions) ────────→ A1 (RbacTokenService)
                              │
A3 (role helpers) ──────────┘
```

**Recommended implementation order**:
1. **A4** — Quick wins, fixes M1 directly
2. **A3** — Simplifies route handlers, reduces duplication
3. **A1** — Major refactor, enables better testing
4. **A5** → **A2** — Route metadata first, then table-driven middleware
