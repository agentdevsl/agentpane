# Server Layer -- Development Guide

## Canonical Validation Approach (AR-011)

The project has converged on `parseJsonBody()` from `src/server/validation.ts` as the canonical
validation approach for API route handlers. This function combines JSON body parsing and Zod
schema validation into a single step with proper error handling.

### Usage Pattern

```typescript
import { createFooSchema, parseJsonBody } from '../validation.js';

app.post('/', async (c) => {
  const parsed = await parseJsonBody(c, createFooSchema);
  if (!parsed.ok) {
    return parsed.response; // Returns 400 with VALIDATION_ERROR
  }
  const body = parsed.data; // Fully typed from Zod schema
  // ... use body
});
```

### Schema Locations

- **Canonical schemas**: `src/server/validation.ts` -- Single source of truth for all
  server-side request schemas (tasks, agents, sessions, workflows, RBAC, templates,
  marketplace, settings, memory, terraform, etc.) and the `parseJsonBody` helper.
- **Route-inline schemas**: Some route files define one-off schemas inline with `z.object()`
  when the schema is route-specific and not shared.

> **Note (arch29-W2-P, F12-01)**: The previous `src/lib/api/schemas.ts` was deleted. It
> declared 41 schemas of which only 5 were imported and 5 names redeclared canonical
> server schemas with tighter limits, producing silent drift. New schemas must land in
> `src/server/validation.ts` (or inline in the route file if they are route-specific).

### Guidelines

1. **New routes**: Always use `parseJsonBody()` with a Zod schema.
2. **Existing routes**: Migrate from manual `await c.req.json()` + type assertion to `parseJsonBody()` when touching the code.
3. **Schema placement**: Put shared schemas in `src/server/validation.ts`; keep simple route-specific schemas inline in the route file. Do not recreate `src/lib/api/schemas.ts`.

## Pagination Helpers

- `parsePagination(c)` in `src/server/shared.ts` -- cursor-based pagination (cursor + limit clamped 1-100)
- `parseLimit(c, default, max)` in `src/server/shared.ts` -- standalone limit parsing with bounds checking
- Use these instead of inline `parseInt(c.req.query('limit') ?? '50', 10)` for consistency.

## RBAC Patterns

### Middleware-level guards (most routes)

Routes under `/api/*` use `requireRole()` middleware in `router.ts` to enforce minimum role.
The `useRoleGuard(app, path, role, rbacService)` helper reduces boilerplate by registering
both the base path and wildcard subpath guards.

### Handler-level guards (team routes)

Team routes (`/api/teams/*`) use handler-level RBAC via `requireTeamRole()` because they need
the team-specific role (from `:id` param), which is not available at middleware time.

### Intentionally unguarded routes

- `/api/me` -- User's own profile; any authenticated user can access.
- `/api/invitations` -- Invitation acceptance; user may not yet have any team role.
