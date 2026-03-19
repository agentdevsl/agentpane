import { createId } from '@paralleldrive/cuid2';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { EventLogStatus } from '../shared/enums';
import { eventSources } from './event-sources';

export type { EventLogStatus } from '../shared/enums';

export const eventLog = pgTable(
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
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}),
    matchedSubscriptions: jsonb('matched_subscriptions')
      .$type<Array<{ subscriptionId: string; taskId?: string }>>()
      .default([]),
    error: text('error'),
    deliveryId: text('delivery_id').notNull(),
    receivedAt: timestamp('received_at', { mode: 'string' }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { mode: 'string' }),
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
