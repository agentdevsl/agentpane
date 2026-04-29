/**
 * Rate limiter middleware for Hono.
 *
 * F07-04: counters are keyed via a pluggable `keyFrom(ctx)` function that
 * prefers the authenticated user ID, falls back to the API token ID when
 * present, and finally falls back to the (trusted-proxy-aware) client IP
 * for unauthenticated requests.
 *
 * F06-NEW-08: persistence backends.
 *   - `createInMemoryBackend()` — default for tests / dev. Counters reset on
 *     restart, so do not use in production.
 *   - `createSqliteBackend(db)` — persists buckets in the `rate_limit_buckets`
 *     Drizzle table. Counters survive process restarts so a deploy or crash
 *     no longer grants every limited client a fresh quota. Uses `INSERT ...
 *     ON CONFLICT DO UPDATE` for atomic per-tick increment.
 *
 * Hard constraint: no Redis, no external infrastructure. Multi-instance
 * deployments still suffer the documented drift at `:131-141` because each
 * process owns its own SQLite file; for hosted multi-instance, a follow-up
 * is needed to share state. Single-instance is the supported topology.
 */

import { lt, sql } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { rateLimitBuckets } from '../../db/schema/sqlite/rate-limit-buckets.js';
import type { Database } from '../../types/database.js';
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

/**
 * F06-NEW-08: SQLite-backed rate-limit backend.
 *
 * Each rate-limit window is persisted as a row in `rate_limit_buckets`. The
 * window-start timestamp quantises the bucket: every request inside the same
 * window upserts the same `(key, windowStart)` row, atomically incrementing
 * `count` via Drizzle's `onConflictDoUpdate`. On process restart the rows
 * persist, so a client that exceeded the limit before the restart is still
 * blocked for the remainder of the window.
 *
 * Drizzle-only — no raw SQL. Per-tick latency adds one upsert; the composite
 * primary key on `(key, window_start)` makes this an O(log n) write. The
 * cleanup job (see {@link createRateLimitCleanupJob}) trims expired rows
 * older than 24h so the table stays bounded.
 *
 * Caveats:
 *   - Multi-instance deployments still drift because each process writes to
 *     its own SQLite file (per the hard "no Redis" constraint). The single
 *     supported topology is single-instance. Hosted multi-instance is a
 *     follow-up; the architectural note at `:131-141` still applies.
 *   - The window is *aligned*, not *sliding* — `windowStart = floor(now /
 *     windowMs) * windowMs`. A burst that crosses a window boundary may
 *     temporarily exceed the soft cap by 2x just like the in-memory limiter.
 *     This matches the original Map-backed semantics; a sliding window would
 *     require a different schema (rolling sum or token bucket).
 */
export function createSqliteBackend(db: Database): RateLimitBackend {
  return {
    incr: async (key, windowMs) => {
      const now = Date.now();
      // Align the bucket to the windowMs boundary so the same window
      // accumulates into a single row regardless of when the request hits.
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;

      // Drizzle-only upsert: insert a fresh row for a new bucket, or atomically
      // bump count + updatedAt for an existing one. The composite primary key
      // (key, windowStart) guarantees per-bucket dedupe under concurrent
      // requests. `count + 1` runs server-side so two concurrent inserts can
      // never lose an increment.
      const inserted = await db
        .insert(rateLimitBuckets)
        .values({
          key,
          windowStart,
          windowMs,
          count: 1,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
          set: {
            count: sql`${rateLimitBuckets.count} + 1`,
            updatedAt: now,
          },
        })
        .returning({ count: rateLimitBuckets.count });

      const count = inserted[0]?.count ?? 1;
      return { count, resetAt };
    },
  };
}

/**
 * F06-NEW-08: BackgroundJob that periodically deletes expired rate-limit
 * rows. Kept as a standalone job so it can register with the existing
 * {@link import('../background/job.js').BackgroundJobRegistry} alongside
 * EventCleanup, EventOutboxRelay, etc.
 *
 * Cleanup policy: rows whose window ended >24h ago are deleted. The 24h
 * grace period is generous — a 1-minute window's row is "expired" the
 * moment `windowStart + windowMs < now`, but we keep them around for the
 * same period as a session-event retention floor so audit queries can see
 * "did this IP get rate-limited yesterday?".
 */
const CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface RateLimitCleanupJob {
  readonly name: string;
  start(): void;
  stop(): void;
  /** Run a single cleanup pass synchronously — useful in tests. */
  runOnce(): Promise<number>;
  healthSnapshot(): { name: string; running: boolean; lastRunAt?: string; lastError?: string };
}

export function createRateLimitCleanupJob(db: Database): RateLimitCleanupJob {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastRunAt: string | null = null;
  let lastError: string | null = null;

  async function runOnce(): Promise<number> {
    const cutoff = Date.now() - CLEANUP_RETENTION_MS;
    try {
      // Delete rows whose window ended (windowStart + windowMs) before the cutoff.
      // We compare on `updatedAt` because it always points at the most recent
      // touch; an idle bucket will not be re-touched and is safe to prune.
      const result = await db
        .delete(rateLimitBuckets)
        .where(lt(rateLimitBuckets.updatedAt, cutoff))
        .returning({ key: rateLimitBuckets.key });
      lastRunAt = new Date().toISOString();
      lastError = null;
      return result.length;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn('Rate-limit cleanup failed', { data: { error: lastError } });
      return 0;
    }
  }

  return {
    name: 'rateLimitCleanup',
    start() {
      if (running) return;
      running = true;
      // First sweep happens on a delay so we don't stall the boot phase.
      timer = setInterval(() => {
        void runOnce();
      }, CLEANUP_INTERVAL_MS);
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
    healthSnapshot() {
      return {
        name: 'rateLimitCleanup',
        running,
        lastRunAt: lastRunAt ?? undefined,
        lastError: lastError ?? undefined,
      };
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
