/**
 * F07-01: unit tests for the canonical `paginate<T>` helper.
 *
 * These are format-round-trip tests: they do NOT exercise the DB. A separate
 * integration test (`tests/api/cursor-pagination.test.ts`) covers end-to-end
 * cursor flow through the tasks/sessions/events routes against real service
 * results and asserts no duplicates / no skips across 100 rows.
 */

import { describe, expect, it } from 'vitest';
import { decodeCursor } from '../cursor.js';
import { decodeRequestCursor, paginate } from '../pagination.js';

type Row = { id: string; updatedAt: string };

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${String(i).padStart(3, '0')}`,
    // Descending timestamps so newest id == row-000.
    updatedAt: new Date(Date.UTC(2026, 0, n - i)).toISOString(),
  }));
}

describe('F07-01 paginate<T> helper', () => {
  describe('first page', () => {
    it('returns { items, nextCursor, hasMore: true } when overflow exists', () => {
      const fetched = makeRows(11); // limit+1
      const res = paginate(fetched, { limit: 10, sortField: 'updatedAt', order: 'desc' });
      expect(res.items).toHaveLength(10);
      expect(res.hasMore).toBe(true);
      expect(res.nextCursor).not.toBeNull();
    });

    it('returns hasMore: false + nextCursor: null when no overflow', () => {
      const fetched = makeRows(7);
      const res = paginate(fetched, { limit: 10, sortField: 'updatedAt', order: 'desc' });
      expect(res.items).toHaveLength(7);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeNull();
    });

    it('returns an empty result cleanly', () => {
      const res = paginate<Row>([], { limit: 10, sortField: 'updatedAt', order: 'desc' });
      expect(res.items).toEqual([]);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeNull();
    });
  });

  describe('cursor round-trip', () => {
    it('nextCursor decodes to the last item in the page', () => {
      const fetched = makeRows(11);
      const res = paginate(fetched, { limit: 10, sortField: 'updatedAt', order: 'desc' });
      expect(res.nextCursor).not.toBeNull();

      const decoded = decodeCursor(res.nextCursor as string);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.id).toBe(res.items[9]?.id);
        expect(decoded.value.sortField).toBe('updatedAt');
        expect(decoded.value.order).toBe('desc');
        expect(decoded.value.sortValue).toBe(res.items[9]?.updatedAt);
      }
    });

    it('decodeRequestCursor accepts a matching sortField/order', () => {
      const fetched = makeRows(11);
      const first = paginate(fetched, { limit: 10, sortField: 'updatedAt', order: 'desc' });
      const res = decodeRequestCursor(first.nextCursor ?? undefined, {
        sortField: 'updatedAt',
        order: 'desc',
      });
      expect(res.ok).toBe(true);
    });

    it('decodeRequestCursor rejects a mismatched sortField', () => {
      const fetched = makeRows(11);
      const first = paginate(fetched, { limit: 10, sortField: 'updatedAt', order: 'desc' });
      const res = decodeRequestCursor(first.nextCursor ?? undefined, {
        sortField: 'createdAt',
        order: 'desc',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('INVALID_CURSOR');
      }
    });

    it('decodeRequestCursor returns null value when no cursor supplied', () => {
      const res = decodeRequestCursor(undefined, { sortField: 'updatedAt', order: 'desc' });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBeNull();
      }
    });

    it('decodeRequestCursor rejects malformed cursors', () => {
      const res = decodeRequestCursor('not-a-cursor!!!', {
        sortField: 'updatedAt',
        order: 'desc',
      });
      expect(res.ok).toBe(false);
    });
  });

  describe('paginate through 100 rows — no dupes, no skips', () => {
    /**
     * F07-01 acceptance test: simulate paginating through 100 rows via
     * cursor, checking no duplicates + no skips.
     *
     * The "DB" is simulated by `fetchPage` which sorts by (updatedAt desc,
     * id desc) and applies the cursor's compound comparison.
     */
    function fetchPage(
      rows: Row[],
      limit: number,
      cursor?: { sortValue: string | number | null; id: string }
    ): Row[] {
      // Sort: updatedAt desc, id desc
      const sorted = [...rows].sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) {
          return b.updatedAt.localeCompare(a.updatedAt);
        }
        return b.id.localeCompare(a.id);
      });
      let filtered = sorted;
      if (cursor) {
        filtered = sorted.filter((r) => {
          if (r.updatedAt !== cursor.sortValue) {
            return r.updatedAt < (cursor.sortValue as string);
          }
          return r.id < cursor.id;
        });
      }
      return filtered.slice(0, limit + 1); // limit+1 for hasMore detection
    }

    it('iterates every row exactly once', () => {
      const rows = makeRows(100);
      const seen = new Set<string>();
      const duplicates: string[] = [];
      let cursor: string | undefined;
      let guard = 0;

      // Loop safety net: at most (100 / 10) * 2 = 20 iterations.
      while (guard++ < 25) {
        const request = decodeRequestCursor(cursor, {
          sortField: 'updatedAt',
          order: 'desc',
        });
        expect(request.ok).toBe(true);
        if (!request.ok) throw new Error('unreachable');

        const cursorPayload = request.value
          ? { sortValue: request.value.sortValue, id: request.value.id }
          : undefined;
        const fetched = fetchPage(rows, 10, cursorPayload);
        const page = paginate(fetched, { limit: 10, sortField: 'updatedAt', order: 'desc' });

        for (const item of page.items) {
          if (seen.has(item.id)) duplicates.push(item.id);
          seen.add(item.id);
        }

        if (!page.hasMore) break;
        cursor = page.nextCursor ?? undefined;
      }

      expect(duplicates).toEqual([]);
      expect(seen.size).toBe(100);
    });
  });
});
