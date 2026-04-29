/**
 * Shared contract test for list endpoints.
 *
 * Catches the `apiServerFetch<T>` double-wrap bug: if a route returns
 * `{ ok: true, data: { data: [...], pagination: {...} } }` (double-nested)
 * instead of `{ ok: true, data: [...], pagination: {...} }` (sibling),
 * frontend consumers silently get `undefined` from `result.data.id`.
 *
 * Applies to every endpoint that returns a paginated list. See CLAUDE.md
 * "API response types" section.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { assertCursorEnvelopeShape, assertFlatListShape } from '../fixtures/list-contract';

// ---------------------------------------------------------------------------
// Sessions list endpoint — flat shape
// ---------------------------------------------------------------------------

const sessionServiceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  close: vi.fn(),
  delete: vi.fn(),
  getHistory: vi.fn(),
  getEventsBySession: vi.fn(),
  getSessionSummary: vi.fn(),
  subscribe: vi.fn(),
}));

import { createSessionsRoutes } from '../../src/server/routes/sessions';

const sampleSession: Session = {
  id: 'session-contract-1',
  codespaceId: 'proj-1',
  taskId: null,
  agentId: null,
  status: 'active',
  title: null,
  url: 'http://localhost:5173/sessions/session-contract-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  closedAt: null,
};

describe('List endpoint contract — sessions (flat shape)', () => {
  let app: ReturnType<typeof createSessionsRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createSessionsRoutes({ sessionService: sessionServiceMocks as never, db: {} as never });
    sessionServiceMocks.list.mockResolvedValue(ok([sampleSession]));
    sessionServiceMocks.getSessionSummary.mockResolvedValue(
      ok({ turnsCount: 0, tokensUsed: 0, filesModified: 0, linesAdded: 0, linesRemoved: 0 })
    );
  });

  it('GET / returns { ok, data: T[], pagination: { hasMore } }', async () => {
    const response = await app.request('http://localhost/');
    expect(response?.status).toBe(200);
    assertFlatListShape(await (response as Response).json());
  });

  it('GET / with empty result still passes the contract', async () => {
    sessionServiceMocks.list.mockResolvedValue(ok([]));
    const response = await app.request('http://localhost/');
    const body = await (response as Response).json();
    assertFlatListShape(body);
    expect((body as { data: unknown[] }).data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Contract-helper self-tests — regression guards on the shared assertions
// ---------------------------------------------------------------------------

describe('List endpoint contract shape helpers', () => {
  it('assertFlatListShape accepts valid flat responses', () => {
    expect(() =>
      assertFlatListShape({ ok: true, data: [{ id: 'a' }], pagination: { hasMore: false } })
    ).not.toThrow();
  });

  it('assertFlatListShape rejects double-wrapped responses', () => {
    expect(() =>
      assertFlatListShape({
        ok: true,
        data: { data: [{ id: 'a' }], pagination: { hasMore: false } },
      })
    ).toThrow();
  });

  it('assertFlatListShape rejects nested-items shape that has pagination inside data', () => {
    expect(() =>
      assertFlatListShape({
        ok: true,
        data: { items: [], pagination: { hasMore: false } },
      })
    ).toThrow();
  });

  it('assertCursorEnvelopeShape accepts { data: { items, nextCursor, hasMore } }', () => {
    expect(() =>
      assertCursorEnvelopeShape({
        ok: true,
        data: { items: [{ id: 'e1' }], nextCursor: null, hasMore: false },
      })
    ).not.toThrow();
  });

  it('assertCursorEnvelopeShape rejects flat shape', () => {
    expect(() =>
      assertCursorEnvelopeShape({ ok: true, data: [{ id: 'e1' }], pagination: { hasMore: false } })
    ).toThrow();
  });
});
