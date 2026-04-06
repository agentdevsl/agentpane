import { createId } from '@paralleldrive/cuid2';
import {
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';

export const skillMetrics = pgTable(
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
    avgTokensUsed: doublePrecision('avg_tokens_used'),
    avgTurnsUsed: doublePrecision('avg_turns_used'),
    avgDurationMs: doublePrecision('avg_duration_ms'),
    avgDurationApiMs: doublePrecision('avg_duration_api_ms'),
    avgCostUsd: doublePrecision('avg_cost_usd'),
    successRate: doublePrecision('success_rate'),
    lastRunAt: timestamp('last_run_at', { mode: 'string' }),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('skill_metrics_codespace_skill_unique').on(table.codespaceId, table.skillId),
  ]
);

export type SkillMetric = typeof skillMetrics.$inferSelect;
export type NewSkillMetric = typeof skillMetrics.$inferInsert;
