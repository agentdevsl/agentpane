import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { ProjectConfig } from '../shared/types';
import { githubInstallations } from './github';
import { sandboxConfigs } from './sandbox-configs';

export type { ProjectConfig };

export const projects = pgTable('projects', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  description: text('description'),
  config: jsonb('config').$type<ProjectConfig>(),
  maxConcurrentAgents: integer('max_concurrent_agents').default(3),
  githubOwner: text('github_owner'),
  githubRepo: text('github_repo'),
  githubInstallationId: text('github_installation_id').references(() => githubInstallations.id),
  configPath: text('config_path').default('.claude'),
  sandboxConfigId: text('sandbox_config_id').references(() => sandboxConfigs.id),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
