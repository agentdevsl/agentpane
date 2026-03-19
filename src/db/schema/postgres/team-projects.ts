import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { teams } from './teams';

export const teamProjects = pgTable(
  'team_projects',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.projectId] })]
);

export type TeamProject = typeof teamProjects.$inferSelect;
export type NewTeamProject = typeof teamProjects.$inferInsert;
