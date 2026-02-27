# RBAC Implementation Review

> **Branch**: `feature/rbac`
> **Date**: 2026-02-27
> **Scope**: 9 spec documents vs 16 implementation files (~3,968 lines)

## Executive Summary

The RBAC implementation is architecturally sound with solid security fundamentals (SHA-256 token hashing, token ceiling, fail-closed invitation validation, transactional ownership transfer). However, the review identified **34 issues** across 4 severity levels, including a token validation logic bug, spec contradictions, zero test coverage, and multiple N+1 query patterns.

## Issue Breakdown

| Severity | Count | Key Themes |
|----------|-------|------------|
| **CRITICAL** | 4 | Spec contradictions, token validation bug, zero test coverage, rate limit mismatch |
| **HIGH** | 10 | Missing response fields, N+1 queries, duplicate DB lookups, missing filters |
| **MEDIUM** | 13 | TOCTOU races, inconsistent errors, missing abstractions, spec deviations |
| **LOW** | 7 | Status codes, audit logging, minor field mismatches |

## Review Documents

| Document | Contents |
|----------|----------|
| [gaps.md](./gaps.md) | Spec-vs-implementation gap analysis (all 34 issues with file/line references) |
| [security.md](./security.md) | Security findings (C1, C4, M1, M5, M6, L6, and existing hardening) |
| [performance.md](./performance.md) | Performance issues (H1-H3, M7, L5, with fix patterns) |
| [architecture.md](./architecture.md) | Architecture improvements (A1-A5, service extraction, refactoring) |
| [test-coverage.md](./test-coverage.md) | Test coverage analysis (~85+ tests needed, prioritized plan) |

## Priority Fix Order

### Phase 1: Security & Correctness (P0)
1. **C4** — Fix token format validation logic bug (`&&` → regex)
2. **C1** — Update `middleware.md` to resolve spec contradiction on untagged resources
3. **M1** — Wrap token creation in transaction (TOCTOU fix)
4. **M5** — Add query-level tag filtering for list endpoints
5. **L6** — Return 404 instead of 403 for non-member team access

### Phase 2: Spec Alignment (P1)
6. **C2** — Update `api-endpoints.md`: `member` → `agent_operator`
7. **H10** — Reconcile per-token rate limit (100 vs 200)
8. **M8** — Update `tokens.md`: `expiresAt` → `expiresInDays`
9. **M11** — Update `tokens.md`: `scopeProjectIds` → `scopeProjectId`
10. **M13** — Add `transfer-ownership` and `decline` endpoints to spec

### Phase 3: Performance & Features (P1)
11. **H1** — Eliminate duplicate token DB lookup in middleware chain
12. **H2** — Fix N+1 team member count query with GROUP BY
13. **H3** — Fix N+1 tag count queries with GROUP BY
14. **H4** — Add `effectiveRole` to project members response
15. **H5-H8** — Add missing search/filter params and response fields

### Phase 4: Tests (P0, parallel with Phase 1-3)
16. **C3** — Implement RBAC test suite (~85+ tests) — see [test-coverage.md](./test-coverage.md)

### Phase 5: Architecture (P2)
17. **A1** — Extract `RbacTokenService`
18. **A2** — Refactor `requireTagAccess` to table-driven pattern
19. **A3-A5** — Consolidate helpers, standardize transactions

## Files Modified in RBAC

| File | Lines | Role |
|------|-------|------|
| `src/lib/api/rbac-middleware.ts` | 537 | Auth enrichment, role guards, tag access |
| `src/services/rbac.service.ts` | 157 | Permission resolution engine |
| `src/server/routes/rbac-tokens.ts` | 470 | API token CRUD |
| `src/server/routes/teams.ts` | 413 | Team management |
| `src/server/routes/team-members.ts` | 369 | Membership management |
| `src/server/routes/team-invitations.ts` | 268 | Invitation system |
| `src/server/routes/invitation-accept.ts` | 159 | Invitation acceptance |
| `src/server/routes/project-members.ts` | 229 | Project role overrides |
| `src/server/routes/tags.ts` | 408 | Tag CRUD and assignment |
| `src/server/routes/me.ts` | 140 | User profile |
| `src/server/router.ts` | 361 | Middleware chain, route mounting |
| `src/server/validation.ts` | 249 | Zod schemas |
| `src/server/shared.ts` | 171 | Role check helpers |
| `src/db/schema/sqlite/*.ts` | ~150 | 11 schema tables |
| `src/db/schema/shared/enums.ts` | 91 | Role enums and levels |

## Spec Updates Required

| Spec File | Changes |
|-----------|---------|
| `api-endpoints.md` | Replace `member` → `agent_operator`; add 2 missing endpoints |
| `middleware.md` | Fix untagged resource access to deny (match `tags.md`) |
| `tokens.md` | `expiresAt` → `expiresInDays`; `scopeProjectIds` → `scopeProjectId`; prefix 10 → 12 |

## Verification Checklist

After implementing fixes:

- [ ] `npm run typecheck` — all TypeScript compiles
- [ ] `npm test` — all existing tests pass
- [ ] New RBAC test suite — all pass
- [ ] Manual: create team → add member → create token → verify token ceiling
- [ ] Manual: create tag-scoped token → verify untagged resources denied
- [ ] Manual: attempt self-demotion as last owner → blocked
- [ ] Load test: `GET /api/teams` with 50+ teams → no N+1 queries in logs
