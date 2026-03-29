import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimiter } from '../rate-limiter.js';

function createApp(opts?: Parameters<typeof rateLimiter>[0]) {
  const app = new Hono();
  app.use('/*', rateLimiter(opts));
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

function req(app: Hono, headers?: Record<string, string>) {
  return app.request('/test', {
    headers: headers ?? {},
  });
}

describe('rateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes requests under the limit', async () => {
    const app = createApp({ max: 3, windowMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      const res = await req(app);
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when requests exceed the limit', async () => {
    const app = createApp({ max: 2, windowMs: 60_000 });

    // First two pass
    await req(app);
    await req(app);

    // Third should be rate limited
    const res = await req(app);
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    });
  });

  it('resets the counter after the window expires', async () => {
    const app = createApp({ max: 1, windowMs: 10_000 });

    // Use up the limit
    const first = await req(app);
    expect(first.status).toBe(200);

    const blocked = await req(app);
    expect(blocked.status).toBe(429);

    // Advance past the window
    vi.advanceTimersByTime(10_001);

    const afterReset = await req(app);
    expect(afterReset.status).toBe(200);
  });

  it('includes rate limit headers on successful responses', async () => {
    const app = createApp({ max: 5, windowMs: 60_000 });

    const res = await req(app);

    expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('includes rate limit headers on 429 responses', async () => {
    const app = createApp({ max: 1, windowMs: 60_000 });

    await req(app);
    const res = await req(app);

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('decrements remaining count with each request', async () => {
    const app = createApp({ max: 3, windowMs: 60_000 });

    const r1 = await req(app);
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('2');

    const r2 = await req(app);
    expect(r2.headers.get('X-RateLimit-Remaining')).toBe('1');

    const r3 = await req(app);
    expect(r3.headers.get('X-RateLimit-Remaining')).toBe('0');

    // Over limit: remaining stays at 0
    const r4 = await req(app);
    expect(r4.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('tracks separate rateLimiter instances independently', async () => {
    const app = new Hono();
    app.use('/a/*', rateLimiter({ max: 1, windowMs: 60_000 }));
    app.use('/b/*', rateLimiter({ max: 1, windowMs: 60_000 }));
    app.get('/a/test', (c) => c.json({ ok: true }));
    app.get('/b/test', (c) => c.json({ ok: true }));

    // Exhaust limit on route A
    const a1 = await app.request('/a/test');
    expect(a1.status).toBe(200);

    const a2 = await app.request('/a/test');
    expect(a2.status).toBe(429);

    // Route B should still work (separate store)
    const b1 = await app.request('/b/test');
    expect(b1.status).toBe(200);
  });

  it('tracks different IPs separately via x-real-ip', async () => {
    const app = createApp({ max: 1, windowMs: 60_000 });

    const res1 = await req(app, { 'x-real-ip': '1.1.1.1' });
    expect(res1.status).toBe(200);

    // Same IP should be blocked
    const res2 = await req(app, { 'x-real-ip': '1.1.1.1' });
    expect(res2.status).toBe(429);

    // Different IP should pass
    const res3 = await req(app, { 'x-real-ip': '2.2.2.2' });
    expect(res3.status).toBe(200);
  });

  it('uses x-forwarded-for when trusted proxies are configured', async () => {
    // Set trusted proxies for this test
    const original = process.env.TRUSTED_PROXIES;
    process.env.TRUSTED_PROXIES = '192.168.1.1,172.16.0.1';

    // Re-import to pick up the new env var
    vi.resetModules();
    const { rateLimiter: freshLimiter } = await import('../rate-limiter.js');

    const app = new Hono();
    app.use('/*', freshLimiter({ max: 1, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // First request from client IP 10.0.0.1 (via trusted proxy 192.168.1.1)
    const res1 = await req(app, { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' });
    expect(res1.status).toBe(200);

    // Same client IP should be blocked
    const res2 = await req(app, { 'x-forwarded-for': '10.0.0.1, 172.16.0.1' });
    expect(res2.status).toBe(429);

    // Different client IP should pass
    const res3 = await req(app, { 'x-forwarded-for': '10.0.0.2, 192.168.1.1' });
    expect(res3.status).toBe(200);

    // Restore env
    if (original === undefined) {
      delete process.env.TRUSTED_PROXIES;
    } else {
      process.env.TRUSTED_PROXIES = original;
    }
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    const app = createApp({ max: 1, windowMs: 60_000 });

    const res1 = await req(app, { 'x-real-ip': '3.3.3.3' });
    expect(res1.status).toBe(200);

    const res2 = await req(app, { 'x-real-ip': '3.3.3.3' });
    expect(res2.status).toBe(429);
  });

  it('uses default options when none provided', async () => {
    const app = createApp();

    // Default max is 100, so 100 requests should pass
    for (let i = 0; i < 100; i++) {
      const res = await req(app);
      expect(res.status).toBe(200);
    }

    // 101st should be rate limited
    const res = await req(app);
    expect(res.status).toBe(429);
  });
});
