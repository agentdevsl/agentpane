import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sessions } from './sessions';

export const sessionSummaries = sqliteTable('session_summaries', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  sessionId: text('session_id')
    .notNull()
    .unique()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  durationMs: integer('duration_ms'),
  turnsCount: integer('turns_count').default(0),
  tokensUsed: integer('tokens_used').default(0),
  filesModified: integer('files_modified').default(0),
  linesAdded: integer('lines_added').default(0),
  linesRemoved: integer('lines_removed').default(0),
  finalStatus: text('final_status').$type<'success' | 'failed' | 'cancelled'>(),
  costUsd: real('cost_usd'),
  durationApiMs: integer('duration_api_ms'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheCreationTokens: integer('cache_creation_tokens'),
  stopReason: text('stop_reason'),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type SessionSummary = typeof sessionSummaries.$inferSelect;
export type NewSessionSummary = typeof sessionSummaries.$inferInsert;
