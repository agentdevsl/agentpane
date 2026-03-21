import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { RbacRole } from '../shared/enums';
import { codespaces } from './codespaces';
import { teams } from './teams';
import { users } from './users';

export const codespaceMembers = pgTable(
  'codespace_members',
  {
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<RbacRole>().notNull(),
    grantedByTeamId: text('granted_by_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.codespaceId, table.userId] })]
);

export type CodespaceMember = typeof codespaceMembers.$inferSelect;
export type NewCodespaceMember = typeof codespaceMembers.$inferInsert;
