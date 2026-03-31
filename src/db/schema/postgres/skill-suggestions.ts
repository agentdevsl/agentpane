import { createId } from '@paralleldrive/cuid2';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { codespaces } from './codespaces';
import { dreamSessions } from './dream-sessions';

export const skillSuggestions = pgTable(
  'skill_suggestions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    dreamSessionId: text('dream_session_id')
      .notNull()
      .references(() => dreamSessions.id, { onDelete: 'cascade' }),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').notNull(),
    skillName: text('skill_name').notNull(),
    suggestionType: text('suggestion_type')
      .$type<'improve_prompt' | 'add_example' | 'fix_pattern' | 'new_skill' | 'optimize_context'>()
      .notNull(),
    title: text('title').notNull(),
    reasoning: text('reasoning').notNull(),
    currentContent: text('current_content'),
    suggestedContent: text('suggested_content').notNull(),
    diff: text('diff'),
    status: text('status')
      .$type<'pending' | 'accepted' | 'rejected' | 'modified'>()
      .default('pending')
      .notNull(),
    userNotes: text('user_notes'),
    appliedAt: timestamp('applied_at', { mode: 'string' }),
    appliedBy: text('applied_by'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_skill_suggestions_dream_session_id').on(table.dreamSessionId),
    index('idx_skill_suggestions_codespace_id').on(table.codespaceId),
    index('idx_skill_suggestions_skill_id').on(table.skillId),
    index('idx_skill_suggestions_status').on(table.status),
  ]
);

export type SkillSuggestion = typeof skillSuggestions.$inferSelect;
export type NewSkillSuggestion = typeof skillSuggestions.$inferInsert;
