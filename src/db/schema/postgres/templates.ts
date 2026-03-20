import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects';

export const TEMPLATE_SCOPES = ['org', 'project'] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

export const TEMPLATE_STATUSES = ['active', 'syncing', 'error', 'disabled'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const SYNC_INTERVAL_OPTIONS = [
  { value: null, label: 'Disabled' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 360, label: '6 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '24 hours' },
] as const;

export type CachedSkill = {
  id: string;
  name: string;
  description?: string;
  content: string;
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
};

export const templates = pgTable('templates', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  scope: text('scope').notNull().$type<TemplateScope>(),
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  branch: text('branch').default('main'),
  configPath: text('config_path').default('.claude'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').default('active').$type<TemplateStatus>(),
  lastSyncSha: text('last_sync_sha'),
  lastSyncedAt: timestamp('last_synced_at', { mode: 'string' }),
  syncError: text('sync_error'),
  syncIntervalMinutes: integer('sync_interval_minutes'),
  nextSyncAt: timestamp('next_sync_at', { mode: 'string' }),
  cachedSkills: jsonb('cached_skills').$type<CachedSkill[]>(),
  cachedCommands: jsonb('cached_commands').$type<CachedCommand[]>(),
  cachedAgents: jsonb('cached_agents').$type<CachedAgent[]>(),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Template = typeof templates.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
