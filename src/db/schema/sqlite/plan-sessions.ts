import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

/**
 * Plan session status enum
 */
export type PlanSessionStatus = 'active' | 'waiting_user' | 'completed' | 'cancelled';

/**
 * Plan turn stored in JSON
 */
export interface PlanTurnRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  interaction?: {
    id: string;
    type: 'question';
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;
    answers?: Record<string, string>;
    answeredAt?: string;
  };
  timestamp: string;
}

/**
 * Plan sessions table for multi-turn planning conversations
 */
export const planSessions = sqliteTable('plan_sessions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),

  codespaceId: text('codespace_id')
    .notNull()
    .references(() => codespaces.id, { onDelete: 'cascade' }),

  status: text('status').$type<PlanSessionStatus>().default('active').notNull(),

  turns: text('turns', { mode: 'json' }).$type<PlanTurnRecord[]>().default([]),

  githubIssueUrl: text('github_issue_url'),

  githubIssueNumber: integer('github_issue_number'),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),

  completedAt: text('completed_at'),

  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type PlanSession = typeof planSessions.$inferSelect;
export type NewPlanSession = typeof planSessions.$inferInsert;
