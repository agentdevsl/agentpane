import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { WorktreeStatus } from '../shared/enums';

export type { WorktreeStatus } from '../shared/enums';

import { agents } from './agents';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references((): AnySQLiteColumn => agents.id, {
      onDelete: 'set null',
    }),
    taskId: text('task_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'set null' }),
    branch: text('branch').notNull(),
    path: text('path').notNull(),
    baseBranch: text('base_branch').default('main').notNull(),
    status: text('status').$type<WorktreeStatus>().default('creating').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now'))`)
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
    mergedAt: text('merged_at'),
    removedAt: text('removed_at'),
  },
  (table) => [index('idx_worktrees_codespace_id').on(table.codespaceId)]
);

export type Worktree = typeof worktrees.$inferSelect;
export type NewWorktree = typeof worktrees.$inferInsert;
