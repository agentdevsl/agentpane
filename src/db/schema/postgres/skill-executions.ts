import { createId } from '@paralleldrive/cuid2';
import { doublePrecision, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { agentRuns } from './agent-runs';
import { codespaces } from './codespaces';
import { sessions } from './sessions';
import { tasks } from './tasks';

export const skillExecutions = pgTable('skill_executions', {
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
  filesModified: integer('files_modified'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  costUsd: doublePrecision('cost_usd'),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { mode: 'string' }),
  completedAt: timestamp('completed_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
});

export type SkillExecution = typeof skillExecutions.$inferSelect;
export type NewSkillExecution = typeof skillExecutions.$inferInsert;
