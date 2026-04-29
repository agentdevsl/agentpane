/**
 * rate_limit_buckets — F06-NEW-08 (Postgres).
 *
 * Mirrors the SQLite schema. See `sqlite/rate-limit-buckets.ts` for full notes.
 */

import { bigint, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: text('key').notNull(),
    windowStart: bigint('window_start', { mode: 'number' }).notNull(),
    windowMs: bigint('window_ms', { mode: 'number' }).notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    index('rate_limit_buckets_updated_at_idx').on(table.updatedAt),
  ]
);

export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucketRow = typeof rateLimitBuckets.$inferInsert;
