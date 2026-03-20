import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Settings table for storing user preferences (replaces localStorage)
 * Keys: 'taskCreation.model', 'taskCreation.tools'
 */
export const settings = sqliteTable('settings', {
  // The setting name (e.g., 'taskCreation.model', 'taskCreation.tools')
  key: text('key').primaryKey(),
  // JSON-encoded value
  value: text('value').notNull(),
  // Timestamps
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
