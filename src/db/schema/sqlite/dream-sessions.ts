import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';

export const dreamSessions = sqliteTable(
  'dream_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id').references(() => codespaces.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<'conclusion_derivation' | 'skill_improvement' | 'metrics_rollup'>()
      .notNull(),
    status: text('status').$type<'running' | 'completed' | 'error'>().notNull(),
    skillsAnalyzed: integer('skills_analyzed').default(0).notNull(),
    suggestionsGenerated: integer('suggestions_generated').default(0).notNull(),
    tokensUsed: integer('tokens_used').default(0).notNull(),
    costUsd: real('cost_usd'),
    startedAt: text('started_at').default(sql`(datetime('now'))`).notNull(),
    completedAt: text('completed_at'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    index('idx_dream_sessions_codespace_id').on(table.codespaceId),
    index('idx_dream_sessions_status').on(table.status),
  ]
);

export type DreamSession = typeof dreamSessions.$inferSelect;
export type NewDreamSession = typeof dreamSessions.$inferInsert;
