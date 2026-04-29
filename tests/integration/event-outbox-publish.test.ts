/**
 * Regression test for F05-19 — `DurableStreamsService.publish()` must enqueue
 * a row to `event_outbox` for non-ephemeral streams (and the
 * `EventOutboxRelayService` must drain it). Before the fix, the publish path
 * went directly to Caddy with a debug-level swallow on failure and the
 * outbox table was untouched, so this test fails on `main` (no row in
 * `event_outbox` after publish) and passes after the wire-up.
 *
 * The test deliberately uses a stub Caddy server so the relay can simulate
 * both the success path (mark `published`) and the failure path (row stays
 * `pending`). Real Drizzle is used per CLAUDE.md (no DB mocks).
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventOutbox } from '../../src/db/schema/sqlite/event-outbox.js';
import {
  type DurableStreamsServer,
  DurableStreamsService,
} from '../../src/services/durable-streams.service.js';
import { EventOutboxRelayService } from '../../src/services/event-outbox-relay.service.js';
import { createTestProject } from '../factories/project.factory.js';
import { createTestSession } from '../factories/session.factory.js';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database.js';

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

describe('F05-19 — DurableStreamsService.publish enqueues to event_outbox', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('writes a pending row to event_outbox on publish (non-ephemeral)', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const session = await createTestSession(project.id);

    const server = makeStubServer();
    const streams = new DurableStreamsService(server, db);

    // Publish a session-typed event to a bare CUID (session) stream.
    // Before F05-19 fix: server.publish is called directly, no outbox row.
    // After fix: an outbox row is enqueued and server.publish is NOT called
    //            from publish() (the relay will call it).
    const result = await streams.publish(session.id, 'container-agent:token', {
      sessionId: session.id,
      taskId: 'task-1',
      delta: 'hello',
    });

    expect(result.ok).toBe(true);

    // FAIL on main: outbox is empty because publish() goes straight to Caddy.
    // PASS with fix: a single pending outbox row exists.
    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.streamId, session.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.type).toBe('container-agent:token');

    // The relay (not publish()) is now responsible for delivery.
    expect(server.publish).not.toHaveBeenCalled();
  });

  it('relay drains the outbox row and delivers to the streams server', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const session = await createTestSession(project.id);

    const server = makeStubServer();
    const streams = new DurableStreamsService(server, db);
    const relay = new EventOutboxRelayService(db, server);
    relay.start();

    const publishResult = await streams.publish(session.id, 'container-agent:token', {
      sessionId: session.id,
      taskId: 'task-2',
      delta: 'drain me',
    });
    expect(publishResult.ok).toBe(true);

    // Drain the outbox synchronously.
    await relay.tick();

    // The relay should have called server.publish exactly once with our event.
    expect(server.publish).toHaveBeenCalledTimes(1);
    expect(server.publish).toHaveBeenCalledWith(
      session.id,
      'container-agent:token',
      expect.objectContaining({ delta: 'drain me' })
    );

    // Row should now be `published`.
    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.streamId, session.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('published');

    await relay.stop();
  });

  it('skips outbox for ephemeral terraform streams (still publishes directly)', async () => {
    const db = getTestDb();
    const server = makeStubServer();
    const streams = new DurableStreamsService(server, db);

    const result = await streams.publish('terraform:job-1', 'terraform:text', {
      sessionId: 'job-1',
      delta: 'ephemeral chunk',
    });
    expect(result.ok).toBe(true);

    // Ephemeral streams still publish directly to Caddy (no outbox).
    expect(server.publish).toHaveBeenCalledTimes(1);

    // No outbox row for terraform.
    const rows = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.streamId, 'terraform:job-1'));
    expect(rows).toHaveLength(0);
  });

  it('persists to session_events even when outbox enqueue runs (durable replay)', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const session = await createTestSession(project.id);

    const server = makeStubServer();
    const streams = new DurableStreamsService(server, db);

    await streams.publish(session.id, 'container-agent:token', {
      sessionId: session.id,
      taskId: 'task-persist',
      delta: 'persist me',
    });

    // The session_events row is the durable replay record. The outbox is
    // separate — it's the live-delivery queue. Both must exist for
    // non-ephemeral streams.
    const sessionEvents = await db.query.sessionEvents.findMany({
      where: (t, { eq: eqOp }) => eqOp(t.sessionId, session.id),
    });
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]?.type).toBe('container-agent:token');

    const outboxRows = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.streamId, session.id));
    expect(outboxRows).toHaveLength(1);
  });
});
