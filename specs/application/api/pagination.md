# API Pagination Specification

> **April 2026 update (theme 07 — F07-01):** This spec was rewritten to
> describe what the code actually does. Cursor pagination is the
> *canonical* style for new list endpoints. Three high-traffic routes
> (`/api/tasks`, `/api/sessions` global list, `/api/events/log`) have been
> migrated. The remaining list endpoints use offset pagination and are
> documented as the legacy style below; they can migrate opportunistically
> when their service methods are next touched.

## Overview

AgentPane uses two pagination styles. Endpoints pick one up front:

| Style | Default for | Envelope | Helper |
|-------|-------------|----------|--------|
| **Cursor** (canonical) | new list endpoints, real-time data, infinite scroll | `{ items, nextCursor, hasMore, totalCount? }` | `paginate<T>` in `src/lib/api/pagination.ts` |
| **Offset** (legacy) | admin reports, page jumping, static data | `{ items, limit, offset, total?, hasMore }` | `parseLimit` / `parseOffset` in `src/server/shared.ts` |

### When to use each

**Use cursor-based (default for anything new):**

- Real-time data streams (sessions, events)
- Infinite-scroll UIs
- Datasets >1000 rows
- Stable navigation through data that inserts/deletes mid-scroll

**Offset is acceptable when:**

- The client actually needs a `total` (filter-count badges)
- The client needs page-jumping (admin reports, export)
- The dataset is small and rarely changes

---

## Cursor style (canonical)

### Cursor format

Cursors are **opaque** base64-encoded JSON. Clients MUST treat them as
opaque strings. The server decodes, validates the embedded `sortField` and
`order`, and extracts the `(sortValue, id)` tuple for a compound tuple
comparison.

```ts
interface CursorPayload {
  id: string;
  sortValue: string | number | null;
  sortField: string;
  order: 'asc' | 'desc';
  version: 1;
}
```

See `src/lib/api/cursor.ts` for the encoder/decoder.

### Request

Clients send:

- `cursor` (optional) — opaque string returned by the previous response.
  Omit for the first page.
- `limit` (optional, default 50, max 100) — page size.
- any route-specific filters (`codespaceId`, `column`, `status`, …).

### Response

The canonical envelope:

```json
{
  "ok": true,
  "data": {
    "items": [...],
    "nextCursor": "…opaque…" | null,
    "hasMore": true | false,
    "totalCount": 123   // optional
  }
}
```

`nextCursor` is `null` when `hasMore === false`.

### Server-side helper

`src/lib/api/pagination.ts` exports:

```ts
import {
  decodeRequestCursor,
  paginate,
  type ListResponse,
} from '@/lib/api/pagination';

// 1. Decode — returns { ok: false, error: 'INVALID_CURSOR' } on
//    malformed/mismatched cursors.
const cursorResult = decodeRequestCursor(c.req.query('cursor'), {
  sortField: 'updatedAt',
  order: 'desc',
});
if (!cursorResult.ok) {
  return json({ ok: false, error: { code: 'INVALID_CURSOR', ... } }, 400);
}

// 2. Query `limit + 1` rows ordered by (sortField, id). When a cursor is
//    present, apply a compound tuple comparison.
const rows = await svc.list({
  limit: limit + 1,
  orderBy: 'updatedAt',
  orderDirection: 'desc',
  ...(cursorResult.value
    ? { cursor: { sortValue: cursorResult.value.sortValue, id: cursorResult.value.id } }
    : {}),
});

// 3. Build the canonical envelope.
const body = paginate(rows, { limit, sortField: 'updatedAt', order: 'desc' });
return json({ ok: true, data: body });
```

### Service-side query

Both `TaskService.list()` and `SessionCrudService.list()` accept an
optional `cursor: { sortValue, id }` field. When a cursor is present,
they:

1. Fetch `limit + 1` rows (so the route handler can detect `hasMore`).
2. Apply a compound tuple comparison:
   - **DESC:** `(sortCol < sortValue) OR (sortCol = sortValue AND id < cursorId)`
   - **ASC:**  `(sortCol > sortValue) OR (sortCol = sortValue AND id > cursorId)`
