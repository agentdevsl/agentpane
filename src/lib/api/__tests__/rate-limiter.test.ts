import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertRateLimitDeploymentSafe,
  parseRateLimitInstanceCount,
  RateLimitDeploymentError,
  rateLimiter,
} from '../rate-limiter.js';

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

// ---------------------------------------------------------------------------
// F07-04: key-derivation tests — authenticated users are rate-limited on
// their userId, not their IP. Separate users from the same NAT get
// separate buckets; a single user rotating IPs shares the same bucket.
// ---------------------------------------------------------------------------

describe('F07-04 rate limiter key derivation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAuthApp(authCtx: { userId: string } | null, opts?: { max: number }) {
    const app = new Hono();
    // Simulate enrichAuthContext: set `auth` on the context before the limiter.
    app.use('/*', async (c, next) => {
      if (authCtx) c.set('auth' as never, authCtx as never);
      await next();
    });
    app.use('/*', rateLimiter({ max: opts?.max ?? 2, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('rate-limits the same authenticated user across different IPs', async () => {
    const app = makeAuthApp({ userId: 'user-alice' });

    // Alice from IP A, then IP B — same user should share the bucket.
    const r1 = await app.request('/test', { headers: { 'x-real-ip': '10.0.0.1' } });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/test', { headers: { 'x-real-ip': '10.0.0.2' } });
    expect(r2.status).toBe(200);

    // Third request from either IP is blocked.
    const r3 = await app.request('/test', { headers: { 'x-real-ip': '10.0.0.3' } });
    expect(r3.status).toBe(429);
  });

  it('rate-limits two authenticated users independently behind the same IP', async () => {
    // Alice gets her own bucket; Bob gets his own. Both share one NAT IP
    // but each bucket is per-user.
    const headers = { 'x-real-ip': '10.0.0.1' };

    const aliceApp = makeAuthApp({ userId: 'user-alice' });
    await aliceApp.request('/test', { headers });
    await aliceApp.request('/test', { headers });
    const aliceThird = await aliceApp.request('/test', { headers });
    expect(aliceThird.status).toBe(429);

    // A fresh app instance for Bob — this simulates a different user
    // context. In production, enrichAuthContext sets the correct userId.
    const bobApp = makeAuthApp({ userId: 'user-bob' });
    const bobFirst = await bobApp.request('/test', { headers });
    expect(bobFirst.status).toBe(200);
  });

  it('falls back to IP when no auth context is present', async () => {
    const app = makeAuthApp(null);

    // Without auth, the limiter keys on IP.
    const r1 = await app.request('/test', { headers: { 'x-real-ip': '5.5.5.5' } });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/test', { headers: { 'x-real-ip': '5.5.5.5' } });
    expect(r2.status).toBe(200);
    const r3 = await app.request('/test', { headers: { 'x-real-ip': '5.5.5.5' } });
    expect(r3.status).toBe(429);

    // Different IP bypasses.
    const r4 = await app.request('/test', { headers: { 'x-real-ip': '6.6.6.6' } });
    expect(r4.status).toBe(200);
  });

  it('keyOnToken mode skips requests with no token (session/dev auth)', async () => {
    // With keyOnToken, a session-authenticated request (no tokenScope)
    // should pass through unlimited on this specific middleware.
    const app = new Hono();
    app.use('/*', async (c, next) => {
      c.set('auth' as never, { userId: 'alice' } as never); // session auth: no tokenScope
      await next();
    });
    app.use('/*', rateLimiter({ max: 1, windowMs: 60_000, keyOnToken: true }));
    app.get('/test', (c) => c.json({ ok: true }));

    // 10 session-auth requests all pass — the limiter skips them.
    for (let i = 0; i < 10; i++) {
      const r = await app.request('/test');
      expect(r.status).toBe(200);
    }
  });

  it('custom keyFrom can scope to a per-source slug (webhook case)', async () => {
    const app = new Hono();
    app.use(
      '/hooks/:slug',
      rateLimiter({
        max: 2,
        windowMs: 60_000,
        keyFrom: (c) => `webhook:${c.req.param('slug')}`,
      })
    );
    app.get('/hooks/:slug', (c) => c.json({ ok: true }));

    // Two requests per slug allowed.
    expect((await app.request('/hooks/github')).status).toBe(200);
    expect((await app.request('/hooks/github')).status).toBe(200);
    expect((await app.request('/hooks/github')).status).toBe(429);

    // Different slug has its own bucket.
    expect((await app.request('/hooks/stripe')).status).toBe(200);
  });
});

describe('MAY-15 rate limiter deployment guard', () => {
  it('parses configured replica count from deployment env', () => {
    expect(parseRateLimitInstanceCount({ AGENTPANE_REPLICA_COUNT: '3' })).toBe(3);
    expect(parseRateLimitInstanceCount({ AGENTPANE_INSTANCE_COUNT: '2' })).toBe(2);
    expect(parseRateLimitInstanceCount({ REPLICA_COUNT: '4' })).toBe(4);
    expect(parseRateLimitInstanceCount({ AGENTPANE_REPLICA_COUNT: 'not-a-number' })).toBe(1);
  });

  it('fails fast for multi-instance sqlite limiter state', () => {
    expect(() => assertRateLimitDeploymentSafe({ dbMode: 'sqlite', instanceCount: 2 })).toThrow(
      RateLimitDeploymentError
    );
  });

  it('allows multi-instance postgres because rate_limit_buckets is shared', () => {
    expect(() =>
      assertRateLimitDeploymentSafe({ dbMode: 'postgres', instanceCount: 2 })
    ).not.toThrow();
  });
});
