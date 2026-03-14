# Test Coverage Analysis

> Test coverage gaps and implementation plan for the RBAC system.

## Current State

**RBAC-specific test coverage: 0%**

No test files exist for:
- RBAC service (`src/services/rbac.service.ts`)
- RBAC middleware (`src/lib/api/rbac-middleware.ts`)
- Team routes (`src/server/routes/teams.ts`)
- Token routes (`src/server/routes/rbac-tokens.ts`)
- Team member routes (`src/server/routes/team-members.ts`)
- Team invitation routes (`src/server/routes/team-invitations.ts`)
- Invitation accept route (`src/server/routes/invitation-accept.ts`)
- Project member routes (`src/server/routes/project-members.ts`)
- Tag routes (`src/server/routes/tags.ts`)

**Related tests that exist** (but don't cover RBAC):
- `tests/server/sse-token.test.ts` — SSE authentication
- `tests/services/github-token.service.test.ts` — GitHub OAuth tokens

The spec (`middleware.md` lines 687-737) defines 20+ unit tests and 7+ integration tests that are unimplemented.

---

## Required Test Infrastructure

### Test Factories

Create `tests/factories/rbac.ts`:

```typescript
import { createId } from '@paralleldrive/cuid2';

export function createTestUser(overrides?: Partial<User>) {
  return {
    id: createId(),
    githubId: Math.floor(Math.random() * 1000000),
    githubLogin: `user-${createId().slice(0, 8)}`,
    name: 'Test User',
    email: `test-${createId().slice(0, 8)}@example.com`,
    avatarUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestTeam(overrides?: Partial<Team>) {
  return {
    id: createId(),
    name: 'Test Team',
    slug: `test-team-${createId().slice(0, 8)}`,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestMembership(overrides?: Partial<TeamMember>) {
  return {
    teamId: createId(),
    userId: createId(),
    role: 'viewer' as RbacRole,
    joinedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestToken(overrides?: Partial<ApiToken>) {
  return {
    id: createId(),
    userId: createId(),
    teamId: createId(),
    name: `token-${createId().slice(0, 8)}`,
    tokenHash: 'sha256_hash_placeholder',
    tokenPrefix: 'ap_testprefix',
    role: 'viewer' as RbacRole,
    scopeTags: null,
    scopeProjectId: null,
    status: 'active' as const,
    expiresAt: null,
    useCount: 0,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestInvitation(overrides?: Partial<TeamInvitation>) {
  return {
    id: createId(),
    teamId: createId(),
    invitedBy: createId(),
    email: `invite-${createId().slice(0, 8)}@example.com`,
    role: 'viewer' as RbacRole,
    token: `inv_${createId()}`,
    status: 'pending' as const,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestTag(overrides?: Partial<Tag>) {
  return {
    id: createId(),
    teamId: createId(),
    name: `tag-${createId().slice(0, 8)}`,
    color: '#6B7280',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
```

### Test Helpers

Create `tests/helpers/rbac.ts`:

```typescript
import { createHash } from 'node:crypto';

/** Create an authenticated request with session cookie */
export function authedRequest(userId: string, sessionToken: string) {
  return {
    headers: { Cookie: `session=${sessionToken}` },
    userId,
  };
}

/** Create an API token-authenticated request */
export function tokenRequest(rawToken: string) {
  return {
    headers: { Authorization: `Bearer ${rawToken}` },
  };
}

/** Generate a valid ap_ token and its hash */
export function generateTestToken() {
  const raw = `ap_${'A'.repeat(43)}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.substring(0, 12) };
}

/** Assert role level ordering */
export function assertRoleLevelOrder(roles: RbacRole[]) {
  const levels = roles.map(r => RBAC_ROLE_LEVEL[r]);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
  }
}

