import { createId } from '@paralleldrive/cuid2';
import type { NewSessionEvent, SessionEvent } from '../../src/db/schema';
import { sessionEvents } from '../../src/db/schema';
import type { StreamIdKind } from '../../src/lib/streams/stream-id';
import { getTestDb } from '../helpers/database';

export type SessionEventFactoryOptions = Partial<Omit<NewSessionEvent, 'sessionId'>>;

export function buildSessionEvent(
  sessionId: string,
  options: SessionEventFactoryOptions = {}
): NewSessionEvent {
  return {
    id: options.id ?? createId(),
    sessionId,
    streamKind: (options.streamKind as StreamIdKind | undefined) ?? 'session',
    offset: options.offset ?? 0,
    type: options.type ?? 'chunk',
    channel: options.channel ?? 'chunks',
    data: options.data ?? { text: 'test chunk' },
    timestamp: options.timestamp ?? Date.now(),
    userId: options.userId ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

export async function createTestSessionEvent(
  sessionId: string,
  options: SessionEventFactoryOptions = {}
): Promise<SessionEvent> {
  const db = getTestDb();
  const data = buildSessionEvent(sessionId, options);
  const [event] = await db.insert(sessionEvents).values(data).returning();

  if (!event) {
    throw new Error('Failed to create test session event');
  }

  return event;
}
