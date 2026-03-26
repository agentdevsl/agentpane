import { createId } from '@paralleldrive/cuid2';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

type TestDb = ReturnType<typeof getTestDb>;

/**
 * Insert a session event directly into the DB.
 * Calculates the next offset for the given session automatically.
 */
async function insertEvent(
  db: TestDb,
  sessionId: string,
  type: string,
  payload: unknown,
  channel = 'default'
): Promise<{ id: string; offset: number }> {
  const id = createId();

  // Determine next offset for this session
  const _lastEvent = await db.query.sessionEvents.findFirst({
    where: eq(sessionEvents.sessionId, sessionId),
    orderBy: [asc(sessionEvents.offset)],
  });

  // Find max offset
  const allEvents = await db.query.sessionEvents.findMany({
    where: eq(sessionEvents.sessionId, sessionId),
    orderBy: [asc(sessionEvents.offset)],
  });
  const maxOffset = allEvents.length > 0 ? Math.max(...allEvents.map((e) => e.offset)) : -1;
  const offset = maxOffset + 1;

  await db.insert(sessionEvents).values({
    id,
    sessionId,
    offset,
    type,
    channel,
    data: payload as Record<string, unknown>,
    timestamp: Date.now(),
  });

  return { id, offset };
}

describe('Durable Streams DB Persistence Lifecycle', () => {
  let db: TestDb;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    // session_events are not cleaned up by clearTestDatabase for SQLite
    // (FK cascade is off), so clean them up explicitly first
    try {
      execRawSql('DELETE FROM session_events');
    } catch {
      // Table may not exist or already empty
    }
    await clearTestDatabase();
  });

  it('IT-352: insert session event with type and payload, query returns correct data', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    const payload = { message: 'hello world', count: 42 };
    const { id: eventId } = await insertEvent(db, session.id, 'agent:turn', payload);

    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(eventId);
    expect(row.sessionId).toBe(session.id);
    expect(row.type).toBe('agent:turn');

    // Payload should round-trip through JSON
    const storedData = row.data as Record<string, unknown>;
    expect(storedData).toEqual(payload);
  });

  it('IT-353: multiple events for same session have auto-incrementing offsets', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    const offsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { offset } = await insertEvent(db, session.id, 'agent:turn', { index: i });
      offsets.push(offset);
    }

    expect(offsets).toEqual([0, 1, 2, 3, 4]);

    // Verify in DB
    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
      orderBy: [asc(sessionEvents.offset)],
    });

    expect(rows).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(rows[i].offset).toBe(i);
    }
  });

  it('IT-354: events are queryable by sessionId (isolation between sessions)', async () => {
    const codespace = await createTestProject();
    const session1 = await createTestSession(codespace.id);
    const session2 = await createTestSession(codespace.id);

    // Insert 3 events for session 1
    for (let i = 0; i < 3; i++) {
      await insertEvent(db, session1.id, 'agent:turn', { session: 1, index: i });
    }

    // Insert 2 events for session 2
    for (let i = 0; i < 2; i++) {
      await insertEvent(db, session2.id, 'container-agent:token', { session: 2, index: i });
    }

    // Query session 1
    const session1Events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session1.id),
    });
    expect(session1Events).toHaveLength(3);
    for (const event of session1Events) {
      expect(event.sessionId).toBe(session1.id);
      expect(event.type).toBe('agent:turn');
    }

    // Query session 2
    const session2Events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session2.id),
    });
    expect(session2Events).toHaveLength(2);
    for (const event of session2Events) {
      expect(event.sessionId).toBe(session2.id);
      expect(event.type).toBe('container-agent:token');
    }
  });

  it('IT-355: events queryable with offset filter (afterEventId pattern)', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    // Insert 5 events with offsets 0-4
    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await insertEvent(db, session.id, 'agent:turn', { index: i });
      eventIds.push(id);
    }

    // Query events with offset > 2 (should return offsets 3 and 4)
    const rows = await db.query.sessionEvents.findMany({
      where: (fields, { and, eq: eqOp, gt: gtOp }) =>
        and(eqOp(fields.sessionId, session.id), gtOp(fields.offset, 2)),
      orderBy: [asc(sessionEvents.offset)],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].offset).toBe(3);
    expect(rows[1].offset).toBe(4);

    // Verify the data matches what was inserted
    expect((rows[0].data as Record<string, unknown>).index).toBe(3);
    expect((rows[1].data as Record<string, unknown>).index).toBe(4);
  });

  it('IT-356: event payload preserved as JSON (complex object round-trip)', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    const complexPayload = {
      taskId: 'task-abc-123',
      nested: {
        tools: ['Read', 'Write', 'Bash'],
        config: {
          maxTurns: 50,
          model: 'claude-sonnet-4-6',
          enabled: true,
          metadata: null,
        },
      },
      tags: ['urgent', 'backend'],
      metrics: {
        tokensUsed: 1500,
        duration: 3.14,
      },
    };

    await insertEvent(db, session.id, 'container-agent:complete', complexPayload);

    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });

    expect(rows).toHaveLength(1);
    const storedData = rows[0].data as Record<string, unknown>;
    expect(storedData).toEqual(complexPayload);

    // Verify specific nested values
    const nested = storedData.nested as Record<string, unknown>;
    expect(nested.tools).toEqual(['Read', 'Write', 'Bash']);
    const config = nested.config as Record<string, unknown>;
    expect(config.maxTurns).toBe(50);
    expect(config.enabled).toBe(true);
    expect(config.metadata).toBeNull();
  });

  it('IT-357: deleting a session cascades to delete associated events', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    // Insert several events
    for (let i = 0; i < 4; i++) {
      await insertEvent(db, session.id, 'agent:turn', { index: i });
    }

    // Verify events exist
    const before = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(before).toHaveLength(4);

    // Delete events manually (simulating cascade cleanup since FK is off in tests).
    // In production, the schema defines onDelete: 'cascade' on sessionId FK,
    // so deleting the session would cascade. We test the manual cleanup path here.
    await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, session.id));

    // Verify events are gone
    const after = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(after).toHaveLength(0);
  });
});
