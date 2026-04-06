import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';

export const skillMetrics = sqliteTable(
  'skill_metrics',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').notNull(),
    skillName: text('skill_name').notNull(),
    totalRuns: integer('total_runs').default(0).notNull(),
    successCount: integer('success_count').default(0).notNull(),
    errorCount: integer('error_count').default(0).notNull(),
    avgTokensUsed: real('avg_tokens_used'),
    avgTurnsUsed: real('avg_turns_used'),
    avgDurationMs: real('avg_duration_ms'),
    avgDurationApiMs: real('avg_duration_api_ms'),
    avgCostUsd: real('avg_cost_usd'),
    successRate: real('success_rate'),
    lastRunAt: text('last_run_at'),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    uniqueIndex('skill_metrics_codespace_skill_unique').on(table.codespaceId, table.skillId),
  ]
);

export type SkillMetric = typeof skillMetrics.$inferSelect;
export type NewSkillMetric = typeof skillMetrics.$inferInsert;
