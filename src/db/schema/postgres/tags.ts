import { createId } from '@paralleldrive/cuid2';
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { teams } from './teams';

export const tags = pgTable(
  'tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6B7280'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('tags_team_name_unique').on(table.teamId, table.name)]
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
