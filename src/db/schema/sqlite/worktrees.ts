import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { WorktreeStatus } from '../shared/enums';

export type { WorktreeStatus } from '../shared/enums';

import { agents } from './agents';
import { projects } from './projects';
import { tasks } from './tasks';

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references((): AnySQLiteColumn => agents.id, {
      onDelete: 'set null',
    }),
    taskId: text('task_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'set null' }),
    branch: text('branch').notNull(),
    path: text('path').notNull(),
    baseBranch: text('base_branch').default('main').notNull(),
    status: text('status').$type<WorktreeStatus>().default('creating').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
    mergedAt: text('merged_at'),
    removedAt: text('removed_at'),
  },
  (table) => [index('idx_worktrees_project_id').on(table.projectId)]
);

export type Worktree = typeof worktrees.$inferSelect;
export type NewWorktree = typeof worktrees.$inferInsert;
