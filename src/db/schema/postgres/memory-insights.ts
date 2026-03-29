import { createId } from '@paralleldrive/cuid2';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';
import { sessions } from './sessions';

export const memoryInsights = pgTable(
  'memory_insights',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    source: text('source').$type<'agent_derived' | 'manual' | 'dream'>().notNull(),
    sourceSessionId: text('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    skillId: text('skill_id'),
    tags: jsonb('tags').$type<string[]>().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_memory_insights_codespace_id').on(table.codespaceId),
    index('idx_memory_insights_skill_id').on(table.skillId),
    index('idx_memory_insights_source_session_id').on(table.sourceSessionId),
  ]
);

export type MemoryInsight = typeof memoryInsights.$inferSelect;
export type NewMemoryInsight = typeof memoryInsights.$inferInsert;
