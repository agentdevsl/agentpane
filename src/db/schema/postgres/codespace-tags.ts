import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';
import { tags } from './tags';

export const codespaceTags = pgTable(
  'codespace_tags',
  {
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.codespaceId, table.tagId] })]
);

export type CodespaceTag = typeof codespaceTags.$inferSelect;
export type NewCodespaceTag = typeof codespaceTags.$inferInsert;
