import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { tags } from './tags';
import { tasks } from './tasks';

export const taskTags = pgTable(
  'task_tags',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.tagId] })]
);

export type TaskTag = typeof taskTags.$inferSelect;
export type NewTaskTag = typeof taskTags.$inferInsert;
