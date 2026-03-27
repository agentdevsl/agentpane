import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { teams } from './teams';

/**
 * Stores encrypted GitHub Personal Access Tokens
 * Tokens are encrypted using AES-GCM before storage
 */
export const githubTokens = sqliteTable('github_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  // The encrypted token (base64-encoded)
  encryptedToken: text('encrypted_token').notNull(),
  // Token metadata (not sensitive)
  tokenType: text('token_type').notNull().default('pat'), // 'pat' | 'oauth'
  scopes: text('scopes'), // Comma-separated scopes
  // Associated GitHub user info (from validation)
  githubLogin: text('github_login'),
  githubId: text('github_id'),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  // Status (SQLite uses 0/1 for boolean)
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export const githubInstallations = sqliteTable('github_installations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  installationId: text('installation_id').notNull().unique(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  status: text('status').default('active').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export const repositoryConfigs = sqliteTable('repository_configs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  installationId: text('installation_id')
    .notNull()
    .references(() => githubInstallations.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
  syncedAt: text('synced_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type GitHubToken = typeof githubTokens.$inferSelect;
export type NewGitHubToken = typeof githubTokens.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;
export type RepositoryConfig = typeof repositoryConfigs.$inferSelect;
export type NewRepositoryConfig = typeof repositoryConfigs.$inferInsert;
