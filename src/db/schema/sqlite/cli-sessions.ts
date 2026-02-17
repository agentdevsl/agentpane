import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { CliSessionStatus } from '../../../services/cli-monitor/types.js';

export const cliSessions = sqliteTable(
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
    pendingToolUse: text('pending_tool_use'), // JSON
    tokenUsage: text('token_usage'), // JSON
    performanceMetrics: text('performance_metrics'), // JSON
    model: text('model'),
    startedAt: integer('started_at').notNull(),
    lastActivityAt: integer('last_activity_at').notNull(),
    isSubagent: integer('is_subagent', { mode: 'boolean' }).notNull().default(false),
    parentSessionId: text('parent_session_id'),
    slug: text('slug'),
    cliVersion: text('cli_version'),
    permissionMode: text('permission_mode'),
    topology: text('topology'), // JSON
    queueOperations: text('queue_operations'), // JSON
    toolInvocations: text('tool_invocations'), // JSON
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    index('idx_cli_sessions_project').on(table.projectHash, table.lastActivityAt),
    index('idx_cli_sessions_status').on(table.status),
    index('idx_cli_sessions_last_activity').on(table.lastActivityAt),
  ]
);

export type CliSessionRow = typeof cliSessions.$inferSelect;
export type NewCliSessionRow = typeof cliSessions.$inferInsert;
