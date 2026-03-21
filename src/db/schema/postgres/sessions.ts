import { createId } from '@paralleldrive/cuid2';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { SessionStatus } from '../shared/enums';
import { agents } from './agents';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export const sessions = pgTable('sessions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  codespaceId: text('codespace_id')
    .notNull()
    .references(() => codespaces.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  status: text('status').$type<SessionStatus>().default('idle').notNull(),
  title: text('title'),
  url: text('url').notNull(),
  sandboxProvider: text('sandbox_provider'),
  sandboxContainerId: text('sandbox_container_id'),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
  closedAt: timestamp('closed_at', { mode: 'string' }),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
