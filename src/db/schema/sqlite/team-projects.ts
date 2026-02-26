import { sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';
import { teams } from './teams';

export const teamProjects = sqliteTable(
  'team_projects',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.projectId] })]
);

export type TeamProject = typeof teamProjects.$inferSelect;
export type NewTeamProject = typeof teamProjects.$inferInsert;
