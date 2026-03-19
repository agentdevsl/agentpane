import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { RbacRole } from '../shared/enums';
import { projects } from './projects';
import { teams } from './teams';
import { users } from './users';

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<RbacRole>().notNull(),
    grantedByTeamId: text('granted_by_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })]
);

export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;
