import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ApiTokenStatus, RbacRole } from '../shared/enums';
import { projects } from './projects';
import { teams } from './teams';
import { users } from './users';

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  role: text('role').$type<RbacRole>().notNull(),
  scopeTags: text('scope_tags', { mode: 'json' }).$type<string[] | null>(),
  scopeProjectId: text('scope_project_id').references(() => projects.id, { onDelete: 'set null' }),
  status: text('status').$type<ApiTokenStatus>().default('active').notNull(),
  expiresAt: text('expires_at'),
  useCount: integer('use_count').default(0),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
