import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { CodespaceConfig } from '../shared/types';
import { githubInstallations } from './github';
import { projectFolders } from './project-folders';
import { sandboxConfigs } from './sandbox-configs';

export type { CodespaceConfig };

export const codespaces = pgTable('codespaces', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  projectFolderId: text('project_folder_id')
    .notNull()
    .references(() => projectFolders.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  description: text('description'),
  config: jsonb('config').$type<CodespaceConfig>(),
  maxConcurrentAgents: integer('max_concurrent_agents').default(3),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  githubInstallationId: text('github_installation_id').references(() => githubInstallations.id, {
    onDelete: 'set null',
  }),
  configPath: text('config_path').default('.claude'),
  sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Codespace = typeof codespaces.$inferSelect;
export type NewCodespace = typeof codespaces.$inferInsert;
