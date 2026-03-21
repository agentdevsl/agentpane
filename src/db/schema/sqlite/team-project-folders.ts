import { sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projectFolders } from './project-folders';
import { teams } from './teams';

export const teamProjectFolders = sqliteTable(
  'team_project_folders',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectFolderId: text('project_folder_id')
      .notNull()
      .references(() => projectFolders.id, { onDelete: 'cascade' }),
    assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.projectFolderId] })]
);

export type TeamProjectFolder = typeof teamProjectFolders.$inferSelect;
export type NewTeamProjectFolder = typeof teamProjectFolders.$inferInsert;