/** Seed a complete team with owner, admin, operator, and viewer */
export async function seedTeamWithMembers(db: Database) {
  const team = createTestTeam();
  const owner = createTestUser({ name: 'Owner' });
  const admin = createTestUser({ name: 'Admin' });
  const operator = createTestUser({ name: 'Operator' });
  const viewer = createTestUser({ name: 'Viewer' });

  await db.insert(users).values([owner, admin, operator, viewer]);
  await db.insert(teams).values(team);
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: owner.id, role: 'owner' },
    { teamId: team.id, userId: admin.id, role: 'admin' },
    { teamId: team.id, userId: operator.id, role: 'agent_operator' },
    { teamId: team.id, userId: viewer.id, role: 'viewer' },
  ]);

  return { team, owner, admin, operator, viewer };
}
```

---

## Required Test Files

### Priority 0 (Security-Critical)

#### `tests/services/rbac.service.test.ts` (~25 tests)

| # | Test Case | Category |
|---|-----------|----------|
| 1 | `resolveUserRole` returns direct project override when present | Role resolution |
| 2 | `resolveUserRole` falls back to team role via team_projects when no override | Role resolution |
| 3 | `resolveUserRole` returns null for non-member | Role resolution |
| 4 | `resolveUserRole` prefers project override over team role | Role resolution |
| 5 | `resolveTeamRole` returns correct role for team member | Role resolution |
| 6 | `resolveTeamRole` returns null for non-member | Role resolution |
| 7 | `resolveGlobalRole` returns highest role across all teams | Role resolution |
| 8 | `resolveGlobalRole` returns null for user with no teams | Role resolution |
| 9 | `hasMinimumRole` correctly compares all role pairs | Authorization |
| 10 | `hasMinimumRole` returns true when roles are equal | Authorization |
| 11 | `hasMinimumRole` returns false when role is below minimum | Authorization |
| 12 | `applyTokenCeiling` returns minimum of membership and token role | Token ceiling |
| 13 | `applyTokenCeiling` returns token role when lower than membership | Token ceiling |
| 14 | `applyTokenCeiling` returns membership role when lower than token | Token ceiling |
| 15 | `applyTokenCeiling` handles equal roles | Token ceiling |
| 16 | `checkTagAccess` returns true when token has no tag restrictions | Tag access |
| 17 | `checkTagAccess` returns true when token and resource tags overlap | Tag access |
| 18 | `checkTagAccess` returns false when no tag overlap | Tag access |
| 19 | `checkTagAccess` returns false when resource has no tags (deny untagged) | Tag access |
| 20 | `checkProjectScope` returns true when token has no project restriction | Project scope |
| 21 | `checkProjectScope` returns true when project IDs match | Project scope |
| 22 | `checkProjectScope` returns false when project IDs differ | Project scope |
| 23 | Permission map includes correct permissions for viewer role | Permission map |
| 24 | Permission map includes correct permissions for agent_operator role | Permission map |
| 25 | Permission map includes correct permissions for admin and owner roles | Permission map |

#### `tests/lib/rbac-middleware.test.ts` (~20 tests)

| # | Test Case | Category |
|---|-----------|----------|
| 1 | `enrichAuthContext` grants owner role in dev mode | Dev mode |
| 2 | `enrichAuthContext` loads user record and team memberships | Session auth |
| 3 | `enrichAuthContext` returns 401 when user record not found | Session auth |
| 4 | `enrichAuthContext` resolves highest global role across teams | Session auth |
| 5 | `enrichAuthContext` resolves token scope for API token auth | Token auth |
| 6 | `enrichAuthContext` applies token ceiling to membership role | Token auth |
| 7 | `enrichAuthContext` rejects invalid token format | Token auth |
| 8 | `enrichAuthContext` rejects expired token and updates status | Token auth |
| 9 | `enrichAuthContext` increments useCount asynchronously | Token auth |
| 10 | `requireRole` allows request when role meets minimum | Role guard |
| 11 | `requireRole` denies request when role is below minimum | Role guard |
| 12 | `requireRole` resolves project-specific role via rbacService | Role guard |
| 13 | `requireRole` applies token ceiling when token scope present | Role guard |
| 14 | `requireRole` denies when token not scoped for requested project | Role guard |
| 15 | `requireTagAccess` allows request when token has no tag restrictions | Tag access |
| 16 | `requireTagAccess` allows request when tags overlap | Tag access |
| 17 | `requireTagAccess` denies request when no tag overlap | Tag access |
| 18 | `requireTagAccess` denies request for untagged resources | Tag access |
| 19 | `requireTagAccess` resolves task tags with project fallback | Tag access |
| 20 | `requireTagAccess` resolves session tags via task chain | Tag access |

### Priority 1 (Feature Correctness)

#### `tests/api/teams.test.ts` (~15 tests)

| # | Test Case |
|---|-----------|
| 1 | POST /api/teams creates team and adds creator as owner |
| 2 | POST /api/teams rejects duplicate slug |
| 3 | POST /api/teams auto-generates slug from name |
| 4 | GET /api/teams returns user's teams with member counts |
| 5 | GET /api/teams returns empty list for user with no teams |
| 6 | GET /api/teams paginates correctly with cursor |
| 7 | GET /api/teams/:id returns team details with myRole |
| 8 | GET /api/teams/:id returns 404 for non-existent team |
| 9 | PATCH /api/teams/:id updates team (admin required) |
| 10 | PATCH /api/teams/:id rejects viewer/operator |
| 11 | POST /api/teams/:id/transfer-ownership transfers to valid member |
| 12 | POST /api/teams/:id/transfer-ownership rejects non-owner |
| 13 | POST /api/teams/:id/transfer-ownership rejects non-member target |
| 14 | DELETE /api/teams/:id cascades correctly |
| 15 | DELETE /api/teams/:id rejects non-owner |

#### `tests/api/rbac-tokens.test.ts` (~15 tests)

| # | Test Case |
|---|-----------|
| 1 | POST /api/tokens creates token with valid scope |
| 2 | POST /api/tokens enforces role ceiling |
| 3 | POST /api/tokens rejects duplicate name (non-revoked) |
| 4 | POST /api/tokens enforces 25-token limit |
| 5 | POST /api/tokens validates scopeProjectId belongs to team |
| 6 | POST /api/tokens validates scopeTags belong to team |
| 7 | POST /api/tokens returns raw token only once |
| 8 | GET /api/tokens lists user's tokens with pagination |
| 9 | GET /api/tokens supports team admin listing (allTeam) |
| 10 | GET /api/tokens filters by status |
| 11 | GET /api/tokens/:id returns token details with enriched tags |
| 12 | GET /api/tokens/:id rejects access to other user's token |
| 13 | DELETE /api/tokens/:id revokes active token |
| 14 | DELETE /api/tokens/:id returns 409 for already-revoked token |
| 15 | Token format matches regex: /^ap_[A-Za-z0-9_-]{42,44}$/ |

#### `tests/api/team-members.test.ts` (~10 tests)

| # | Test Case |
|---|-----------|
| 1 | POST /api/teams/:id/members adds member with role |
| 2 | POST /api/teams/:id/members rejects duplicate membership |
| 3 | GET /api/teams/:id/members lists members with user details |
| 4 | GET /api/teams/:id/members paginates correctly |
| 5 | PATCH /api/teams/:id/members/:uid updates role |
| 6 | PATCH /api/teams/:id/members/:uid prevents self-role-change |
| 7 | PATCH /api/teams/:id/members/:uid prevents admin assigning admin |
| 8 | PATCH /api/teams/:id/members/:uid prevents demoting last owner |
| 9 | DELETE /api/teams/:id/members/:uid removes member |
| 10 | DELETE /api/teams/:id/members/:uid prevents removing last owner |

#### `tests/api/team-invitations.test.ts` (~8 tests)

| # | Test Case |
|---|-----------|
| 1 | POST /api/teams/:id/invitations creates invitation |
| 2 | POST /api/teams/:id/invitations rejects duplicate pending invitation |
| 3 | POST /api/teams/:id/invitations rejects existing member email |
| 4 | GET /api/teams/:id/invitations lists pending invitations |
| 5 | POST /api/invitations/:token/accept accepts valid invitation |
| 6 | POST /api/invitations/:token/accept rejects expired invitation |
| 7 | POST /api/invitations/:token/accept rejects email mismatch (fail-closed) |
| 8 | POST /api/teams/:id/invitations/:iid/decline declines own invitation |

### Priority 2 (Completeness)

#### `tests/api/project-members.test.ts` (~6 tests)

| # | Test Case |
|---|-----------|
| 1 | POST /api/projects/:id/members adds project-level override |
| 2 | GET /api/projects/:id/members lists direct overrides |
| 3 | PATCH /api/projects/:id/members/:uid updates role |
| 4 | DELETE /api/projects/:id/members/:uid removes override |
| 5 | DELETE /api/projects/:id/members/:uid returns revertedToTeamRole |
| 6 | Project override takes precedence over team role in resolution |

#### `tests/api/tags.test.ts` (~8 tests)

| # | Test Case |
|---|-----------|
| 1 | POST /api/tags creates team tag |
| 2 | GET /api/tags lists tags with project/task counts |
| 3 | DELETE /api/tags/:id cascades to project_tags and task_tags |
| 4 | POST /api/projects/:id/tags assigns tag (validates team ownership) |
| 5 | DELETE /api/projects/:id/tags/:tagId removes tag assignment |
| 6 | POST /api/tasks/:id/tags assigns tag (validates via project team) |
| 7 | DELETE /api/tasks/:id/tags/:tagId removes tag assignment |
| 8 | Tag assignment rejects tags from different team |

#### `tests/db/schema/rbac-schema.test.ts` (~12 tests)

| # | Test Case |
|---|-----------|
| 1 | teams table enforces unique slug |
| 2 | team_members composite PK (teamId, userId) prevents duplicates |
| 3 | api_tokens enforces unique tokenHash |
| 4 | tags enforces unique (teamId, name) |
| 5 | project_tags composite PK prevents duplicate assignments |
| 6 | task_tags composite PK prevents duplicate assignments |
| 7 | Foreign key: team_members.teamId references teams.id |
| 8 | Foreign key: api_tokens.teamId references teams.id |
| 9 | Foreign key: project_members.projectId references projects.id |
| 10 | Default values: role defaults to 'viewer' |
| 11 | Default values: status defaults to 'active'/'pending' |
| 12 | RBAC_ROLE_LEVEL ordering: viewer < agent_operator < admin < owner |

---

## Test Coverage Targets

| Component | Current | Target | Tests |
|-----------|---------|--------|-------|
| RbacService | 0% | 95% | 25 |
| RBAC Middleware | 0% | 90% | 20 |
| Team Routes | 0% | 85% | 15 |
| Token Routes | 0% | 85% | 15 |
| Member Routes | 0% | 80% | 10 |
| Invitation Routes | 0% | 80% | 8 |
| Project Members | 0% | 75% | 6 |
| Tags Routes | 0% | 75% | 8 |
| Schema | 0% | 70% | 12 |
| **Total** | **0%** | **~85%** | **~119** |

---

## Critical Test Scenarios (Must-Have)

These 7 scenarios represent the most security-critical paths:

1. **Role resolution priority**: project override > team membership > deny
2. **Token ceiling**: effective_role = min(membership_role, token_role)
3. **Tag access for untagged resources**: deny when token has tag restrictions
4. **Last owner protection**: cannot demote or remove the last team owner
5. **Self-demotion prevention**: users cannot change their own role
6. **Token expiry lazy-update**: expired token is rejected and status updated
7. **Admin role assignment ceiling**: admin cannot assign admin or owner roles

---

## Implementation Notes

### Test Database Setup
Use in-memory SQLite for test speed:
```typescript
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

function createTestDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  // Run migrations
  return db;
}
```

### Test Isolation
Each test should:
1. Create a fresh in-memory database (or use transactions with rollback)
2. Seed only the data needed for that test
3. Clean up after itself

### Mocking Strategy
- **Database**: Use real in-memory SQLite (no mocking ORM)
- **Hono context**: Use `hono/testing` helpers or construct minimal context objects
- **External services**: Mock with Vitest's `vi.mock()`
- **Time**: Use `vi.useFakeTimers()` for expiry tests
