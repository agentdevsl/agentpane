import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AgentStatus } from '../shared/enums';
import { agents } from './agents';
import { codespaces } from './codespaces';
import { sessions } from './sessions';
import { tasks } from './tasks';

export const agentRuns = sqliteTable(
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
    startedAt: text('started_at').default(sql`(datetime('now'))`).notNull(),
    completedAt: text('completed_at'),
    turnsUsed: integer('turns_used').default(0),
    tokensUsed: integer('tokens_used').default(0),
    errorMessage: text('error_message'),
  },
  // DB-009: Add indexes for agent_runs lookup by agentId, codespaceId, taskId
  (table) => [
    index('idx_agent_runs_agent_id').on(table.agentId),
    index('idx_agent_runs_codespace_id').on(table.codespaceId),
    index('idx_agent_runs_task_id').on(table.taskId),
  ]
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
