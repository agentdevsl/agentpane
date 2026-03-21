import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';
import { templates } from './templates';

/**
 * Junction table for many-to-many relationship between templates and codespaces.
 * Allows a codespace-scoped template to be associated with multiple codespaces.
 */
export const templateCodespaces = pgTable(
  'template_codespaces',
  {
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.templateId, table.codespaceId] })]
);

export type TemplateCodespace = typeof templateCodespaces.$inferSelect;
export type NewTemplateCodespace = typeof templateCodespaces.$inferInsert;
