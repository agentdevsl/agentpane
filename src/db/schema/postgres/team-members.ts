import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { RbacRole } from '../shared/enums';
import { teams } from './teams';
import { users } from './users';

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<RbacRole>().default('viewer').notNull(),
    joinedAt: timestamp('joined_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })]
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
