import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { EventLogStatus } from '../shared/enums';
import { eventSources } from './event-sources';

export type { EventLogStatus } from '../shared/enums';

export const eventLog = sqliteTable(
  'event_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    eventSourceId: text('event_source_id').references(() => eventSources.id, {
      onDelete: 'set null',
    }),
    eventType: text('event_type').notNull(),
    action: text('action'),
    status: text('status').$type<EventLogStatus>().default('received').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    matchedSubscriptions: text('matched_subscriptions', { mode: 'json' })
      .$type<Array<{ subscriptionId: string; taskId?: string }>>()
      .default([]),
    error: text('error'),
    deliveryId: text('delivery_id').notNull(),
    receivedAt: text('received_at').default(sql`(datetime('now'))`).notNull(),
    processedAt: text('processed_at'),
  },
  (table) => [
    index('event_log_source_idx').on(table.eventSourceId),
    index('event_log_received_at_idx').on(table.receivedAt),
    index('event_log_source_status_idx').on(table.eventSourceId, table.status),
    uniqueIndex('event_log_delivery_idx').on(table.eventSourceId, table.deliveryId),
  ]
);

export type EventLogEntry = typeof eventLog.$inferSelect;
export type NewEventLogEntry = typeof eventLog.$inferInsert;
