/**
 * Pagination helpers.
 *
 * F07-01: canonical cursor-based pagination support.
 *
 * Two surfaces:
 * - `validateCursor(cursor, options)` — decode + assert sortField/order match
 *   (kept for backwards compatibility with existing call sites).
 * - `paginate<T>(items, options)` — given a service result already pre-fetched
 *   with `limit + 1` (so callers can detect "more" without a count query),
 *   produce the canonical `ListResponse<T>` envelope:
 *
 *     { items: T[], nextCursor: string | null, hasMore: boolean, totalCount?: number }
 *
 *   plus optional helpers to decode a request cursor and re-derive a sort
 *   comparator pair `(sortValue, id)` for the DB query.
 *
 * Routes migrating to cursor pagination should:
 *   1. Call `decodeRequestCursor(cursor, {sortField, order})` to get the
 *      decoded payload or a 400 response.
 *   2. Query `limit + 1` rows ordered by `(sortField, id)` with the tuple
 *      comparator `(sortValue, id)` when a cursor is present.
 *   3. Call `paginate(rows, { limit, sortField, order })` to build the
 *      response body.
 *
 * Other list endpoints that still use offset pagination continue to work
 * unchanged — they are documented as the "legacy" style in
 * specs/application/api/pagination.md.
 */

import type { CursorPayload, CursorResult } from './cursor.js';
import { createCursor, decodeCursor } from './cursor.js';

// ---------------------------------------------------------------------------
// Legacy `validateCursor` — kept for any existing callers.
// ---------------------------------------------------------------------------

export type ValidateCursorOptions = {
  sortField: string;
  order: 'asc' | 'desc';
  maxAgeMs?: number;
};

export const validateCursor = (
  cursor: string,
  options: ValidateCursorOptions
): CursorResult<CursorPayload> => {
  const decoded = decodeCursor(cursor);
  if (!decoded.ok) {
    return decoded;
  }

  const payload = decoded.value;

  if (payload.sortField !== options.sortField || payload.order !== options.order) {
    return { ok: false, error: 'INVALID_CURSOR' };
  }

  return { ok: true, value: payload };
};

// ---------------------------------------------------------------------------
// F07-01: canonical `paginate` helper + request-cursor decoder.
// ---------------------------------------------------------------------------

/**
 * Canonical list response envelope for cursor-paginated routes.
 *
 * `data` fields at the route level should match this shape so clients can
 * share a single pagination helper regardless of endpoint.
 */
export interface ListResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Optional; some endpoints skip this for cost reasons. */
  totalCount?: number;
}

export interface PaginateOptions<T extends { id: string }> {
  /** Page size that the caller asked for. */
  limit: number;
  /**
   * Field used to sort. MUST match the cursor's `sortField` (if one was
   * supplied). The helper does not validate this — validate up front using
   * `decodeRequestCursor`.
   */
  sortField: keyof T & string;
  order: 'asc' | 'desc';
  /**
   * Optional total count for endpoints that can afford a count query.
   */
  totalCount?: number;
}

/**
 * Build a `ListResponse<T>` from a pre-fetched item array.
 *
 * The caller MUST query `limit + 1` rows so the helper can detect "more
 * pages" without a count query. Pass the array back unsliced — the helper
 * slices off the overflow row and uses it to generate the `nextCursor`.
 */
export function paginate<T extends { id: string }>(
  fetched: T[],
  options: PaginateOptions<T>
): ListResponse<T> {
  const { limit, sortField, order, totalCount } = options;
  const hasMore = fetched.length > limit;
  const items = hasMore ? fetched.slice(0, limit) : fetched;
  const nextCursor =
    hasMore && items.length > 0
      ? createCursor(items[items.length - 1] as T, sortField, order)
      : null;

  const response: ListResponse<T> = {
    items,
    nextCursor,
    hasMore,
  };
  if (totalCount !== undefined) {
    response.totalCount = totalCount;
  }
  return response;
}

/**
 * Decode a request cursor and return either the payload or a reason.
 * Callers can map `INVALID_CURSOR` to a 400 response.
 *
 * Returns `{ ok: true, value: null }` when no cursor was supplied
 * (first page). Returns `{ ok: false, error: 'INVALID_CURSOR' }` if the
 * cursor is malformed, tampered with, or references a different sort/order.
 */
export function decodeRequestCursor(
  cursor: string | undefined,
  options: { sortField: string; order: 'asc' | 'desc' }
): { ok: true; value: CursorPayload | null } | { ok: false; error: 'INVALID_CURSOR' } {
  if (!cursor) {
    return { ok: true, value: null };
  }
  const validated = validateCursor(cursor, options);
  if (!validated.ok) {
    return { ok: false, error: 'INVALID_CURSOR' };
  }
  return { ok: true, value: validated.value };
}
