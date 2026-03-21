import { sql } from 'drizzle-orm';
import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { codespaces } from './codespaces';
import { templates } from './templates';

/**
 * Junction table for many-to-many relationship between templates and codespaces.
 * Allows a codespace-scoped template to be associated with multiple codespaces.
 */
export const templateCodespaces = sqliteTable(
  'template_codespaces',
  {
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [primaryKey({ columns: [table.templateId, table.codespaceId] })]
);

export type TemplateCodespace = typeof templateCodespaces.$inferSelect;
export type NewTemplateCodespace = typeof templateCodespaces.$inferInsert;
