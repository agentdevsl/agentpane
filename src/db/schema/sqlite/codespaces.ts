import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { CodespaceConfig } from '../shared/types';
import { githubInstallations } from './github';
import { projectFolders } from './project-folders';
import { sandboxConfigs } from './sandbox-configs';

export type { CodespaceConfig };

export const codespaces = sqliteTable('codespaces', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  projectFolderId: text('project_folder_id')
    .notNull()
    .references(() => projectFolders.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  description: text('description'),
  config: text('config', { mode: 'json' }).$type<CodespaceConfig>(),
  maxConcurrentAgents: integer('max_concurrent_agents').default(3),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  // DB-016: Add onDelete: 'set null' so deleting a GitHub installation doesn't break codespaces
  githubInstallationId: text('github_installation_id').references(() => githubInstallations.id, {
    onDelete: 'set null',
  }),
  configPath: text('config_path').default('.claude'),
  sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id, {
    onDelete: 'set null',
  }),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Codespace = typeof codespaces.$inferSelect;
export type NewCodespace = typeof codespaces.$inferInsert;
