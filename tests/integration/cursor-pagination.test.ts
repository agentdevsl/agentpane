/**
 * F07-01: end-to-end cursor-pagination integration tests.
 *
 * These tests exercise the real services (SessionCrudService, TaskService)
 * against the in-memory SQLite test database. They paginate through 100
 * rows using the compound `(sortValue, id)` cursor and assert:
 *   - every row appears exactly once (no skips, no duplicates)
 *   - the final page has `hasMore: false` and `nextCursor: null`
 *   - `INVALID_CURSOR` handling works (rejected at the decode layer)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRequestCursor, paginate } from '../../src/lib/api/pagination';
import { SessionCrudService } from '../../src/services/session/session-crud.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const BASE_URL = 'http://localhost:3000';

function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: vi.fn(),
    deleteStream: vi.fn().mockResolvedValue(true),
  };
}

function createMockWorktreeService() {
  return {
    getDiff: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };
}

describe('F07-01: cursor pagination end-to-end', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('TaskService.list() — 100 rows, page 10 at a time', () => {
    it('iterates every task exactly once via cursor', async () => {
      const codespace = await createTestProject();
      const taskService = new TaskService(db as never, createMockWorktreeService() as never);

      // Seed 100 tasks directly via the factory so each gets a unique
      // `position` (the default sort field for the tasks route) without
      // round-tripping through `TaskService.create`.
      for (let i = 0; i < 100; i++) {
        await createTestTask(codespace.id, {
          column: 'backlog',
          position: i,
          title: `Task ${String(i).padStart(3, '0')}`,
        });
      }

      // Walk the cursor.
      const seen = new Set<string>();
      const duplicates: string[] = [];
      let cursor: string | undefined;
      const pages: number[] = [];

      for (let guard = 0; guard < 25; guard++) {
        const cursorResult = decodeRequestCursor(cursor, {
          sortField: 'position',
          order: 'asc',
        });
        expect(cursorResult.ok).toBe(true);
        if (!cursorResult.ok) throw new Error('unreachable');

        const cursorPayload = cursorResult.value
          ? { sortValue: cursorResult.value.sortValue, id: cursorResult.value.id }
          : undefined;

        const result = await taskService.list(codespace.id, {
          limit: 11, // limit+1
          orderBy: 'position',
          orderDirection: 'asc',
          ...(cursorPayload ? { cursor: cursorPayload } : {}),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');

        const body = paginate(result.value, {
          limit: 10,
          sortField: 'position',
          order: 'asc',
        });
        pages.push(body.items.length);

        for (const item of body.items) {
          if (seen.has(item.id)) duplicates.push(item.id);
          seen.add(item.id);
        }

        if (!body.hasMore) {
          expect(body.nextCursor).toBeNull();
          break;
        }
        expect(body.nextCursor).not.toBeNull();
        cursor = body.nextCursor ?? undefined;
      }

      expect(duplicates).toEqual([]);
      expect(seen.size).toBe(100);
      // 10 pages of 10 rows each.
      expect(pages).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    });

    it('rejects a cursor whose sortField does not match the request', async () => {
      // A valid cursor for a different sort field.
      const cursor = Buffer.from(
        JSON.stringify({
          id: 'task-1',
          sortValue: 0,
          sortField: 'createdAt',
          order: 'asc',
          version: 1,
        }),
        'utf-8'
      )
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = decodeRequestCursor(cursor, { sortField: 'position', order: 'asc' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('INVALID_CURSOR');
      }
    });
  });

  describe('SessionCrudService.list() — 100 rows, page 10 at a time', () => {
    it('iterates every session exactly once via cursor (updatedAt desc)', async () => {
      const codespace = await createTestProject();
      const mockStreams = createMockStreams();
      const presenceStore = new Map<string, Map<string, never>>();
      const service = new SessionCrudService(
        db as never,
        mockStreams as never,
        { baseUrl: BASE_URL },
        presenceStore
      );

      // Seed 100 sessions via the service so `updatedAt` reflects real
      // inserts. Ties (same timestamp) are handled by the id tiebreaker.
      for (let i = 0; i < 100; i++) {
        const result = await service.create({
          codespaceId: codespace.id,
          title: `Session ${String(i).padStart(3, '0')}`,
        });
        expect(result.ok).toBe(true);
      }

      const seen = new Set<string>();
      const duplicates: string[] = [];
      let cursor: string | undefined;

      for (let guard = 0; guard < 25; guard++) {
        const cursorResult = decodeRequestCursor(cursor, {
          sortField: 'updatedAt',
          order: 'desc',
        });
        expect(cursorResult.ok).toBe(true);
        if (!cursorResult.ok) throw new Error('unreachable');

        const cursorPayload = cursorResult.value
          ? { sortValue: cursorResult.value.sortValue, id: cursorResult.value.id }
          : undefined;

        const result = await service.list({
          limit: 11,
          orderBy: 'updatedAt',
          orderDirection: 'desc',
          ...(cursorPayload ? { cursor: cursorPayload } : {}),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');

        const body = paginate(result.value, {
          limit: 10,
          sortField: 'updatedAt',
          order: 'desc',
        });

        for (const item of body.items) {
          if (seen.has(item.id)) duplicates.push(item.id);
          seen.add(item.id);
        }

        if (!body.hasMore) {
          expect(body.nextCursor).toBeNull();
          break;
        }
        cursor = body.nextCursor ?? undefined;
      }

      expect(duplicates).toEqual([]);
      expect(seen.size).toBe(100);
    });
  });
});
