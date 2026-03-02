# Event Plugin System - Database Schema

## Overview

Three new Drizzle tables to support the event plugin system: `event_sources`, `event_subscriptions`, and `event_log`. These follow the existing codebase patterns: SQLite via `better-sqlite3`, cuid2 primary keys, `text` columns, JSON mode for structured data, and `sql\`(datetime('now'))\`` defaults for timestamps.

All tables live alongside the existing schema files in `src/db/schema/sqlite/`.

---

## New Enums

Added to `src/db/schema/shared/enums.ts` following the existing const-array pattern:

```typescript
// --- Event Plugin System Enums ---

export const EVENT_SOURCE_TYPES = ['github', 'linear', 'jira', 'generic_webhook'] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];

export const EVENT_SOURCE_STATUS = ['active', 'inactive', 'error'] as const;
export type EventSourceStatus = (typeof EVENT_SOURCE_STATUS)[number];

export const EVENT_LOG_STATUS = [
  'received',
  'signature_verified',
  'parsed',
  'deduplicated',
  'matched',
  'tasks_created',
  'completed',
  'error_signature',
  'error_parse',
  'error_duplicate',
  'error_matching',
  'error_task_creation',
] as const;
export type EventLogStatus = (typeof EVENT_LOG_STATUS)[number];
```

---

## Event Sources Table

Represents a configured webhook endpoint that receives events from an external system.

### Schema

```typescript
// src/db/schema/sqlite/event-sources.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { EventSourceType, EventSourceStatus } from '../shared/enums';
import { teams } from './teams';

/**
 * Per-source configuration stored as JSON.
 * Shape varies by source type.
 */
export interface EventSourceConfig {
  /** GitHub: organization or user login for display */
  organization?: string;
  /** Linear: workspace ID */
  workspaceId?: string;
  /** Jira: site URL */
  siteUrl?: string;
  /** Generic: custom headers to validate */
  expectedHeaders?: Record<string, string>;
  /** Any additional source-specific settings */
  [key: string]: unknown;
}

export const eventSources = sqliteTable('event_sources', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  /** Team that owns this event source */
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),

  /** Human-readable name (e.g., "Production GitHub") */
  name: text('name').notNull(),

  /** Plugin type */
  type: text('type').$type<EventSourceType>().notNull(),

  /** URL-safe slug for the webhook endpoint: POST /hooks/events/:slug */
  slug: text('slug').notNull().unique(),

  /** HMAC secret for signature verification (encrypted at rest) */
  webhookSecret: text('webhook_secret').notNull(),

  /** Whether this source is actively processing events */
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),

  /** Source-specific configuration */
  config: text('config', { mode: 'json' }).$type<EventSourceConfig>().default({}),

  /** Running count of events received */
  eventCount: integer('event_count').default(0).notNull(),

  /** Timestamp of the most recent event */
  lastEventAt: text('last_event_at'),

  /** Operational status */
  status: text('status').$type<EventSourceStatus>().default('active').notNull(),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});

export type EventSource = typeof eventSources.$inferSelect;
export type NewEventSource = typeof eventSources.$inferInsert;
```

### Indexes

```typescript
import { index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const eventSourcesIndexes = {
  /** Look up sources by team */
  teamIdx: index('event_sources_team_idx').on(eventSources.teamId),
  /** Unique slug for webhook routing */
  slugIdx: uniqueIndex('event_sources_slug_idx').on(eventSources.slug),
};
```

---

## Event Subscriptions Table

Defines a rule that maps incoming events from a source to task creation on a target project.

### Filter and Configuration Types

```typescript
/**
 * A single filter condition. All specified fields within one filter
 * must match (AND). Multiple filters on a subscription are combined
 * with OR logic.
 */
export interface SubscriptionFilter {
  /** Match by repository name or full_name (e.g., "agentpane" or "org/agentpane") */
  repository?: string;
  /** Match by branch name; supports glob patterns (e.g., "main", "release/*") */
  branch?: string;
  /** Match when event has ANY of these labels */
  labels?: string[];
  /** Match by event action (e.g., "opened", "closed", "merged") */
  action?: string;
  /** Match by author login */
  author?: string;
}
```

