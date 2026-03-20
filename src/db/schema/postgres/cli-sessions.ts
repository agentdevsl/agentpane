import { createId } from '@paralleldrive/cuid2';
import { bigint, boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { CliSessionStatus } from '../../../services/cli-monitor/types.js';

export const cliSessions = pgTable(
  'cli_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text('session_id').notNull().unique(),
    filePath: text('file_path').notNull(),
    cwd: text('cwd').notNull(),
    projectName: text('project_name').notNull(),
    projectHash: text('project_hash').notNull(),
    gitBranch: text('git_branch'),
    status: text('status').$type<CliSessionStatus>().notNull().default('idle'),
    messageCount: integer('message_count').notNull().default(0),
    turnCount: integer('turn_count').notNull().default(0),
    goal: text('goal'),
    recentOutput: text('recent_output'),
    pendingToolUse: text('pending_tool_use'),
    tokenUsage: text('token_usage'),
    performanceMetrics: text('performance_metrics'),
    model: text('model'),
    startedAt: bigint('started_at', { mode: 'number' }).notNull(),
    lastActivityAt: bigint('last_activity_at', { mode: 'number' }).notNull(),
    isSubagent: boolean('is_subagent').notNull().default(false),
    parentSessionId: text('parent_session_id'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_cli_sessions_project').on(table.projectHash, table.lastActivityAt),
    index('idx_cli_sessions_status').on(table.status),
    index('idx_cli_sessions_last_activity').on(table.lastActivityAt),
  ]
);

export type CliSessionRow = typeof cliSessions.$inferSelect;
export type NewCliSessionRow = typeof cliSessions.$inferInsert;
