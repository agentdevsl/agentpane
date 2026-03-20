import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AgentStatus, AgentType } from '../shared/enums';
import type { AgentConfig } from '../shared/types';
import { projects } from './projects';
import { sessions } from './sessions';
import { tasks } from './tasks';

export type { AgentConfig };

export const agents = sqliteTable(
  'agents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<AgentType>().default('task').notNull(),
    status: text('status').$type<AgentStatus>().default('idle').notNull(),
    // DB-015: JSON columns are intentionally retained in the same table for simplicity.
    // Trade-off: slightly larger row sizes vs. avoiding JOINs for frequently-accessed data.
    // When querying lists, use explicit column selection (e.g., db.select({ id, name, status }))
    // to avoid deserializing large JSON blobs unnecessarily.
    config: text('config', { mode: 'json' }).$type<AgentConfig>(),
    // DB-013: Add FK references with onDelete: 'set null' to prevent dangling pointers.
    // Uses AnySQLiteColumn callback to break circular dependency (tasks/sessions reference agents).
    currentTaskId: text('current_task_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null',
    }),
    currentSessionId: text('current_session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    currentTurn: integer('current_turn').default(0),
    parentAgentId: text('parent_agent_id'),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now'))`)
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [index('idx_agents_project_id').on(table.projectId)]
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
