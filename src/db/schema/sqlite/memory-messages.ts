import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export const memoryMessages = sqliteTable(
  'memory_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    memorySessionId: text('memory_session_id').notNull(),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    turnNumber: integer('turn_number').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    index('idx_memory_messages_codespace_id').on(table.codespaceId),
    index('idx_memory_messages_memory_session_id').on(table.memorySessionId),
    index('idx_memory_messages_task_id').on(table.taskId),
  ]
);

export type MemoryMessage = typeof memoryMessages.$inferSelect;
export type NewMemoryMessage = typeof memoryMessages.$inferInsert;
