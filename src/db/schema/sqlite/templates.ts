import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';

// Template scope enum
export const TEMPLATE_SCOPES = ['org', 'codespace'] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

// Template status enum
export const TEMPLATE_STATUSES = ['active', 'syncing', 'error', 'disabled'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

// Sync interval options in minutes
export const SYNC_INTERVAL_OPTIONS = [
  { value: null, label: 'Disabled' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 360, label: '6 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '24 hours' },
] as const;

// Cached content types
export type CachedSkill = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  content: string;
  /** Skill ID to chain to on plan approval (e.g., tf-module-implement) */
  executionSkill?: string;
};

export type CachedCommand = {
  name: string;
  description?: string;
  content: string;
};

export type CachedAgent = {
  name: string;
  description?: string;
  content: string;
  model?: string;
  color?: string;
  skills?: string[];
  tools?: string[];
};

export const templates = sqliteTable('templates', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  scope: text('scope').notNull().$type<TemplateScope>(),

  // Git repository source
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  branch: text('branch').default('main'),
  configPath: text('config_path').default('.claude'),

  // For codespace-scoped templates
  codespaceId: text('codespace_id').references(() => codespaces.id, { onDelete: 'cascade' }),

  // Sync state
  status: text('status').default('active').$type<TemplateStatus>(),
  lastSyncSha: text('last_sync_sha'),
  lastSyncedAt: text('last_synced_at'),
  syncError: text('sync_error'),

  // Auto-sync interval settings
  syncIntervalMinutes: integer('sync_interval_minutes'), // null = disabled, minimum 5 minutes
  nextSyncAt: text('next_sync_at'), // ISO datetime string for next scheduled sync

  // Cached content (JSON)
  cachedSkills: text('cached_skills', { mode: 'json' }).$type<CachedSkill[]>(),
  cachedCommands: text('cached_commands', { mode: 'json' }).$type<CachedCommand[]>(),
  cachedAgents: text('cached_agents', { mode: 'json' }).$type<CachedAgent[]>(),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
