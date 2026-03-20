# Server Layer -- Development Guide

## Canonical Validation Approach (AR-011)

The project has converged on `parseJsonBody()` from `src/server/validation.ts` as the canonical
validation approach for API route handlers. This function combines JSON body parsing and Zod
schema validation into a single step with proper error handling.

### Usage Pattern

```typescript
import { parseJsonBody } from '../validation.js';
import { createFooSchema } from '../../lib/api/schemas.js';

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

- **Centralized schemas**: `src/lib/api/schemas.ts` -- Contains shared schemas for workflows,
  templates, sandbox configs, sessions, settings, etc.
- **Route-local schemas**: `src/server/validation.ts` -- Contains RBAC-specific schemas
  (teams, members, invitations, tokens, tags) and the `parseJsonBody` helper.
- **Route-inline schemas**: Some route files (e.g., `projects.ts`) define schemas inline with `z.object()`.

### Guidelines

1. **New routes**: Always use `parseJsonBody()` with a Zod schema.
2. **Existing routes**: Migrate from manual `await c.req.json()` + type assertion to `parseJsonBody()` when touching the code.
3. **Schema placement**: Put schemas in `src/lib/api/schemas.ts` if they are complex or shared; keep simple inline schemas in the route file.

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
