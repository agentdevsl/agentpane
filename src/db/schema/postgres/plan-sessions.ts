import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export type PlanSessionStatus = 'active' | 'waiting_user' | 'completed' | 'cancelled';

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

export const planSessions = pgTable('plan_sessions', {
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
  turns: jsonb('turns').$type<PlanTurnRecord[]>().default([]),
  githubIssueUrl: text('github_issue_url'),
  githubIssueNumber: integer('github_issue_number'),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { mode: 'string' }),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type PlanSession = typeof planSessions.$inferSelect;
export type NewPlanSession = typeof planSessions.$inferInsert;
