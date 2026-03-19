import { createId } from '@paralleldrive/cuid2';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { InvitationStatus, RbacRole } from '../shared/enums';
import { teams } from './teams';
import { users } from './users';

export const teamInvitations = pgTable('team_invitations', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').$type<RbacRole>().default('viewer').notNull(),
  token: text('token').notNull().unique(),
  status: text('status').$type<InvitationStatus>().default('pending').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
});

export type TeamInvitation = typeof teamInvitations.$inferSelect;
export type NewTeamInvitation = typeof teamInvitations.$inferInsert;