### Schema

```typescript
// src/db/schema/sqlite/event-subscriptions.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { TaskColumn, TaskPriority } from '../shared/enums';
import { eventSources } from './event-sources';
import { projects } from './projects';

export const eventSubscriptions = sqliteTable('event_subscriptions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  /** Human-readable name (e.g., "Bug issues -> backlog") */
  name: text('name').notNull(),

  /** The event source this subscription listens to */
  eventSourceId: text('event_source_id')
    .notNull()
    .references(() => eventSources.id, { onDelete: 'cascade' }),

  /** The project where matched events create tasks */
  targetProjectId: text('target_project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),

  /** Whether this subscription is actively matching events */
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),

  /** Event types to match (e.g., ["issues", "pull_request"]) */
  eventTypes: text('event_types', { mode: 'json' }).$type<string[]>().default([]),

  /**
   * Filter conditions. Each filter is an AND of its fields;
   * multiple filters are combined with OR.
   */
  filters: text('filters', { mode: 'json' }).$type<SubscriptionFilter[]>().default([]),

  /**
   * Prompt template with {{variable}} interpolation.
   * Rendered against the NormalizedEvent to produce task title/description.
   */
  promptTemplate: text('prompt_template').notNull(),

  /** Whether to auto-start an agent when the task is created */
  autoStartAgent: integer('auto_start_agent', { mode: 'boolean' }).default(false).notNull(),

  /** Which Kanban column to place the created task in */
  taskColumn: text('task_column').$type<TaskColumn>().default('backlog').notNull(),

  /** Priority to assign to the created task */
  taskPriority: text('task_priority').$type<TaskPriority>().default('medium'),

  /** Labels to apply to the created task */
  taskLabels: text('task_labels', { mode: 'json' }).$type<string[]>().default([]),

  /** Running count of matched events */
  matchedCount: integer('matched_count').default(0).notNull(),

  /** Timestamp of the most recent match */
  lastMatchedAt: text('last_matched_at'),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
});

export type EventSubscription = typeof eventSubscriptions.$inferSelect;
export type NewEventSubscription = typeof eventSubscriptions.$inferInsert;
```

### Indexes

```typescript
export const eventSubscriptionsIndexes = {
  /** Look up subscriptions by event source */
  eventSourceIdx: index('event_subscriptions_event_source_idx').on(
    eventSubscriptions.eventSourceId,
  ),
  /** Look up subscriptions by target project */
  targetProjectIdx: index('event_subscriptions_target_project_idx').on(
    eventSubscriptions.targetProjectId,
  ),
  /** Fast lookup of enabled subscriptions for a source during event processing */
  sourceEnabledIdx: index('event_subscriptions_source_enabled_idx').on(
    eventSubscriptions.eventSourceId,
    eventSubscriptions.isEnabled,
  ),
};
```

---

## Event Log Table

Immutable audit trail of every event received. Tracks processing status through the pipeline stages.

### Schema

