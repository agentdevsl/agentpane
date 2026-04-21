import { expect } from 'vitest';

/**
 * Shared assertion helpers for list-endpoint response contracts.
 *
 * Catches the `apiServerFetch<T>` double-wrap bug: if a route returns
 * `{ ok: true, data: { data: [...], pagination: {...} } }` (double-nested)
 * instead of `{ ok: true, data: [...], pagination: {...} }` (sibling),
 * frontend consumers silently get `undefined` from `result.data.id`.
 *
 * See CLAUDE.md "API response types" section.
 */

/**
 * Assert the "siblings" response shape: `{ ok, data: T[], pagination: {...} }`.
 * Used for sessions and memory endpoints.
 */
export function assertFlatListShape(body: unknown): void {
  expect(body).toMatchObject({ ok: true });
  const asObj = body as { ok: boolean; data: unknown; pagination?: unknown };
  expect(Array.isArray(asObj.data)).toBe(true);
  expect(asObj.data).not.toHaveProperty('data');
  expect(asObj.data).not.toHaveProperty('pagination');
  if (asObj.pagination !== undefined) {
    expect(asObj.pagination).toEqual(expect.any(Object));
    expect(asObj.pagination).toHaveProperty('hasMore');
  }
}

/**
 * Assert the "cursor envelope" response shape:
 * `{ ok, data: { items: T[], nextCursor, hasMore } }`.
 * Used for events endpoints that need rich cursor metadata alongside items.
 */
export function assertCursorEnvelopeShape(body: unknown): void {
  expect(body).toMatchObject({ ok: true });
  const asObj = body as {
    ok: boolean;
    data: { items?: unknown; nextCursor?: unknown; hasMore?: unknown };
  };
  expect(asObj.data).toEqual(expect.any(Object));
  expect(Array.isArray(asObj.data.items)).toBe(true);
  expect(asObj.data).toHaveProperty('hasMore');
  expect(asObj.data).toHaveProperty('nextCursor');
}
