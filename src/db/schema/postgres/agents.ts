import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { AgentStatus, AgentType } from '../shared/enums';
import type { AgentConfig } from '../shared/types';
import { projects } from './projects';

export type { AgentConfig };

export const agents = pgTable('agents', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').$type<AgentType>().default('task').notNull(),
  status: text('status').$type<AgentStatus>().default('idle').notNull(),
  config: jsonb('config').$type<AgentConfig>(),
  currentTaskId: text('current_task_id'),
  currentSessionId: text('current_session_id'),
  currentTurn: integer('current_turn').default(0),
  parentAgentId: text('parent_agent_id'),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
