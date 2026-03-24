import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents, sessions } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Session Event Replay (IT-010)', () => {
  let codespaceId: string;
  let sessionId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    const project = await createTestProject({ name: 'Event Replay Test' });
    codespaceId = project.id;
    const session = await createTestSession(codespaceId);
    sessionId = session.id;
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  async function insertEvent(
    db: ReturnType<typeof getTestDb>,
    opts: { sessId: string; offset: number; type: string; data: unknown }
  ) {
    const id = createId();
    await db.insert(sessionEvents).values({
      id,
      sessionId: opts.sessId,
      offset: opts.offset,
      type: opts.type,
      channel: opts.type.startsWith('agent:') ? 'agent' : 'other',
      data: opts.data,
      timestamp: Date.now() + opts.offset,
    });
    return id;
  }

  it('persisted events are retrievable in offset order', async () => {
    const db = getTestDb();

    await insertEvent(db, {
      sessId: sessionId,
      offset: 0,
      type: 'agent:started',
      data: { model: 'claude' },
    });
    await insertEvent(db, { sessId: sessionId, offset: 1, type: 'chunk', data: { text: 'hello' } });
    await insertEvent(db, {
      sessId: sessionId,
      offset: 2,
      type: 'tool:start',
      data: { tool: 'Bash' },
    });
    await insertEvent(db, {
      sessId: sessionId,
      offset: 3,
      type: 'tool:result',
      data: { result: 'ok' },
    });
    await insertEvent(db, {
      sessId: sessionId,
      offset: 4,
      type: 'agent:completed',
      data: { turns: 5 },
    });

    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
      orderBy: [sessionEvents.offset],
    });

    expect(events.length).toBe(5);
    expect(events[0].type).toBe('agent:started');
    expect(events[1].type).toBe('chunk');
    expect(events[2].type).toBe('tool:start');
    expect(events[3].type).toBe('tool:result');
    expect(events[4].type).toBe('agent:completed');

    for (let i = 0; i < events.length; i++) {
      expect(events[i].offset).toBe(i);
    }
  });

  it('limit/offset pagination returns correct subsets', async () => {
    const db = getTestDb();

    for (let i = 0; i < 10; i++) {
      await insertEvent(db, {
        sessId: sessionId,
        offset: i,
        type: 'chunk',
        data: { text: `msg-${i}` },
      });
    }

    // Page 1: offset=0, limit=3
    const page1 = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
      orderBy: [sessionEvents.offset],
      limit: 3,
      offset: 0,
    });
    expect(page1.length).toBe(3);
    expect(page1[0].offset).toBe(0);
    expect(page1[2].offset).toBe(2);

    // Page 2: offset=3, limit=3
    const page2 = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
      orderBy: [sessionEvents.offset],
      limit: 3,
      offset: 3,
    });
    expect(page2.length).toBe(3);
    expect(page2[0].offset).toBe(3);
    expect(page2[2].offset).toBe(5);

    // Last page: offset=9, limit=3
    const lastPage = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
      orderBy: [sessionEvents.offset],
      limit: 3,
      offset: 9,
    });
    expect(lastPage.length).toBe(1);
    expect(lastPage[0].offset).toBe(9);
  });

  it('events from different sessions are isolated', async () => {
    const db = getTestDb();
    const otherSession = await createTestSession(codespaceId);

    await insertEvent(db, {
      sessId: sessionId,
      offset: 0,
      type: 'chunk',
      data: { text: 'session-1' },
    });
    await insertEvent(db, {
      sessId: sessionId,
      offset: 1,
      type: 'chunk',
      data: { text: 'session-1' },
    });
    await insertEvent(db, {
      sessId: otherSession.id,
      offset: 0,
      type: 'chunk',
      data: { text: 'session-2' },
    });

    const session1Events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
    });
    const session2Events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, otherSession.id),
    });

    expect(session1Events.length).toBe(2);
    expect(session2Events.length).toBe(1);
  });

  it('event data is stored and retrieved as JSON', async () => {
    const db = getTestDb();
    const complexData = {
      tool: 'Bash',
      args: { command: 'ls -la' },
      nested: { deep: { value: 42 } },
    };

    await insertEvent(db, { sessId: sessionId, offset: 0, type: 'tool:start', data: complexData });

    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
    });

    expect(events.length).toBe(1);
    const stored = events[0].data as typeof complexData;
    expect(stored.tool).toBe('Bash');
    expect(stored.args.command).toBe('ls -la');
    expect(stored.nested.deep.value).toBe(42);
  });

  it('session deletion cascades to events', async () => {
    const db = getTestDb();

    await insertEvent(db, { sessId: sessionId, offset: 0, type: 'chunk', data: { text: 'bye' } });
    await insertEvent(db, { sessId: sessionId, offset: 1, type: 'chunk', data: { text: 'bye2' } });

    // Verify events exist
    const before = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
    });
    expect(before.length).toBe(2);

    // Delete the session
    await db.delete(sessions).where(eq(sessions.id, sessionId));

    // Events should be cascade-deleted
    const after = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, sessionId),
    });
    expect(after.length).toBe(0);
  });
});
