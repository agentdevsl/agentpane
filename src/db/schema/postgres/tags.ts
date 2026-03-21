import { createId } from '@paralleldrive/cuid2';
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projectFolders } from './project-folders';

export const tags = pgTable(
  'tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectFolderId: text('project_folder_id')
      .notNull()
      .references(() => projectFolders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6B7280'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex('tags_folder_name_unique').on(table.projectFolderId, table.name)]
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
