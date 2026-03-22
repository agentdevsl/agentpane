import { createId } from '@paralleldrive/cuid2';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { ExitPlanModeOptions } from '../../../lib/agents/stream-handler';
import type { DiffSummary } from '../../../lib/types/diff';

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

export const tasks = pgTable('tasks', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  codespaceId: text('codespace_id')
    .notNull()
    .references(() => codespaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  sessionId: text('session_id').references((): AnyPgColumn => sessions.id, {
    onDelete: 'set null',
  }),
  worktreeId: text('worktree_id').references((): AnyPgColumn => worktrees.id, {
    onDelete: 'set null',
  }),
  title: text('title').notNull(),
  description: text('description'),
  column: text('column').$type<TaskColumn>().default('backlog').notNull(),
  position: integer('position').default(0).notNull(),
  labels: jsonb('labels').$type<string[]>().default([]),
  priority: text('priority').$type<TaskPriority>().default('medium'),
  branch: text('branch'),
  diffSummary: jsonb('diff_summary').$type<DiffSummary>(),
  approvedAt: timestamp('approved_at', { mode: 'string' }),
  approvedBy: text('approved_by'),
  rejectionCount: integer('rejection_count').default(0),
  rejectionReason: text('rejection_reason'),
  modelOverride: text('model_override'),
  /** Skill directory name (e.g., 'terraform-stacks') — maps to .claude/skills/{skillId}/SKILL.md */
  skillId: text('skill_id'),
  /** Denormalized skill display name for UI rendering */
  skillName: text('skill_name'),
  planOptions: jsonb('plan_options').$type<StoredPlanOptions>(),
  plan: text('plan'),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
  startedAt: timestamp('started_at', { mode: 'string' }),
  completedAt: timestamp('completed_at', { mode: 'string' }),
  lastAgentStatus: text('last_agent_status').$type<
    'completed' | 'cancelled' | 'error' | 'turn_limit' | 'planning'
  >(),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
