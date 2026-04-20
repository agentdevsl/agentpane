/**
 * F09-02 seed test: `apiServerFetch<T>` response shape.
 *
 * Regression guard for the CLAUDE.md anti-pattern:
 *
 *   // Server returns: { ok: true, data: [...events...], pagination: {...} }
 *   // T is the type of the `data` field, NOT the full response:
 *   apiServerFetch<Array<{ id: string; type: string }>>('/api/sessions/x/events')
 *   // result.data = [...events...] (the array directly)
 *
 * We exercise the `createApiFetch` factory (the same closure that builds
 * `apiServerFetch`) with a mocked `fetch`, and assert that `.data` on the
 * returned envelope *is* the flat payload — not a re-wrapped
 * `{ data: ... }`. This catches the double-wrap bug on the client side,
 * complementing the server-side test in `tests/api/sessions.test.ts`.
 *
 * See `specs/arch_review_april/09-testing.md` F09-02.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiFetch } from '@/lib/api/client';

type EventRow = { id: string; type: string };

describe('createApiFetch — response shape contract', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns { ok: true, data: T } with data as the flat payload, not double-wrapped', async () => {
    const events: EventRow[] = [
      { id: 'evt-1', type: 'chunk' },
      { id: 'evt-2', type: 'tool' },
    ];
    // Mirror the actual API envelope shape on the wire.
    const wireResponse = {
      ok: true,
      data: events,
      pagination: { limit: 50, offset: 0, total: 2 },
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(wireResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const fetchFn = createApiFetch();
    const result = await fetchFn<EventRow[]>('/api/sessions/x/events');

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrowing
    // `data` is the array directly — NOT `{ data: [...] }`.
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toEqual(events);
    expect(result.data).toHaveLength(2);
    // Regression guard: if someone wraps `T` as `{ data: T }`, this assertion
    // would fail because the array has no `.data` property.
    expect((result.data as unknown as { data?: unknown }).data).toBeUndefined();
  });

  it('propagates ok: false from the server without re-wrapping', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Session not found' },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const fetchFn = createApiFetch();
    const result = await fetchFn<EventRow[]>('/api/sessions/missing/events');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(result.error.message).toBe('Session not found');
  });

  it('maps a network-level TypeError (e.g. connection refused) to NETWORK_ERROR', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('Failed to fetch')
    );

    const fetchFn = createApiFetch();
    const result = await fetchFn<EventRow[]>('/api/sessions/x/events');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK_ERROR');
  });

  it('prepends the configured baseUrl when provided', async () => {
    const spy = globalThis.fetch as ReturnType<typeof vi.fn>;
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { id: 'a' } }), { status: 200 })
    );

    const fetchFn = createApiFetch('http://localhost:3001');
    await fetchFn<{ id: string }>('/api/ping');

    expect(spy).toHaveBeenCalledWith(
      'http://localhost:3001/api/ping',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
