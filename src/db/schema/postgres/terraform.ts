import { createId } from '@paralleldrive/cuid2';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const TERRAFORM_REGISTRY_STATUSES = ['active', 'syncing', 'error'] as const;
export type TerraformRegistryStatus = (typeof TERRAFORM_REGISTRY_STATUSES)[number];

export interface TerraformVariable {
  name: string;
  type: string;
  description?: string;
  default?: unknown;
  required: boolean;
  sensitive?: boolean;
}

export interface TerraformOutput {
  name: string;
  description?: string;
}

export const terraformRegistries = pgTable('terraform_registries', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  orgName: text('org_name').notNull(),
  tokenSettingKey: text('token_setting_key').notNull(),
  status: text('status').notNull().default('active').$type<TerraformRegistryStatus>(),
  lastSyncedAt: timestamp('last_synced_at', { mode: 'string' }),
  syncError: text('sync_error'),
  moduleCount: integer('module_count').default(0),
  syncIntervalMinutes: integer('sync_interval_minutes'),
  nextSyncAt: timestamp('next_sync_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export const terraformModules = pgTable(
  'terraform_modules',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    registryId: text('registry_id')
      .notNull()
      .references(() => terraformRegistries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    namespace: text('namespace').notNull(),
    provider: text('provider').notNull(),
    version: text('version').notNull(),
    source: text('source').notNull(),
    description: text('description'),
    readme: text('readme'),
    inputs: jsonb('inputs').$type<TerraformVariable[]>(),
    outputs: jsonb('outputs').$type<TerraformOutput[]>(),
    dependencies: jsonb('dependencies').$type<string[]>(),
    publishedAt: timestamp('published_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_tf_modules_registry').on(table.registryId),
    index('idx_tf_modules_provider').on(table.provider),
    index('idx_tf_modules_name').on(table.name),
  ]
);

export type TerraformRegistry = typeof terraformRegistries.$inferSelect;
export type NewTerraformRegistry = typeof terraformRegistries.$inferInsert;
export type TerraformModule = typeof terraformModules.$inferSelect;
export type NewTerraformModule = typeof terraformModules.$inferInsert;
