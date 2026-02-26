import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { InvitationStatus, RbacRole } from '../shared/enums';
import { teams } from './teams';
import { users } from './users';

export const teamInvitations = sqliteTable('team_invitations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  role: text('role').$type<RbacRole>().notNull(),
  token: text('token').notNull().unique(),
  status: text('status').$type<InvitationStatus>().default('pending').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export type TeamInvitation = typeof teamInvitations.$inferSelect;
export type NewTeamInvitation = typeof teamInvitations.$inferInsert;
