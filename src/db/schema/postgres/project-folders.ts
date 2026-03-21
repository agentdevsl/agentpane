import { createId } from '@paralleldrive/cuid2';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const projectFolders = pgTable('project_folders', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  icon: text('icon').notNull().default('Folder'),
  color: text('color').notNull().default('#6B7280'),
  createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type ProjectFolder = typeof projectFolders.$inferSelect;
export type NewProjectFolder = typeof projectFolders.$inferInsert;
