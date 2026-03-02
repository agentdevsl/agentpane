/**
 * Frontend types for the event system.
 *
 * These mirror the backend plugin-interface and database schema types
 * but are shaped for client-side consumption (string dates, serialized JSON).
 */

import type {
  EventLogStatus,
  EventSourceStatus,
  EventSourceType,
} from '../../db/schema/shared/enums';
import type { SubscriptionFilter } from './plugin-interface';

// Re-export so consumers only need one import
export type { EventLogStatus, EventSourceStatus, EventSourceType, SubscriptionFilter };

// ---- Entity types ----

export interface EventSource {
  id: string;
  teamId: string;
  name: string;
  type: EventSourceType;
  slug: string;
  isEnabled: boolean;
  config: Record<string, unknown>;
  eventCount: number;
  lastEventAt: string | null;
  status: EventSourceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EventSubscription {
  id: string;
  name: string;
  eventSourceId: string;
  targetProjectId: string;
  isEnabled: boolean;
  eventTypes: string[];
  filters: SubscriptionFilter[];
  promptTemplate: string;
  autoStartAgent: boolean;
  taskColumn: string;
  taskPriority: string;
  taskLabels: string[];
  matchedCount: number;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventLogEntry {
  id: string;
  eventSourceId: string | null;
  eventType: string;
  action: string | null;
  status: EventLogStatus;
  payload: Record<string, unknown>;
  matchedSubscriptions: Array<{ subscriptionId: string; taskId?: string }>;
  error: string | null;
  deliveryId: string;
  receivedAt: string;
  processedAt: string | null;
}

// ---- Input types ----

export interface CreateEventSourceInput {
  teamId: string;
  name: string;
  type: EventSourceType;
  webhookSecret?: string;
  config?: Record<string, unknown>;
}

export interface UpdateEventSourceInput {
  name?: string;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
}

export interface CreateSubscriptionInput {
  name: string;
  eventSourceId: string;
  targetProjectId: string;
  eventTypes?: string[];
  filters?: SubscriptionFilter[];
  promptTemplate: string;
  autoStartAgent?: boolean;
  taskColumn?: string;
  taskPriority?: string;
  taskLabels?: string[];
}

export interface UpdateSubscriptionInput {
  name?: string;
  isEnabled?: boolean;
  eventTypes?: string[];
  filters?: SubscriptionFilter[];
  promptTemplate?: string;
  autoStartAgent?: boolean;
  taskColumn?: string;
  taskPriority?: string;
  taskLabels?: string[];
}
