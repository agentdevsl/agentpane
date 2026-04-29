/**
 * rate_limit_buckets — F06-NEW-08.
 *
 * Persists rate-limit counters across process restarts. The previous in-memory
 * `Map`-backed limiter would reset every time the server restarted, which made
 * the limiter trivially bypassable on a deploy or crash. Each row represents a
 * single bucket: `(key, windowStart, count)`.
 *
 * The composite primary key on `(key, window_start)` ensures concurrent inserts
 * for the same bucket dedupe via `onConflictDoUpdate`. Cleanup of expired
 * buckets older than 24h runs as a {@link BackgroundJob} so the table is
 * bounded.
 *
 * Hard constraint: no Redis. SQLite + Drizzle is the only durable store
 * available and is sufficient for single-instance deployments. Multi-instance
 * deployments still suffer the same drift documented at `rate-limiter.ts:131`.
 */

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const rateLimitBuckets = sqliteTable(
  'rate_limit_buckets',
  {
    /** Bucket identifier (e.g. `user:abc`, `token:xyz`, `ip:1.2.3.4`). */
    key: text('key').notNull(),
    /** Window start timestamp in epoch ms. Buckets are quantised on this. */
    windowStart: integer('window_start').notNull(),
    /** Window length in ms (60_000 by default). Stored so cleanup can compute expiry. */
    windowMs: integer('window_ms').notNull(),
    /** Number of requests counted in this window. */
    count: integer('count').notNull().default(0),
    /** Epoch ms — set on every increment for cleanup ordering. */
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    index('rate_limit_buckets_updated_at_idx').on(table.updatedAt),
  ]
);

export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucketRow = typeof rateLimitBuckets.$inferInsert;
