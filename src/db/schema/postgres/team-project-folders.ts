import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { projectFolders } from './project-folders';
import { teams } from './teams';

export const teamProjectFolders = pgTable(
  'team_project_folders',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectFolderId: text('project_folder_id')
      .notNull()
      .references(() => projectFolders.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.projectFolderId] })]
);

export type TeamProjectFolder = typeof teamProjectFolders.$inferSelect;
export type NewTeamProjectFolder = typeof teamProjectFolders.$inferInsert;
