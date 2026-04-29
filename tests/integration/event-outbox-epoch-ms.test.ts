/**
 * F02-18 (arch29-W2-R): event_outbox timestamps round-trip as epoch ms.
 *
 * Before this PR the SQLite event_outbox stored ISO-string timestamps in
 * `text` columns while the PG counterpart used `timestamptz` — Drizzle's
 * `lte(eventOutbox.nextAttemptAt, now)` comparison was lex-string on SQLite
 * and required `now` to be a UTC ISO string for the ordering to match
 * numeric semantics. With this PR both dialects use INTEGER / BIGINT epoch
 * ms and Drizzle returns them as JS `number`.
 *
 * This test verifies the round-trip on the SQLite side (the only dialect
 * exercised in unit/integration tests; PG is exercised separately via the
 * gated `pg-migration-safety.test.ts`):
 *   - inserting a row stores a numeric epoch ms (not a string)
 *   - selecting the row returns a JS number
 *   - the relay's `lte(nextAttemptAt, Date.now())` filter works numerically
 *
 * before:test_name (FAIL) — `nextAttemptAt` was a `text` column; selects
 *   returned an ISO string and `Date.now()` numeric comparison threw or
 *   silently mismatched
 * after:test_name (PASS) — `nextAttemptAt` is `integer` (epoch ms); selects
 *   return a number and `Date.now()` comparison is numeric
 */

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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

describe('event_outbox epoch-ms timestamps (F02-18)', () => {
  it('persists and reads `nextAttemptAt` as a JS number (epoch ms)', async () => {
    const db = getTestDb();

    const before = Date.now();
    await enqueueOutboxEvent(db, {
      streamId: 'sess-epoch-ms',
      type: 'container-agent:token',
      payload: { delta: 'x' },
    });
    const after = Date.now();

    const rows = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.streamId, 'sess-epoch-ms'));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('row missing');

    // Round-trip type contract: `number`, not `Date` (we use raw `integer`
    // on SQLite and `bigint+number` on PG, so the value comes back as a
    // primitive number).
    expect(typeof row.nextAttemptAt).toBe('number');
    expect(typeof row.createdAt).toBe('number');
    // publishedAt is null for unprocessed rows.
    expect(row.publishedAt).toBeNull();

    // Sanity: the inserted timestamp falls within [before, after] window.
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(before);
    expect(row.nextAttemptAt).toBeLessThanOrEqual(after + 1000);
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).toBeLessThanOrEqual(after + 1000);
  });

  it('relay tick uses numeric `Date.now()` comparison (no ISO-string lex compare)', async () => {
    const db = getTestDb();
    const server = makeStubServer();
    const relay = new EventOutboxRelayService(db, server);
    relay.start();

    // Enqueue a row with an explicit nextAttemptAt in the past so the relay
    // picks it up immediately.
    await db.insert(eventOutbox).values({
      streamId: 'sess-due-now',
      type: 'container-agent:token',
      payload: { delta: 'y' },
      nextAttemptAt: Date.now() - 1000,
      createdAt: Date.now() - 1000,
    });

    await relay.tick();

    expect(server.publish).toHaveBeenCalledWith(
      'sess-due-now',
      'container-agent:token',
      expect.objectContaining({ delta: 'y' })
    );

    const after = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.streamId, 'sess-due-now'));
    expect(after[0]?.status).toBe('published');
    expect(typeof after[0]?.publishedAt).toBe('number');
    expect(after[0]?.publishedAt).toBeGreaterThan(0);

    await relay.stop();
  });

  it('skips rows whose `nextAttemptAt` is in the future (numeric comparison)', async () => {
    const db = getTestDb();
    const server = makeStubServer();
    const relay = new EventOutboxRelayService(db, server);
    relay.start();

    const future = Date.now() + 60_000; // 1 minute from now
    await db.insert(eventOutbox).values({
      streamId: 'sess-future',
      type: 'container-agent:token',
      payload: { delta: 'z' },
      nextAttemptAt: future,
      createdAt: Date.now(),
    });

    await relay.tick();

    expect(server.publish).not.toHaveBeenCalledWith(
      'sess-future',
      expect.anything(),
      expect.anything()
    );

    const after = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.streamId, 'sess-future'));
    expect(after[0]?.status).toBe('pending');

    await relay.stop();
  });
});
