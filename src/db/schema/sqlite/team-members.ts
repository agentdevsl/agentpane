import { sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RbacRole } from '../shared/enums';
import { teams } from './teams';
import { users } from './users';

export const teamMembers = sqliteTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<RbacRole>().notNull(),
    joinedAt: text('joined_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })]
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
