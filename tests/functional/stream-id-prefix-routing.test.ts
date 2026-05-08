import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import { planStreamId, sandboxStreamId } from '../../src/lib/streams/stream-id';
import { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createStreamPayloadWithMetadata } from '../../src/services/session/event-metadata';
import { type SessionEvent, SessionService } from '../../src/services/session.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams } from '../helpers/mocks';

describe('stream id prefix routing', () => {
  let db: ReturnType<typeof getTestDb>;
  let sessionService: SessionService;
  let durableStreams: DurableStreamsService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    const streams = createInMemoryStreams();
    sessionService = new SessionService(db as never, streams, {
      baseUrl: 'http://localhost:3000',
    });
    durableStreams = new DurableStreamsService(streams, db as never);
  });

  afterEach(async () => {
    sessionService.destroy();
    await clearTestDatabase();
  });

  function makeSessionEvent(sessionId: string): SessionEvent {
    const eventId = createId();
    return {
      id: eventId,
      type: 'chunk',
      timestamp: Date.now(),
      data: createStreamPayloadWithMetadata({
        streamId: sessionId,
        eventId,
        blockId: createId(),
        partType: 'chunk_delta',
        timestamp: Date.now(),
        data: { text: 'session-only' },
      }),
    };
  }

  it('keeps plan and sandbox stream rows out of session.getEventsBySession()', async () => {
    const codespace = await createTestProject({ name: 'Stream Routing' });
    const task = await createTestTask(codespace.id);
    const session = await createTestSession(codespace.id, { taskId: task.id });

    const sessionPublish = await sessionService.publish(session.id, makeSessionEvent(session.id));
    expect(sessionPublish.ok).toBe(true);

    const planPublish = await durableStreams.publish(planStreamId(task.id), 'plan:started', {
      sessionId: session.id,
      taskId: task.id,
      codespaceId: codespace.id,
    });
    expect(planPublish.ok).toBe(true);

    const sandboxPublish = await durableStreams.publish(
      sandboxStreamId('sandbox-1'),
      'sandbox:ready',
      {
        sandboxId: 'sandbox-1',
        codespaceId: codespace.id,
        containerId: 'container-1',
      }
    );
    expect(sandboxPublish.ok).toBe(true);

    const sessionHistory = await sessionService.getEventsBySession(session.id);
    expect(sessionHistory.ok).toBe(true);
    if (!sessionHistory.ok) {
      throw new Error('Expected session history lookup to succeed');
    }
    expect(sessionHistory.value.map((event) => event.type)).toEqual(['chunk']);

    const persistedRows = await db.query.sessionEvents.findMany({
      where: inArray(sessionEvents.sessionId, [
        session.id,
        planStreamId(task.id),
        'sandbox:sandbox-1',
      ]),
    });
    expect(persistedRows.map((row) => row.streamKind).sort()).toEqual([
      'plan',
      'sandbox',
      'session',
    ]);
  });

  it('rejects plan events published to a bare session stream id', async () => {
    const codespace = await createTestProject({ name: 'Stream Routing Reject' });
    const task = await createTestTask(codespace.id);
    const session = await createTestSession(codespace.id, { taskId: task.id });

    const result = await durableStreams.publish(session.id, 'plan:started', {
      sessionId: session.id,
      taskId: task.id,
      codespaceId: codespace.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STREAM_PROTOCOL_MISMATCH');
    }

    const misrouted = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
    });
    expect(misrouted).toEqual([]);
  });
});