3. Order by `(sortCol, id)` matching the direction.

This guarantees stable ordering even when multiple rows share a
`sortValue` (e.g. duplicate timestamps).

### Migrated endpoints

| Endpoint | Sort field | Order |
|----------|-----------|-------|
| `GET /api/tasks` | `position` | `asc` |
| `GET /api/sessions` (no `codespaceId`) | `updatedAt` | `desc` |
| `GET /api/events/log` | `receivedAt` | `desc` |

`GET /api/sessions` with `codespaceId` keeps its offset shape because
the UI reads `total` for filter-count badges — see the Offset style
section below.

### Error: `INVALID_CURSOR`

Returned as 400 when:

- The cursor is not valid base64 / JSON
- The cursor payload fails schema validation
- The cursor version is incompatible
- The cursor's `sortField` / `order` does not match the route's fixed
  sort (e.g. a `position` cursor passed to the `updatedAt` route)

Client handling: reset pagination and start from the first page.

---

## Offset style (legacy)

Most existing list endpoints still use offset pagination. The envelope is
less uniform (some return `data: T[]` with a sibling `pagination`; others
nest everything under `data: { items, ... }`) but the standard accessors
are:

- `parseLimit(c, defaultLimit, maxLimit)` — `src/server/shared.ts`
- `parseOffset(c, defaultOffset)` — `src/server/shared.ts`

```json
{
  "ok": true,
  "data": [...],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 123,    // optional
    "hasMore": true
  }
}
```

### Known divergences (documented, not broken)

- `GET /api/memory/insights` returns `data: Insight[]` with no pagination
  envelope (small, finite list).
- `GET /api/teams/:id/members` returns `data: { items }` (non-paginated).
- `GET /api/codespaces` returns `data: { items, nextCursor: null,
  hasMore: false, totalCount }` — the cursor fields are present as a
  forward-compatibility placeholder but the endpoint does not yet fetch
  `limit + 1` rows.

These can migrate to cursor style when their service methods are next
touched; the canonical envelope is what new endpoints SHOULD emit.

---

## Client usage

### Cursor pagination with `useInfiniteQuery`

```ts
useInfiniteQuery({
  queryKey: ['tasks', codespaceId, column],
  queryFn: async ({ pageParam }) => {
    const qs = new URLSearchParams({ codespaceId, limit: '50' });
    if (column) qs.set('column', column);
    if (pageParam) qs.set('cursor', pageParam as string);
    const res = await fetch(`/api/tasks?${qs.toString()}`);
    return (await res.json()).data; // { items, nextCursor, hasMore }
  },
  initialPageParam: undefined,
  getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
});
```

### Offset pagination

Offset endpoints remain as they were — read `pagination.offset` /
`pagination.total` from the response and bump offset manually.

---

## Testing

- **Helper unit tests:**
  `src/lib/api/__tests__/paginate-helper.test.ts` (round-trip) and
  `src/lib/api/__tests__/pagination.test.ts` (`validateCursor`).
- **Cursor encoding:** `src/lib/api/__tests__/cursor.test.ts`.
- **Route tests:** `tests/api/tasks.test.ts` and
  `tests/api/sessions.test.ts` cover the migrated envelopes.

The helper round-trip test iterates through 100 simulated rows using
`paginate` + `decodeRequestCursor` and asserts no duplicates and no
skips, which is the F07-01 acceptance criterion.

---

## Cross-references

| Spec | Relationship |
|------|--------------|
| [API Endpoints](/specs/application/api/endpoints.md) | Per-endpoint details |
| [Database Schema](/specs/application/database/schema.md) | Compound indexes for `(sortCol, id)` |
| [Error Catalog](/specs/application/errors/error-catalog.md) | `INVALID_CURSOR` |
| [arch review F07-01](/specs/arch_review_april/07-api-surface.md#f07-01) | Remediation scope |
