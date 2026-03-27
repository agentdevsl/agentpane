import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export const memoryMessages = pgTable('memory_messages', {
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
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
});

export type MemoryMessage = typeof memoryMessages.$inferSelect;
export type NewMemoryMessage = typeof memoryMessages.$inferInsert;
