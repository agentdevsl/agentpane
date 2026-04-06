import { createId } from '@paralleldrive/cuid2';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { agentRuns } from './agent-runs';
import { codespaces } from './codespaces';
import { sessions } from './sessions';
import { tasks } from './tasks';

export const skillExecutions = pgTable(
  'skill_executions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').notNull(),
    skillName: text('skill_name'),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    status: text('status').$type<'success' | 'failed' | 'cancelled' | 'turn_limit'>().notNull(),
    turnsUsed: integer('turns_used'),
    tokensUsed: integer('tokens_used'),
    durationMs: integer('duration_ms'),
    durationApiMs: integer('duration_api_ms'),
    filesModified: integer('files_modified'),
    linesAdded: integer('lines_added'),
    linesRemoved: integer('lines_removed'),
    costUsd: doublePrecision('cost_usd'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { mode: 'string' }),
    completedAt: timestamp('completed_at', { mode: 'string' }),
    insightIdsUsed: jsonb('insight_ids_used').$type<string[]>(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_skill_executions_codespace_id').on(table.codespaceId),
    index('idx_skill_executions_skill_id').on(table.skillId),
    index('idx_skill_executions_task_id').on(table.taskId),
    index('idx_skill_executions_agent_run_id').on(table.agentRunId),
  ]
);

export type SkillExecution = typeof skillExecutions.$inferSelect;
export type NewSkillExecution = typeof skillExecutions.$inferInsert;
