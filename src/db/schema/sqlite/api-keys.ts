import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Stores encrypted API keys for various services
 * Keys are encrypted using AES-GCM before storage
 */
export const apiKeys = sqliteTable('api_keys', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  // The service this key is for (e.g., 'anthropic', 'openai')
  service: text('service').notNull().unique(),
  // The encrypted API key (base64-encoded)
  encryptedKey: text('encrypted_key').notNull(),
  // Key metadata
  maskedKey: text('masked_key').notNull(), // e.g., "sk-ant-...abc123"
  // Validation status
  isValid: integer('is_valid', { mode: 'boolean' }).default(true),
  lastValidatedAt: text('last_validated_at'),
  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
