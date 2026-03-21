import { sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';
import { tags } from './tags';

export const codespaceTags = sqliteTable(
  'codespace_tags',
  {
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.codespaceId, table.tagId] })]
);

export type CodespaceTag = typeof codespaceTags.$inferSelect;
export type NewCodespaceTag = typeof codespaceTags.$inferInsert;
