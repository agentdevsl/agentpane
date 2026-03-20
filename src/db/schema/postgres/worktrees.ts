import { createId } from '@paralleldrive/cuid2';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { WorktreeStatus } from '../shared/enums';

export type { WorktreeStatus } from '../shared/enums';

import { agents } from './agents';
import { projects } from './projects';
import { tasks } from './tasks';

export const worktrees = pgTable('worktrees', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
  taskId: text('task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
  branch: text('branch').notNull(),
  path: text('path').notNull(),
  baseBranch: text('base_branch').default('main').notNull(),
  status: text('status').$type<WorktreeStatus>().default('creating').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
  mergedAt: timestamp('merged_at', { mode: 'string' }),
  removedAt: timestamp('removed_at', { mode: 'string' }),
});

export type Worktree = typeof worktrees.$inferSelect;
export type NewWorktree = typeof worktrees.$inferInsert;
