/**
 * F05-05: Event outbox relay.
 *
 * Verifies:
 *   1. Enqueuing an event makes it visible to the relay on tick().
 *   2. A successful publish marks the row `published`.
 *   3. A publish failure bumps attempts and schedules a retry.
 *   4. Retention trim removes old `published` rows (not called here, but
 *      the counts assertion verifies rows persist until explicitly trimmed).
 */

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventOutbox } from '../../src/db/schema/sqlite/event-outbox.js';
import type { DurableStreamsServer } from '../../src/services/durable-streams.service.js';
import {
  EventOutboxRelayService,
  enqueueOutboxEvent,
} from '../../src/services/event-outbox-relay.service.js';
import { getTestDb } from '../helpers/database.js';

function makeStubServer(overrides?: Partial<DurableStreamsServer>): DurableStreamsServer {
  return {
    createStream: vi.fn(async () => undefined),
    publish: vi.fn(async () => 0),
    subscribe: (() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined };
          },
        };
      },
    })) as DurableStreamsServer['subscribe'],
    ...overrides,
  };
}

describe('EventOutboxRelayService (F05-05)', () => {
  let relay: EventOutboxRelayService | null = null;

  beforeEach(async () => {
    relay = null;
  });

  it('publishes pending rows and marks them published on success', async () => {
    const db = getTestDb();
    const server = makeStubServer();
    relay = new EventOutboxRelayService(db, server);
    relay.start();

    await enqueueOutboxEvent(db, {
      streamId: 'sess-1',
      type: 'container-agent:token',
      payload: { sessionId: 'sess-1', taskId: 't-1', delta: 'hello' },
    });

    // Run one tick synchronously to drain the batch.
    await relay.tick();

    expect(server.publish).toHaveBeenCalledTimes(1);
    expect(server.publish).toHaveBeenCalledWith(
      'sess-1',
      'container-agent:token',
      expect.objectContaining({ delta: 'hello' })
    );

    const counts = await relay.getCounts();
    expect(counts.pending).toBe(0);
    expect(counts.published).toBe(1);

    await relay.stop();
  });

  it('schedules a retry on transient failure without marking dead', async () => {
    const db = getTestDb();
    let call = 0;
    const server = makeStubServer({
      publish: vi.fn(async () => {
        call++;
        throw new Error(`transient fail ${call}`);
      }),
    });
    relay = new EventOutboxRelayService(db, server);
    relay.start();

    await enqueueOutboxEvent(db, {
      streamId: 'sess-2',
      type: 'container-agent:status',
      payload: {
        sessionId: 'sess-2',
        taskId: 't-2',
        stage: 'running',
        message: 'x',
      },
    });

    await relay.tick();

    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.streamId, 'sess-2'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain('transient fail');

    await relay.stop();
  });

  it('marks row dead after 10 failed attempts', async () => {
    const db = getTestDb();
    const server = makeStubServer({
      publish: vi.fn(async () => {
        throw new Error('always broken');
      }),
    });
    relay = new EventOutboxRelayService(db, server);
    relay.start();

    await enqueueOutboxEvent(db, {
      streamId: 'sess-dead',
      type: 'plan:error',
      payload: { sessionId: 'sess-dead', error: 'x' },
    });

    // Tick 10 times, each time forcing the row to be due.
    for (let i = 0; i < 10; i++) {
      // Reset nextAttemptAt to now so the relay picks it up again immediately.
      await db
        .update(eventOutbox)
        .set({ nextAttemptAt: new Date(0).toISOString() })
        .where(eq(eventOutbox.streamId, 'sess-dead'));
      await relay.tick();
    }

    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.streamId, 'sess-dead'));
    expect(rows[0]?.status).toBe('dead');
    expect(rows[0]?.attempts).toBeGreaterThanOrEqual(10);

    await relay.stop();
  });
});
