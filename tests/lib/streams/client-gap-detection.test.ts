/**
 * F05-06: fetchGapEvents helper.
 * F05-15: StreamReconnectBanner component.
 *
 * Full SSE reconnect simulation lives behind DurableStreamTestServer and is
 * out of scope for a unit test; these tests verify the glue:
 *   1. fetchGapEvents posts the right query-string and parses the response.
 *   2. fetchGapEvents throws on non-ok responses and malformed bodies.
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchGapEvents, replayGapEventsToCallbacks } from '../../../src/lib/streams/client.js';

describe('fetchGapEvents (F05-06)', () => {
  it('requests the correct URL and parses data', async () => {
    const mockFetch = vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect(urlStr).toContain('/api/sessions/abc/events');
      expect(urlStr).toContain('fromOffset=5');
      expect(urlStr).toContain('toOffset=9');
      expect(urlStr).toContain('limit=5');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          ok: true,
          data: [{ id: 'e1', type: 'chunk', timestamp: 1, data: {} }],
        }),
      } as Response;
    });

    const events = await fetchGapEvents('abc', 5, 9, {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('e1');
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ ok: false }),
        }) as Response
    );
    await expect(
      fetchGapEvents('abc', 1, 2, { fetchImpl: mockFetch as unknown as typeof fetch })
    ).rejects.toThrow(/500/);
  });

  it('throws on malformed body', async () => {
    const mockFetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ ok: true, data: 'not-an-array' }),
        }) as Response
    );
    await expect(
      fetchGapEvents('abc', 1, 2, { fetchImpl: mockFetch as unknown as typeof fetch })
    ).rejects.toThrow(/malformed/i);
  });

  it('url-encodes the session id', async () => {
    const mockFetch = vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect(urlStr).toContain('/api/sessions/weird%2Fslash/events');
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, data: [] }),
      } as Response;
    });
    await fetchGapEvents('weird/slash', 0, 0, {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
  });

  it('replays fetched gap events through typed callbacks', () => {
    const onChunk = vi.fn();

    const result = replayGapEventsToCallbacks(
      [
        {
          id: 'e1',
          type: 'chunk',
          timestamp: 123,
          offset: 7,
          data: {
            text: 'recovered',
            agentId: 'agent-1',
            meta: {
              schemaVersion: 1,
              eventId: 'e1',
              streamId: 'abc',
              blockId: 'block-1',
              partType: 'chunk_end',
              durability: 'durable',
              sequence: null,
              createdAt: '2026-05-04T00:00:00.000Z',
            },
          },
        },
      ],
      { onChunk }
    );

    expect(result).toEqual({ delivered: 1, skipped: 0 });
    expect(onChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'chunks',
        cursor: '7',
        offset: 7,
        data: expect.objectContaining({ text: 'recovered' }),
      })
    );
  });
});
