import { createId } from '@paralleldrive/cuid2';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { AgentStatus, AgentType } from '../shared/enums';
import type { AgentConfig } from '../shared/types';
import { codespaces } from './codespaces';

export type { AgentConfig };

export const agents = pgTable(
  'agents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<AgentType>().default('task').notNull(),
    status: text('status').$type<AgentStatus>().default('idle').notNull(),
    config: jsonb('config').$type<AgentConfig>(),
    currentTaskId: text('current_task_id'),
    currentSessionId: text('current_session_id'),
    currentTurn: integer('current_turn').default(0),
    parentAgentId: text('parent_agent_id'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [index('idx_agents_codespace_id').on(table.codespaceId)]
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
