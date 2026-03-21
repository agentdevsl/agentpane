import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { SandboxStatus, VolumeMountRecord } from '../shared/types';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export type { SandboxStatus, VolumeMountRecord };

/**
 * Sandbox instances table
 */
export const sandboxInstances = sqliteTable('sandbox_instances', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  codespaceId: text('codespace_id')
    .notNull()
    .unique()
    .references(() => codespaces.id, { onDelete: 'cascade' }),

  containerId: text('container_id').notNull(),

  status: text('status').$type<SandboxStatus>().default('stopped').notNull(),

  image: text('image').notNull(),

  memoryMb: integer('memory_mb').notNull(),

  cpuCores: integer('cpu_cores').notNull(),

  idleTimeoutMinutes: integer('idle_timeout_minutes').notNull(),

  volumeMounts: text('volume_mounts', { mode: 'json' }).$type<VolumeMountRecord[]>().default([]),

  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),

  errorMessage: text('error_message'),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),

  lastActivityAt: text('last_activity_at').default(sql`(datetime('now'))`).notNull(),

  stoppedAt: text('stopped_at'),

  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

/**
 * Sandbox tmux sessions table
 *
 * Each sandbox can have multiple tmux sessions, but session names must be
 * unique within a sandbox (enforced by unique constraint).
 */
export const sandboxTmuxSessions = sqliteTable(
  'sandbox_tmux_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),

    sandboxId: text('sandbox_id')
      .notNull()
      .references(() => sandboxInstances.id, { onDelete: 'cascade' }),

    sessionName: text('session_name').notNull(),

    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),

    windowCount: integer('window_count').default(1).notNull(),

    attached: integer('attached', { mode: 'boolean' }).default(false).notNull(),

    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),

    lastActivityAt: text('last_activity_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    // Ensure session names are unique within each sandbox
    unique('sandbox_session_unique').on(table.sandboxId, table.sessionName),
  ]
);

export type SandboxInstance = typeof sandboxInstances.$inferSelect;
export type NewSandboxInstance = typeof sandboxInstances.$inferInsert;
export type SandboxTmuxSession = typeof sandboxTmuxSessions.$inferSelect;
export type NewSandboxTmuxSession = typeof sandboxTmuxSessions.$inferInsert;