```typescript
// src/db/schema/sqlite/event-log.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { EventLogStatus } from '../shared/enums';
import { eventSources } from './event-sources';

export const eventLog = sqliteTable('event_log', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  /**
   * Source that received this event.
   * SET NULL on delete to preserve audit trail even if source is removed.
   */
  eventSourceId: text('event_source_id').references(() => eventSources.id, {
    onDelete: 'set null',
  }),

  /** Normalized event type (e.g., "issues", "pull_request", "push") */
  eventType: text('event_type').notNull(),

  /** Normalized event action (e.g., "opened", "closed", "merged") */
  action: text('action'),

  /** Current processing status */
  status: text('status').$type<EventLogStatus>().default('received').notNull(),

  /** Full event payload (raw or normalized, depending on status) */
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().default({}),

  /** IDs of subscriptions that matched this event */
  matchedSubscriptions: text('matched_subscriptions', { mode: 'json' })
    .$type<string[]>()
    .default([]),

  /** Error message if processing failed at any stage */
  error: text('error'),

  /**
   * External delivery identifier for deduplication.
   * Combined with eventSourceId forms a unique constraint.
   * e.g., GitHub X-GitHub-Delivery header value.
   */
  deliveryId: text('delivery_id'),

  /** When the event was received by the webhook endpoint */
  receivedAt: text('received_at').default(sql`(datetime('now'))`).notNull(),

  /** When processing completed (success or error) */
  processedAt: text('processed_at'),
});

export type EventLogEntry = typeof eventLog.$inferSelect;
export type NewEventLogEntry = typeof eventLog.$inferInsert;
```

### Indexes

```typescript
export const eventLogIndexes = {
  /** Look up events by source */
  eventSourceIdx: index('event_log_event_source_idx').on(eventLog.eventSourceId),
  /** Chronological listing and cursor pagination */
  receivedAtIdx: index('event_log_received_at_idx').on(eventLog.receivedAt),
  /** Filter by source + status for monitoring dashboards */
  sourceStatusIdx: index('event_log_source_status_idx').on(
    eventLog.eventSourceId,
    eventLog.status,
  ),
  /**
   * Deduplication: unique per (eventSourceId, deliveryId).
   * Prevents duplicate processing from webhook retries.
   * Note: SQLite unique indexes allow multiple NULLs, so events
   * without a deliveryId are not affected.
   */
  deliveryIdx: uniqueIndex('event_log_delivery_idx').on(
    eventLog.eventSourceId,
    eventLog.deliveryId,
  ),
};
```

---

## Relations

```typescript
// Added to src/db/schema/sqlite/relations.ts

import { relations } from 'drizzle-orm';
import { eventSources } from './event-sources';
import { eventSubscriptions } from './event-subscriptions';
import { eventLog } from './event-log';
import { teams } from './teams';
import { projects } from './projects';

// Event source relations
export const eventSourcesRelations = relations(eventSources, ({ one, many }) => ({
  team: one(teams, {
    fields: [eventSources.teamId],
    references: [teams.id],
  }),
  subscriptions: many(eventSubscriptions),
  events: many(eventLog),
}));

// Event subscription relations
export const eventSubscriptionsRelations = relations(eventSubscriptions, ({ one }) => ({
  eventSource: one(eventSources, {
    fields: [eventSubscriptions.eventSourceId],
    references: [eventSources.id],
  }),
  targetProject: one(projects, {
    fields: [eventSubscriptions.targetProjectId],
    references: [projects.id],
  }),
}));

// Event log relations
export const eventLogRelations = relations(eventLog, ({ one }) => ({
  eventSource: one(eventSources, {
    fields: [eventLog.eventSourceId],
    references: [eventSources.id],
  }),
}));
```

---

## Schema Index File Update

Add exports to `src/db/schema/sqlite/index.ts`:

```typescript
// Event plugin system
export * from './event-sources';
export * from './event-subscriptions';
export * from './event-log';
```

---

## Entity Relationship Diagram

