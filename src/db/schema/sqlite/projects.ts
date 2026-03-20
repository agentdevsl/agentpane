import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ProjectConfig } from '../shared/types';
import { githubInstallations } from './github';
import { sandboxConfigs } from './sandbox-configs';

export type { ProjectConfig };

export const projects = sqliteTable('projects', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  description: text('description'),
  config: text('config', { mode: 'json' }).$type<ProjectConfig>(),
  maxConcurrentAgents: integer('max_concurrent_agents').default(3),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  // DB-016: Add onDelete: 'set null' so deleting a GitHub installation doesn't break projects
  githubInstallationId: text('github_installation_id').references(() => githubInstallations.id, {
    onDelete: 'set null',
  }),
  configPath: text('config_path').default('.claude'),
  sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
