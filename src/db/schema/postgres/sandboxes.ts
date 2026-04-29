import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { SandboxStatus, VolumeMountRecord } from '../shared/types';
import { codespaces } from './codespaces';
import { tasks } from './tasks';

export type { SandboxStatus, VolumeMountRecord };

/**
 * F04-08 (arch29-W2-E): see SQLite schema for rationale. The global UNIQUE
 * constraint on `codespace_id` is replaced by a partial unique index that
 * fires only while the sandbox is active.
 */
export const sandboxInstances = pgTable(
  'sandbox_instances',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    codespaceId: text('codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    containerId: text('container_id').notNull(),
    status: text('status').$type<SandboxStatus>().default('stopped').notNull(),
    image: text('image').notNull(),
    memoryMb: integer('memory_mb').notNull(),
    cpuCores: integer('cpu_cores').notNull(),
    idleTimeoutMinutes: integer('idle_timeout_minutes').notNull(),
    volumeMounts: jsonb('volume_mounts').$type<VolumeMountRecord[]>().default([]),
    env: jsonb('env').$type<Record<string, string>>(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    lastActivityAt: timestamp('last_activity_at', { mode: 'string' }).defaultNow().notNull(),
    stoppedAt: timestamp('stopped_at', { mode: 'string' }),
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('sandbox_instances_codespace_active_unique')
      .on(table.codespaceId)
      .where(sql`status IN ('creating', 'running', 'idle', 'stopping')`),
  ]
);

export const sandboxTmuxSessions = pgTable(
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
    attached: boolean('attached').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    lastActivityAt: timestamp('last_activity_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [unique('sandbox_session_unique').on(table.sandboxId, table.sessionName)]
);

export type SandboxInstance = typeof sandboxInstances.$inferSelect;
export type NewSandboxInstance = typeof sandboxInstances.$inferInsert;
export type SandboxTmuxSession = typeof sandboxTmuxSessions.$inferSelect;
export type NewSandboxTmuxSession = typeof sandboxTmuxSessions.$inferInsert;
