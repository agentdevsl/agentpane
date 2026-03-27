import { createId } from '@paralleldrive/cuid2';
import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { teams } from './teams';

export const githubTokens = pgTable('github_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  encryptedToken: text('encrypted_token').notNull(),
  tokenType: text('token_type').notNull().default('pat'),
  scopes: text('scopes'),
  githubLogin: text('github_login'),
  githubId: text('github_id'),
  isValid: boolean('is_valid').default(true),
  lastValidatedAt: timestamp('last_validated_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export const githubInstallations = pgTable('github_installations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  installationId: text('installation_id').notNull().unique(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export const repositoryConfigs = pgTable('repository_configs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  installationId: text('installation_id')
    .notNull()
    .references(() => githubInstallations.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>(),
  syncedAt: timestamp('synced_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type GitHubToken = typeof githubTokens.$inferSelect;
export type NewGitHubToken = typeof githubTokens.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type RepositoryConfig = typeof repositoryConfigs.$inferSelect;
export type NewRepositoryConfig = typeof repositoryConfigs.$inferInsert;
