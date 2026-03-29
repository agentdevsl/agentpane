import { createId } from '@paralleldrive/cuid2';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { AgentStatus } from '../shared/enums';
import { agents } from './agents';
import { codespaces } from './codespaces';
import { sessions } from './sessions';
import { tasks } from './tasks';

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    status: text('status').$type<AgentStatus>().notNull(),
    startedAt: timestamp('started_at', { mode: 'string' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'string' }),
    turnsUsed: integer('turns_used').default(0),
    tokensUsed: integer('tokens_used').default(0),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_agent_runs_agent_id').on(table.agentId),
    index('idx_agent_runs_codespace_id').on(table.codespaceId),
    index('idx_agent_runs_task_id').on(table.taskId),
  ]
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
