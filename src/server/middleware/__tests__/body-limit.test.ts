/**
 * @vitest-environment node
 *
 * Tests for the body-size limit middleware (`bodyLimit`) backing
 * F06-NEW-09 from the April 29 architecture review.
 *
 * Verifies:
 *  - 413 fast path when `Content-Length` exceeds the cap
 *  - allow path when `Content-Length` is at-or-under the cap
 *  - 413 slow path when chunked / unknown-length body exceeds the cap
 *  - methods without bodies (GET/HEAD/OPTIONS/DELETE) bypass the wrap
 *  - default cap is 5MB to match the spec
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { bodyLimit, DEFAULT_BODY_LIMIT_BYTES } from '../body-limit.js';

function createApp(maxBytes?: number) {
  const app = new Hono();
  app.use('/api/*', bodyLimit(maxBytes !== undefined ? { maxBytes } : undefined));
  app.post('/api/echo', async (c) => {
    const body = await c.req.text();
    return c.json({ ok: true, length: body.length });
  });
  app.get('/api/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('bodyLimit middleware', () => {
  it('exposes a 5MB default cap', () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(5 * 1024 * 1024);
  });

  describe('Content-Length fast path', () => {
    it('rejects with 413 when Content-Length exceeds the cap (6MB > 5MB default)', async () => {
      const app = createApp();
      const headers = new Headers({
        'Content-Type': 'application/json',
        'Content-Length': String(6 * 1024 * 1024),
      });
      // Note: we don't actually send the 6MB body — Content-Length alone
      // triggers the fast-path rejection before any read.
      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers,
          body: '{}',
        })
      );
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body).toEqual({
        ok: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: expect.stringContaining('byte limit'),
        },
      });
    });

    it('accepts a request whose Content-Length equals the cap', async () => {
      const cap = 1024;
      const app = createApp(cap);
      const payload = 'a'.repeat(cap);
      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(cap) },
          body: payload,
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, length: cap });
    });

    it('accepts a request whose Content-Length is below the cap', async () => {
      const app = createApp(1024);
      const payload = 'hello';
      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) },
          body: payload,
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, length: payload.length });
    });

    it('rejects when Content-Length is just over the cap (cap+1 bytes)', async () => {
      const cap = 1024;
      const app = createApp(cap);
      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Length': String(cap + 1) },
          body: 'a'.repeat(cap + 1),
        })
      );
      expect(res.status).toBe(413);
    });
  });

  describe('chunked / streaming path (no Content-Length)', () => {
    it('rejects with 413 when the streamed body exceeds the cap', async () => {
      const cap = 1024;
      const app = createApp(cap);

      // Build a streaming body of 2KB (above the 1KB cap). ReadableStream
      // forces the chunked path because we omit Content-Length.
      const chunk = new TextEncoder().encode('a'.repeat(512));
      let chunksRemaining = 4; // 4 * 512 = 2KB
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksRemaining === 0) {
            controller.close();
            return;
          }
          chunksRemaining -= 1;
          controller.enqueue(chunk);
        },
      });

      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: stream,
          // @ts-expect-error duplex is not yet in the standard RequestInit type
          duplex: 'half',
        })
      );

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('accepts a streamed body that stays under the cap', async () => {
      const cap = 1024;
      const app = createApp(cap);

      const chunk = new TextEncoder().encode('a'.repeat(256));
      let chunksRemaining = 2; // 2 * 256 = 512 (under cap)
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksRemaining === 0) {
            controller.close();
            return;
          }
          chunksRemaining -= 1;
          controller.enqueue(chunk);
        },
      });

      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: stream,
          // @ts-expect-error duplex is not yet in the standard RequestInit type
          duplex: 'half',
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, length: 512 });
    });
  });

  describe('method handling', () => {
    it('does not block GET requests (no body)', async () => {
      const app = createApp();
      const res = await app.fetch(
        new Request('http://localhost/api/ping', {
          method: 'GET',
        })
      );
      expect(res.status).toBe(200);
    });

    it('does not block GET requests even with bogus huge Content-Length', async () => {
      const app = createApp();
      const res = await app.fetch(
        new Request('http://localhost/api/ping', {
          method: 'GET',
          // GET requests with bodies are unusual; the middleware skips method
          // entirely so this should pass through.
          headers: { 'Content-Length': String(100 * 1024 * 1024) },
        })
      );
      expect(res.status).toBe(200);
    });
  });

  describe('error envelope', () => {
    it('returns the canonical { ok: false, error: { code, message } } shape', async () => {
      const app = createApp(100);
      const res = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Length': '500' },
          body: 'a'.repeat(500),
        })
      );
      expect(res.status).toBe(413);
      expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(typeof body.error.message).toBe('string');
    });
  });
});
