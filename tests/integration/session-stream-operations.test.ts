import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents, sessionSummaries } from '../../src/db/schema';
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

describe('Session Stream Operations (IT-096 to IT-100)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-096: persist session events with sequential offsets', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    const offsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      const event = buildStructuredEvent(session.id, 'agent:turn', i);
      const result = await streamService.persistEvent(session.id, event);
      expect(result.ok).toBe(true);
      if (result.ok) {
        offsets.push(result.value.offset);
      }
    }

    // Offsets should be sequential 0-4
    expect(offsets).toEqual([0, 1, 2, 3, 4]);

    // Verify in DB
    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
      orderBy: [sessionEvents.offset],
    });

    expect(rows).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(rows[i].offset).toBe(i);
    }
  });

  it('IT-097: event persists to DB even when stream publish throws', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const mockStreams = createMockStreams();
    // Make the real-time stream throw
    (mockStreams.publish as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Stream unavailable')
    );
    const streamService = new SessionStreamService(db as any, mockStreams);

    const event = buildStructuredEvent(session.id, 'agent:started', 0);
    const result = await streamService.publish(session.id, event);

    // Publish should still succeed (DB-first strategy)
    expect(result.ok).toBe(true);

    // Verify event is in DB despite stream failure
    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('agent:started');
  });

  it('IT-098: query events in offset order for history replay', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    // Insert 5 events with various types
    const eventTypes = ['agent:started', 'chunk', 'tool:start', 'tool:result', 'agent:completed'];
    for (let i = 0; i < eventTypes.length; i++) {
      const event = buildStructuredEvent(session.id, eventTypes[i], i);
      await streamService.persistEvent(session.id, event);
    }

    // Retrieve via getEventsBySession
    const result = await streamService.getEventsBySession(session.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(5);

    // Verify order matches insertion order (by offset)
    expect(result.value[0].type).toBe('agent:started');
    expect(result.value[1].type).toBe('chunk');
    expect(result.value[2].type).toBe('tool:start');
    expect(result.value[3].type).toBe('tool:result');
    expect(result.value[4].type).toBe('agent:completed');

    // Verify ascending timestamp order
    for (let i = 1; i < result.value.length; i++) {
      expect(result.value[i].timestamp).toBeGreaterThanOrEqual(result.value[i - 1].timestamp);
    }
  });

  it('IT-099: persist-only pattern inserts event directly to DB without stream', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    const event = buildStructuredEvent(session.id, 'chunk', 0);
    const result = await streamService.persistOnly(session.id, event);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.offset).toBe(0);

    // Verify in DB
    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('chunk');
    expect(rows[0].channel).toBe('chunks');

    // streams.publish should NOT have been called (persistOnly skips real-time)
    expect(mockStreams.publish).not.toHaveBeenCalled();
  });

  it('IT-100: create and update sessionSummary for a session', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id, { status: 'active' });

    const mockStreams = createMockStreams();
    const streamService = new SessionStreamService(db as any, mockStreams);

    // Create summary via updateSessionSummary (creates if not exists)
    const createResult = await streamService.updateSessionSummary(session.id, {
      turnsCount: 5,
      tokensUsed: 1000,
      filesModified: 3,
      finalStatus: 'success',
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    expect(createResult.value.sessionId).toBe(session.id);
    expect(createResult.value.turnsCount).toBe(5);
    expect(createResult.value.tokensUsed).toBe(1000);
    expect(createResult.value.filesModified).toBe(3);
    expect(createResult.value.finalStatus).toBe('success');

    // Update existing summary
    const updateResult = await streamService.updateSessionSummary(session.id, {
      turnsCount: 10,
      tokensUsed: 2500,
      linesAdded: 150,
      linesRemoved: 30,
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;

    expect(updateResult.value.turnsCount).toBe(10);
    expect(updateResult.value.tokensUsed).toBe(2500);
    expect(updateResult.value.linesAdded).toBe(150);
    expect(updateResult.value.linesRemoved).toBe(30);

    // Verify only one summary exists (update, not duplicate)
    const allSummaries = await db.query.sessionSummaries.findMany({
      where: eq(sessionSummaries.sessionId, session.id),
    });
    expect(allSummaries).toHaveLength(1);

    // Verify via getSummary
    const getResult = await streamService.getSessionSummary(session.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).not.toBeNull();
    expect(getResult.value!.turnsCount).toBe(10);
    expect(getResult.value!.tokensUsed).toBe(2500);
  });
});
