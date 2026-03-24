import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import type { DurableStreamsServer } from '../../src/services/durable-streams.service';
import { SessionStreamService } from '../../src/services/session/session-stream.service';
import type { SessionEvent } from '../../src/services/session/types';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockStreams(): DurableStreamsServer {
  return {
    publish: vi.fn().mockResolvedValue(0),
    createStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as DurableStreamsServer;
}

function buildStructuredEvent(sessionId: string, type: string, index: number): SessionEvent {
  const eventId = createId();
  return {
    id: eventId,
    type: type as SessionEvent['type'],
    timestamp: Date.now() + index,
    data: {
      meta: {
        schemaVersion: 1,
        eventId,
        streamId: sessionId,
        blockId: null,
        partType: 'lifecycle',
        durability: 'durable',
        sequence: null,
        createdAt: new Date().toISOString(),
      },
      content: `Event data ${index}`,
    },
  };
}

describe('IT-003: Session Event Persistence', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('persists 10 events with sequential offsets 0-9', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    const persistedOffsets: number[] = [];

    for (let i = 0; i < 10; i++) {
      const event = buildStructuredEvent(session.id, 'agent:turn', i);
      const result = await streamService.persistEvent(session.id, event);
      expect(result.ok).toBe(true);
      if (result.ok) {
        persistedOffsets.push(result.value.offset);
      }
    }

    // Offsets should be sequential 0-9
    expect(persistedOffsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Query DB directly to verify all rows
    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
      orderBy: [sessionEvents.offset],
    });

    expect(rows).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(rows[i].offset).toBe(i);
    }

    // Verify offsets are unique
    const offsets = rows.map((r) => r.offset);
    expect(new Set(offsets).size).toBe(10);
  });

  it('getEventsBySession returns events in offset order', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    // Persist events
    for (let i = 0; i < 5; i++) {
      const event = buildStructuredEvent(session.id, 'agent:turn', i);
      await streamService.persistEvent(session.id, event);
    }

    const result = await streamService.getEventsBySession(session.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(5);
    // Verify they come back with ascending timestamps (they were persisted in order)
    for (let i = 1; i < result.value.length; i++) {
      expect(result.value[i].timestamp).toBeGreaterThanOrEqual(result.value[i - 1].timestamp);
    }
  });

  it('rejects events with mismatched streamId', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    const eventId = createId();
    const event: SessionEvent = {
      id: eventId,
      type: 'agent:turn',
      timestamp: Date.now(),
      data: {
        meta: {
          schemaVersion: 1,
          eventId,
          streamId: 'wrong-session-id',
          blockId: null,
          partType: 'lifecycle',
          durability: 'durable',
          sequence: null,
          createdAt: new Date().toISOString(),
        },
      },
    };

    const result = await streamService.persistEvent(session.id, event);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('SESSION_STREAM_PROTOCOL_MISMATCH');
  });

  it('returns SESSION_NOT_FOUND for nonexistent session', async () => {
    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    const event = buildStructuredEvent('nonexistent-session', 'agent:turn', 0);
    const result = await streamService.persistEvent('nonexistent-session', event);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });
});
