import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SessionStatus } from '../shared/enums';
import { agents } from './agents';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'set null' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    status: text('status').$type<SessionStatus>().default('idle').notNull(),
    title: text('title'),
    url: text('url').notNull(),
    sandboxProvider: text('sandbox_provider'),
    sandboxContainerId: text('sandbox_container_id'),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now'))`)
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
    closedAt: text('closed_at'),
  },
  // DB-009: Add index on codespaceId for codespace-scoped session lookups
  (table) => [index('idx_sessions_codespace_id').on(table.codespaceId)]
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
