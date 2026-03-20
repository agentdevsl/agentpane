import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Marketplace status enum
export const MARKETPLACE_STATUSES = ['active', 'syncing', 'error'] as const;
export type MarketplaceStatus = (typeof MARKETPLACE_STATUSES)[number];

// Plugin tags for filtering
export const PLUGIN_TAGS = ['official', 'external'] as const;
export type PluginTag = (typeof PLUGIN_TAGS)[number];

// Cached plugin type
export interface CachedPlugin {
  id: string; // Directory name
  name: string; // From SKILL.md frontmatter
  description?: string;
  author?: string;
  version?: string;
  category?: string;
  readme?: string; // README.md content
  tags?: PluginTag[]; // official, external, etc.
}

export const marketplaces = sqliteTable('marketplaces', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  branch: text('branch').default('main'),
  pluginsPath: text('plugins_path').default('plugins'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true),
  status: text('status').default('active').$type<MarketplaceStatus>(),
  lastSyncSha: text('last_sync_sha'),
  lastSyncedAt: text('last_synced_at'),
  syncError: text('sync_error'),
  cachedPlugins: text('cached_plugins', { mode: 'json' }).$type<CachedPlugin[]>(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Marketplace = typeof marketplaces.$inferSelect;
export type NewMarketplace = typeof marketplaces.$inferInsert;
