import { createId } from '@paralleldrive/cuid2';
import type {
  EventSource,
  EventSubscription,
  NewEventSource,
  NewEventSubscription,
} from '../../src/db/schema';
import { eventSources, eventSubscriptions } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

export type EventSourceFactoryOptions = Partial<NewEventSource>;

export function buildEventSource(options: EventSourceFactoryOptions = {}): NewEventSource {
  const id = options.id ?? createId();
  return {
    id,
    teamId: options.teamId ?? createId(),
    name: options.name ?? `Test Source ${id.slice(0, 6)}`,
    type: options.type ?? 'github',
    slug: options.slug ?? `test-source-${id.slice(0, 6)}`,
    webhookSecret: options.webhookSecret ?? null,
    isEnabled: options.isEnabled ?? true,
    config: options.config ?? {},
    eventCount: options.eventCount ?? 0,
    status: options.status ?? 'active',
    createdAt: options.createdAt ?? new Date().toISOString(),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestEventSource(
  options: EventSourceFactoryOptions = {}
): Promise<EventSource> {
  const db = getTestDb();
  const data = buildEventSource(options);
  const [source] = await db.insert(eventSources).values(data).returning();
  if (!source) throw new Error('Failed to create test event source');
  return source;
}

export type SubscriptionFactoryOptions = Partial<NewEventSubscription>;

export function buildSubscription(options: SubscriptionFactoryOptions = {}): NewEventSubscription {
  const id = options.id ?? createId();
  return {
    id,
    name: options.name ?? `Test Sub ${id.slice(0, 6)}`,
    eventSourceId: options.eventSourceId ?? createId(),
    targetCodespaceId: options.targetCodespaceId ?? createId(),
    isEnabled: options.isEnabled ?? true,
    eventTypes: options.eventTypes ?? [],
    filters: options.filters ?? [],
    promptTemplate: options.promptTemplate ?? 'Handle: {{issue.title}}',
    autoStartAgent: options.autoStartAgent ?? false,
    taskColumn: options.taskColumn ?? 'backlog',
    taskPriority: options.taskPriority ?? 'medium',
    taskLabels: options.taskLabels ?? [],
    matchedCount: options.matchedCount ?? 0,
    createdAt: options.createdAt ?? new Date().toISOString(),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestSubscription(
  options: SubscriptionFactoryOptions = {}
): Promise<EventSubscription> {
  const db = getTestDb();
  const data = buildSubscription(options);
  const [sub] = await db.insert(eventSubscriptions).values(data).returning();
  if (!sub) throw new Error('Failed to create test subscription');
  return sub;
}
