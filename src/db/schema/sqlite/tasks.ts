import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ExitPlanModeOptions } from '../../../lib/agents/stream-handler';
import type { DiffSummary } from '../../../lib/types/diff';

/** Plan options stored on the task record, extending ExitPlanModeOptions with session context */
export interface StoredPlanOptions extends ExitPlanModeOptions {
  sdkSessionId?: string;
  planningSandboxId?: string;
}

import type { TaskColumn, TaskPriority } from '../shared/enums';
import { agents } from './agents';

export type { TaskColumn, TaskPriority } from '../shared/enums';

import { codespaces } from './codespaces';
import { sessions } from './sessions';
import { worktrees } from './worktrees';

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references((): AnySQLiteColumn => sessions.id, {
      onDelete: 'set null',
    }),
    worktreeId: text('worktree_id').references((): AnySQLiteColumn => worktrees.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    description: text('description'),
    column: text('column').$type<TaskColumn>().default('backlog').notNull(),
    position: integer('position').default(0).notNull(),
    labels: text('labels', { mode: 'json' }).$type<string[]>().default([]),
    priority: text('priority').$type<TaskPriority>().default('medium'),
    branch: text('branch'),
    diffSummary: text('diff_summary', { mode: 'json' }).$type<DiffSummary>(),
    approvedAt: text('approved_at'),
    approvedBy: text('approved_by'),
    rejectionCount: integer('rejection_count').default(0),
    rejectionReason: text('rejection_reason'),
    /** Model override for this task (short ID like 'claude-opus-4') */
    modelOverride: text('model_override'),
    /** Plan options from ExitPlanMode plus SDK session context */
    planOptions: text('plan_options', { mode: 'json' }).$type<StoredPlanOptions>(),
    /** The generated plan content */
    plan: text('plan'),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now'))`)
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    /** Status of the last agent run: completed, cancelled, error, turn_limit, planning */
    lastAgentStatus: text('last_agent_status').$type<
      'completed' | 'cancelled' | 'error' | 'turn_limit' | 'planning'
    >(),
  },
  (table) => [
    index('idx_tasks_agent_id').on(table.agentId),
    index('idx_tasks_kanban').on(table.codespaceId, table.column, table.position),
  ]
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
