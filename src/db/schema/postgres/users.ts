import { createId } from '@paralleldrive/cuid2';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
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
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
