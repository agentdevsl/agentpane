import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableStreamsService } from '../durable-streams.service.js';
import { createStreamPayloadWithMetadata } from '../session/event-metadata.js';

const createServerMock = () => ({
  createStream: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(7),
  subscribe: vi.fn(),
});

/**
 * F05-19: publish() enqueues both `session_events` (durable replay) and
 * `event_outbox` (live delivery via the relay) for non-ephemeral streams.
 * The DB mock here records both inserts so tests can introspect the
 * persisted row + the outbox row.
 */
const createDbMock = () => {
  type InsertCall = { table: unknown; values: unknown };
  const inserts: InsertCall[] = [];

  const insertFn = vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      inserts.push({ table, values });
      return {
        returning: vi.fn(() => ({
          all: vi.fn(() => [{ offset: 3 }]),
        })),
        run: vi.fn(),
      };
    }),
  }));

  const db = {
    query: {
      sessionEvents: {
        findFirst: vi.fn().mockResolvedValue({ offset: 2 }),
      },
    },
    insert: insertFn,
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(db)),
    /** Test helper: collect everything inserted across all `insert()` calls. */
    _inserts: inserts,
  };
  return db;
};

describe('DurableStreamsService metadata persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses payload meta eventId for durable persistence', async () => {
    const server = createServerMock();
    const db = createDbMock();
    const service = new DurableStreamsService(server as never, db as never);

    const payload = createStreamPayloadWithMetadata({
      streamId: 'session-1',
      partType: 'tool_start',
      blockId: 'tool-1',
      data: { toolName: 'Read' },
      eventId: 'evt_fixed_123',
      timestamp: 123,
    });

    const result = await service.publish('session-1', 'container-agent:message', payload as never);

    expect(result.ok).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // F05-19: publish() now writes two rows — one to session_events
    // (durable replay) and one to event_outbox (live delivery via relay).
    expect(db.insert).toHaveBeenCalledTimes(2);

    // Persisted row keeps the supplied eventId.
    const sessionEventValues = db._inserts[0]?.values as { id: string; sessionId: string };
    expect(sessionEventValues).toMatchObject({
      id: 'evt_fixed_123',
      sessionId: 'session-1',
    });

    // F05-19: server.publish() is no longer called from publish() — the
    // relay is responsible for delivery.
    expect(server.publish).not.toHaveBeenCalled();
  });

  it('adds metadata automatically for typed stream payloads that lack it', async () => {
    const server = createServerMock();
    const db = createDbMock();
    const service = new DurableStreamsService(server as never, db as never);

    const result = await service.publish('session-2', 'container-agent:status', {
      taskId: 'task-1',
      sessionId: 'session-2',
      stage: 'running',
      message: 'Running',
    });

    expect(result.ok).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);

    // F05-19: two inserts — session_events row + outbox row. Both carry
    // the same metadata-augmented payload.
    expect(db.insert).toHaveBeenCalledTimes(2);

    const persistedRow = db._inserts[0]?.values as {
      id: string;
      data: { meta?: { eventId?: string; streamId?: string; partType?: string } };
    };
    const outboxRow = db._inserts[1]?.values as {
      streamId: string;
      type: string;
      payload: { meta?: { eventId?: string; streamId?: string; partType?: string } };
    };

    expect(persistedRow.id).toBeTruthy();
    expect(persistedRow.data.meta).toMatchObject({
      eventId: persistedRow.id,
      streamId: 'session-2',
      partType: 'system',
    });
    // The outbox row payload carries the same enriched metadata so the
    // relay re-publishes the canonical envelope to Caddy.
    expect(outboxRow.streamId).toBe('session-2');
    expect(outboxRow.type).toBe('container-agent:status');
    expect(outboxRow.payload.meta).toMatchObject({
      eventId: persistedRow.id,
      streamId: 'session-2',
      partType: 'system',
    });
  });
});
