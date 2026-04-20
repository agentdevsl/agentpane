/**
 * Rate limiter middleware for Hono.
 *
 * F07-04: counters are keyed via a pluggable `keyFrom(ctx)` function that
 * prefers the authenticated user ID, falls back to the API token ID when
 * present, and finally falls back to the (trusted-proxy-aware) client IP
 * for unauthenticated requests.
 *
 * Storage is in-process (`Map`) for the default backend. Swapping in Redis
 * is a drop-in change: implement the tiny `RateLimitBackend` interface and
 * pass it in via `rateLimiter({ backend: redisBackend })`. The in-memory
 * backend logs a one-time warning on startup so multi-instance deployments
 * know they are running with per-instance counters until Redis is wired.
 *
 * IMPORTANT (AR-031): When running multiple app instances behind a load
 * balancer, the in-memory backend multiplies the effective limit by the
 * number of instances. Use a Redis-backed `RateLimitBackend` in production.
 */

import type { Context, Next } from 'hono';
import { createLogger } from '../logging/logger.js';
import type { AuthContext } from './auth-middleware.js';

const log = createLogger('RateLimiter');

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * F07-04: pluggable rate-limit backend interface. The default backend is
 * in-memory; a Redis backend can implement this interface verbatim using
 * `INCR` + `PEXPIRE` for atomic counter updates.
 */
export interface RateLimitBackend {
  /**
   * Record a request for `key` within a `windowMs` window. Returns the
   * current count within the window and the timestamp when the window
   * resets (ms since epoch).
   */
  incr(key: string, windowMs: number): Promise<RateLimitEntry>;
}

/**
 * SC-H2: Trusted proxy IPs for X-Forwarded-For parsing.
 * When behind a reverse proxy (e.g., Caddy), set TRUSTED_PROXIES to a comma-separated
 * list of proxy IPs. The rate limiter will use the last non-trusted IP from the
 * X-Forwarded-For chain, preventing IP spoofing attacks.
 *
 * Example: TRUSTED_PROXIES=127.0.0.1,10.0.0.1,172.16.0.1
 * Note: Only exact IP addresses are supported (no CIDR notation).
 */
const TRUSTED_PROXY_SET = new Set(
  (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * SC-H2: Extract the real client IP from X-Forwarded-For, accounting for trusted proxies.
 * When trusted proxies are configured, walks the XFF chain from right to left and returns
 * the first IP that is NOT a trusted proxy. When no trusted proxies are configured,
 * falls back to the socket remote address (via X-Real-IP or 'unknown').
 */
function extractClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');

  if (TRUSTED_PROXY_SET.size > 0 && xff) {
    // Walk from right (closest proxy) to left (original client)
    // filter(Boolean) removes empty strings from trailing commas/whitespace
    // which would otherwise cause unrelated requests to share a rate-limit bucket
    const ips = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ips.length > 0) {
      for (let i = ips.length - 1; i >= 0; i--) {
        const ip = ips[i];
        if (ip && !TRUSTED_PROXY_SET.has(ip)) {
          return ip;
        }
      }
      // All IPs are trusted proxies -- use the leftmost as fallback
      return ips[0] as string;
    }
  }

  // No trusted proxies configured or no XFF header:
  // X-Forwarded-For can be spoofed, so only use X-Real-IP (typically set by the proxy)
  // or fall back to 'unknown'
  return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * F07-04: derive a rate-limit key from the request context.
 *
 * Preference order:
 *  1. Authenticated user id     → `user:{userId}`
 *  2. API token id              → `token:{tokenId}`
 *  3. Trusted-proxy-aware IP    → `ip:{ip}`
 *
 * Routes can override this via `rateLimiter({ keyFrom: customFn })` to key
 * on e.g. a webhook source slug.
 */
export function defaultKeyFrom(c: Context): string {
  const auth = c.get('auth') as AuthContext | undefined;
  if (auth?.userId && auth.userId !== '') {
    return `user:${auth.userId}`;
  }
  if (auth?.tokenScope?.tokenId) {
    return `token:${auth.tokenScope.tokenId}`;
  }
  return `ip:${extractClientIp(c)}`;
}

/**
 * F07-04: token-only variant — used for the per-token limiter. Returns
 * `null` for non-token-authenticated requests so the limiter can short-
 * circuit (i.e. session/dev auth skip this stricter limit).
 */
export function tokenKeyFrom(c: Context): string | null {
  const auth = c.get('auth') as AuthContext | undefined;
  if (auth?.tokenScope?.tokenId) {
    return `token:${auth.tokenScope.tokenId}`;
  }
  return null;
}

// F07-04: log a one-time warning at startup when using the in-memory
// backend, so operators running multiple instances know counters don't
// cross instances.
let inMemoryWarningEmitted = false;
function warnInMemoryOnce(): void {
  if (inMemoryWarningEmitted) return;
  inMemoryWarningEmitted = true;
  log.warn(
    'Rate limiter using in-memory backend. In multi-instance deployments, effective limits are multiplied by the number of instances. Provide a Redis-backed RateLimitBackend for globally consistent limits.'
  );
}

// Module-level shared state: a single cleanup interval iterates all stores
const allStores: Map<string, RateLimitEntry>[] = [];
let cleanupStarted = false;

function ensureCleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const interval = setInterval(() => {
    const now = Date.now();
    for (const store of allStores) {
      for (const [key, entry] of store) {
        if (entry.resetAt <= now) {
          store.delete(key);
        }
      }
    }
  }, 60_000);
  interval.unref();
}

