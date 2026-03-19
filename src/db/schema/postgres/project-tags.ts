import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { tags } from './tags';

export const projectTags = pgTable(
  'project_tags',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.tagId] })]
);

export type ProjectTag = typeof projectTags.$inferSelect;
export type NewProjectTag = typeof projectTags.$inferInsert;
