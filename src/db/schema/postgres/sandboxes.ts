import { createId } from '@paralleldrive/cuid2';
import { boolean, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { SandboxStatus, VolumeMountRecord } from '../shared/types';
import { projects } from './projects';
import { tasks } from './tasks';

export type { SandboxStatus, VolumeMountRecord };

export const sandboxInstances = pgTable('sandbox_instances', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  projectId: text('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
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
});

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
