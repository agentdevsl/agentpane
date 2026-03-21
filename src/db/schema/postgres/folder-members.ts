import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { RbacRole } from '../shared/enums';
import { projectFolders } from './project-folders';
import { teams } from './teams';
import { users } from './users';

export const folderMembers = pgTable(
  'folder_members',
  {
    projectFolderId: text('project_folder_id')
      .notNull()
      .references(() => projectFolders.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<RbacRole>().notNull(),
    grantedByTeamId: text('granted_by_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectFolderId, table.userId] })]
);

export type FolderMember = typeof folderMembers.$inferSelect;
export type NewFolderMember = typeof folderMembers.$inferInsert;