```
┌─────────────┐
│    teams     │
├─────────────┤
│ id (PK)     │
│ name        │
│ slug        │
└──────┬──────┘
       │ 1:N
       ▼
┌──────────────────┐         ┌──────────────────┐
│  event_sources   │         │    projects      │
├──────────────────┤         ├──────────────────┤
│ id (PK)          │         │ id (PK)          │
│ teamId (FK)      │         │ name             │
│ name             │         │ path             │
│ type             │         └────────▲─────────┘
│ slug (unique)    │                  │
│ webhookSecret    │                  │ targetProjectId
│ isEnabled        │                  │
│ config (JSON)    │         ┌────────┴─────────────────┐
│ eventCount       │         │  event_subscriptions     │
│ lastEventAt      │         ├──────────────────────────┤
│ status           │    1:N  │ id (PK)                  │
│ createdAt        │◄────────│ eventSourceId (FK)       │
│ updatedAt        │         │ targetProjectId (FK)     │
└──────┬───────────┘         │ name                     │
       │                     │ isEnabled                │
       │ 1:N                 │ eventTypes (JSON)        │
       ▼                     │ filters (JSON)           │
┌──────────────────┐         │ promptTemplate           │
│    event_log     │         │ autoStartAgent           │
├──────────────────┤         │ taskColumn               │
│ id (PK)          │         │ taskPriority             │
│ eventSourceId    │         │ taskLabels (JSON)        │
│   (FK, SET NULL) │         │ matchedCount             │
│ eventType        │         │ lastMatchedAt            │
│ action           │         │ createdAt                │
│ status           │         │ updatedAt                │
│ payload (JSON)   │         └──────────────────────────┘
│ matchedSubs      │
│   (JSON)         │
│ error            │
│ deliveryId       │
│ receivedAt       │
│ processedAt      │
└──────────────────┘
```

---

## Migration

```bash
# Generate migration from schema changes
bun run db:generate

# Apply migration
bun run db:migrate
```

---

## Validation Schemas (Zod)

```typescript
// src/lib/validation/event-sources.ts
import { z } from 'zod';
import { EVENT_SOURCE_TYPES, TASK_COLUMNS, TASK_PRIORITIES } from '@/db/schema/shared/enums';

export const createEventSourceSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1).max(200),
  type: z.enum(EVENT_SOURCE_TYPES),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with hyphens'),
  config: z.record(z.unknown()).optional(),
});

export const updateEventSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isEnabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

export const subscriptionFilterSchema = z.object({
  repository: z.string().optional(),
  branch: z.string().optional(),
  labels: z.array(z.string()).optional(),
  action: z.string().optional(),
  author: z.string().optional(),
});

export const createEventSubscriptionSchema = z.object({
  name: z.string().min(1).max(200),
  eventSourceId: z.string().min(1),
  targetProjectId: z.string().min(1),
  eventTypes: z.array(z.string()).min(1),
  filters: z.array(subscriptionFilterSchema).optional(),
  promptTemplate: z.string().min(1).max(10000),
  autoStartAgent: z.boolean().optional(),
  taskColumn: z.enum(TASK_COLUMNS).optional(),
  taskPriority: z.enum(TASK_PRIORITIES).optional(),
  taskLabels: z.array(z.string()).max(20).optional(),
});

export const updateEventSubscriptionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isEnabled: z.boolean().optional(),
  eventTypes: z.array(z.string()).optional(),
  filters: z.array(subscriptionFilterSchema).optional(),
  promptTemplate: z.string().min(1).max(10000).optional(),
  autoStartAgent: z.boolean().optional(),
  taskColumn: z.enum(TASK_COLUMNS).optional(),
  taskPriority: z.enum(TASK_PRIORITIES).optional(),
  taskLabels: z.array(z.string()).max(20).optional(),
});

// Type exports
export type CreateEventSourceInput = z.infer<typeof createEventSourceSchema>;
export type UpdateEventSourceInput = z.infer<typeof updateEventSourceSchema>;
export type CreateEventSubscriptionInput = z.infer<typeof createEventSubscriptionSchema>;
export type UpdateEventSubscriptionInput = z.infer<typeof updateEventSubscriptionSchema>;
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Existing Schema](../application/database/schema.md) | FK references to `teams` and `projects` tables |
| [Enums](../../src/db/schema/shared/enums.ts) | New enums added alongside existing ones |
| [Plugin Interface](./plugin-interface.md) | `EventSourceType` enum maps to plugin registry |
| [State Machine](./state-machine.md) | `EventLogStatus` enum tracks pipeline stages |
| [API Endpoints](./api-endpoints.md) | CRUD operations on these tables |
