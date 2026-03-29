/**
 * Simple in-memory rate limiter middleware for Hono.
 *
 * Uses a fixed window counter per IP address (default) or per API token.
 *
 * IMPORTANT (AR-031): This rate limiter stores counters in process memory.
 * In a multi-instance deployment (e.g., behind a load balancer), each instance
 * maintains its own counters independently, so the effective rate limit is
 * multiplied by the number of instances. For production multi-instance
 * deployments, replace with a Redis-backed rate limiter (e.g., @upstash/ratelimit
 * or a custom Redis INCR/EXPIRE pattern) to get globally consistent limits.
 *
 * TODO: Implement Redis-backed rate limiter for multi-instance production deployments.
 */

import type { Context, Next } from 'hono';
import type { AuthContext } from './auth-middleware.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
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
    const ips = xff.split(',').map((s) => s.trim());
    for (let i = ips.length - 1; i >= 0; i--) {
      if (!TRUSTED_PROXY_SET.has(ips[i])) {
        return ips[i];
      }
    }
    // All IPs are trusted proxies -- use the leftmost as fallback
    return ips[0];
  }

  // No trusted proxies configured or no XFF header:
  // X-Forwarded-For can be spoofed, so only use X-Real-IP (typically set by the proxy)
  // or fall back to 'unknown'
  return c.req.header('x-real-ip') ?? 'unknown';
}

export interface RateLimitOptions {
  /** Max requests per window (default: 100) */
  max?: number;
  /** Window size in milliseconds (default: 60_000 = 1 minute) */
  windowMs?: number;
  /**
   * When true, use the API token ID as the rate limiting key instead of IP.
   * Requires the auth context to be enriched (must run after enrichAuthContext middleware).
   * Falls back to skipping this limiter when no API token is present in the auth context.
   */
  keyOnToken?: boolean;
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
 * Create a rate limiting middleware.
 *
 * @example
 * // IP-based rate limiting (default)
 * app.use('/api/*', rateLimiter({ max: 100, windowMs: 60_000 }));
 *
 * // Per-token rate limiting (must run after enrichAuthContext)
 * app.use('/api/*', rateLimiter({ max: 100, windowMs: 60_000, keyOnToken: true }));
 */
export function rateLimiter(opts?: RateLimitOptions) {
  const max = opts?.max ?? 100;
  const windowMs = opts?.windowMs ?? 60_000;
  const keyOnToken = opts?.keyOnToken ?? false;

  const store = new Map<string, RateLimitEntry>();
  allStores.push(store);
  ensureCleanup();

  return async (c: Context, next: Next) => {
    let rateLimitKey: string | null = null;

    // When keyOnToken is enabled, try to use the API token ID as the key
    if (keyOnToken) {
      const auth = c.get('auth') as AuthContext | undefined;
      if (auth?.tokenScope?.tokenId) {
        rateLimitKey = `token:${auth.tokenScope.tokenId}`;
      }
    }

    // Fall back to IP-based key when no token key is available
    if (!rateLimitKey) {
      // If keyOnToken mode and no token present, skip this limiter entirely
      // (the request is not token-authenticated, so per-token limiting doesn't apply)
      if (keyOnToken) {
        return next();
      }

      // SC-H2: Use trusted proxy-aware IP extraction
      rateLimitKey = extractClientIp(c);
    }

    const now = Date.now();
    let entry = store.get(rateLimitKey);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(rateLimitKey, entry);
    }

    entry.count += 1;

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