/**
 * F07-04: in-memory backend. Kept as the default so local dev and tests
 * don't require a running Redis. Export a Redis backend from this module
 * (or a plugin) to swap in with a one-line change.
 */
export function createInMemoryBackend(): RateLimitBackend {
  const store = new Map<string, RateLimitEntry>();
  allStores.push(store);
  ensureCleanup();
  warnInMemoryOnce();
  return {
    incr: async (key, windowMs) => {
      const now = Date.now();
      let entry = store.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        store.set(key, entry);
      }
      entry.count += 1;
      return entry;
    },
  };
}

export interface RateLimitOptions {
  /** Max requests per window (default: 100) */
  max?: number;
  /** Window size in milliseconds (default: 60_000 = 1 minute) */
  windowMs?: number;
  /**
   * When true, use the API token ID as the rate limiting key instead of the
   * default (user → token → IP) chain. Requires `enrichAuthContext` to have
   * populated `tokenScope`; session/dev auth requests are skipped so the
   * limiter only applies to programmatic API-token traffic.
   */
  keyOnToken?: boolean;
  /**
   * F07-04: override the default key derivation. Return `null` to skip
   * the limiter for this request (useful for auth-method-specific limits).
   */
  keyFrom?: (c: Context) => string | null;
  /**
   * F07-04: backend store. Defaults to a per-middleware in-memory map.
   * Inject a Redis-backed `RateLimitBackend` for multi-instance
   * deployments.
   */
  backend?: RateLimitBackend;
}

/**
 * Create a rate limiting middleware.
 *
 * @example
 * // Default: key on userId → tokenId → IP
 * app.use('/api/*', rateLimiter({ max: 200, windowMs: 60_000 }));
 *
 * @example
 * // Per-token rate limit (session/dev auth requests are skipped)
 * app.use('/api/*', rateLimiter({ max: 100, windowMs: 60_000, keyOnToken: true }));
 *
 * @example
 * // Redis backend (drop-in swap in production)
 * const redisBackend: RateLimitBackend = {
 *   async incr(key, windowMs) {
 *     const count = await redis.incr(`rl:${key}`);
 *     if (count === 1) await redis.pexpire(`rl:${key}`, windowMs);
 *     const ttl = await redis.pttl(`rl:${key}`);
 *     return { count, resetAt: Date.now() + ttl };
 *   },
 * };
 * app.use('/api/*', rateLimiter({ max: 200, windowMs: 60_000, backend: redisBackend }));
 */
export function rateLimiter(opts?: RateLimitOptions) {
  const max = opts?.max ?? 100;
  const windowMs = opts?.windowMs ?? 60_000;
  const keyOnToken = opts?.keyOnToken ?? false;
  const backend = opts?.backend ?? createInMemoryBackend();
  const keyFrom = opts?.keyFrom ?? (keyOnToken ? tokenKeyFrom : defaultKeyFrom);

  return async (c: Context, next: Next) => {
    const rateLimitKey = keyFrom(c);

    // F07-04: when keyFrom returns null (e.g. token-only limiter with a
    // session auth request), skip the limiter entirely.
    if (!rateLimitKey) {
      return next();
    }

    const entry = await backend.incr(rateLimitKey, windowMs);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
          },
        },
        429
      );
    }

    return next();
  };
}
