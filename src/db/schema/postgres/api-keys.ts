import { createId } from '@paralleldrive/cuid2';
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const apiKeys = pgTable('api_keys', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  service: text('service').notNull().unique(),
  encryptedKey: text('encrypted_key').notNull(),
  maskedKey: text('masked_key').notNull(),
  isValid: boolean('is_valid').default(true),
  lastValidatedAt: timestamp('last_validated_at', { mode: 'string' }),
  // F06-09: rotation-tracking columns. Null = not tracked (legacy rows).
  expiresAt: timestamp('expires_at', { mode: 'string' }),
  rotatedAt: timestamp('rotated_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
