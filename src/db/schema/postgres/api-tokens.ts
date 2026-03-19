import { createId } from '@paralleldrive/cuid2';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { ApiTokenStatus, RbacRole } from '../shared/enums';
import { projects } from './projects';
import { teams } from './teams';
import { users } from './users';

export const apiTokens = pgTable('api_tokens', {
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
  scopeTags: jsonb('scope_tags').$type<string[] | null>(),
  scopeProjectId: text('scope_project_id').references(() => projects.id, { onDelete: 'set null' }),
  status: text('status').$type<ApiTokenStatus>().default('active').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'string' }),
  useCount: integer('use_count').default(0),
  lastUsedAt: timestamp('last_used_at', { mode: 'string' }),
  revokedAt: timestamp('revoked_at', { mode: 'string' }),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
});

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
