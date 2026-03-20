import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  githubId: integer('github_id').notNull().unique(),
  githubLogin: text('github_login').notNull(),
  name: text('name'),
  email: text('email'),
  /** Email from GitHub OAuth — immutable by user, used for invitation verification */
  githubEmail: text('github_email'),
  avatarUrl: text('avatar_url'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
