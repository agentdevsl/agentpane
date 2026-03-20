import { createId } from '@paralleldrive/cuid2';
import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const MARKETPLACE_STATUSES = ['active', 'syncing', 'error'] as const;
export type MarketplaceStatus = (typeof MARKETPLACE_STATUSES)[number];

export const PLUGIN_TAGS = ['official', 'external'] as const;
export type PluginTag = (typeof PLUGIN_TAGS)[number];

export interface CachedPlugin {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  category?: string;
  readme?: string;
  tags?: PluginTag[];
}

export const marketplaces = pgTable('marketplaces', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  branch: text('branch').default('main'),
  pluginsPath: text('plugins_path').default('plugins'),
  isDefault: boolean('is_default').default(false),
  isEnabled: boolean('is_enabled').default(true),
  status: text('status').default('active').$type<MarketplaceStatus>(),
  lastSyncSha: text('last_sync_sha'),
  lastSyncedAt: timestamp('last_synced_at', { mode: 'string' }),
  syncError: text('sync_error'),
  cachedPlugins: jsonb('cached_plugins').$type<CachedPlugin[]>(),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Marketplace = typeof marketplaces.$inferSelect;
export type NewMarketplace = typeof marketplaces.$inferInsert;
