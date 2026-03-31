import { createId } from '@paralleldrive/cuid2';
import { doublePrecision, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';

export const dreamSessions = pgTable(
  'dream_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id').references(() => codespaces.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<
        'conclusion_derivation' | 'skill_improvement' | 'metrics_rollup' | 'context_optimization'
      >()
      .notNull(),
    status: text('status').$type<'running' | 'completed' | 'error'>().notNull(),
    skillsAnalyzed: integer('skills_analyzed').default(0).notNull(),
    suggestionsGenerated: integer('suggestions_generated').default(0).notNull(),
    tokensUsed: integer('tokens_used').default(0).notNull(),
    costUsd: doublePrecision('cost_usd'),
    startedAt: timestamp('started_at', { mode: 'string' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'string' }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_dream_sessions_codespace_id').on(table.codespaceId),
    index('idx_dream_sessions_status').on(table.status),
  ]
);

export type DreamSession = typeof dreamSessions.$inferSelect;
export type NewDreamSession = typeof dreamSessions.$inferInsert;
