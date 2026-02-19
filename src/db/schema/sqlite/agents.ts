import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AgentStatus, AgentType } from '../shared/enums';
import type { AgentConfig } from '../shared/types';
import { projects } from './projects';

export type { AgentConfig };

export const agents = sqliteTable('agents', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').$type<AgentType>().default('task').notNull(),
  status: text('status').$type<AgentStatus>().default('idle').notNull(),
  config: text('config', { mode: 'json' }).$type<AgentConfig>(),
  currentTaskId: text('current_task_id'),
  currentSessionId: text('current_session_id'),
  currentTurn: integer('current_turn').default(0),
  parentAgentId: text('parent_agent_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
