import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';
import { sessions } from './sessions';

export const memoryInsights = sqliteTable(
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
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    status: text('status')
      .$type<'active' | 'pending_review' | 'rejected'>()
      .default('active')
      .notNull(),
    category: text('category').$type<
      'pattern' | 'anti_pattern' | 'decision' | 'architecture' | 'error_lesson'
    >(),
    updatedAt: text('updated_at'),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    index('idx_memory_insights_codespace_id').on(table.codespaceId),
    index('idx_memory_insights_skill_id').on(table.skillId),
    index('idx_memory_insights_source_session_id').on(table.sourceSessionId),
    index('idx_memory_insights_status').on(table.status),
  ]
);

export type MemoryInsight = typeof memoryInsights.$inferSelect;
export type NewMemoryInsight = typeof memoryInsights.$inferInsert;
