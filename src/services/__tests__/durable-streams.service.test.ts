import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableStreamsService } from '../durable-streams.service.js';
import { createStreamPayloadWithMetadata } from '../session/event-metadata.js';

const createServerMock = () => ({
  createStream: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(7),
  subscribe: vi.fn(),
});

const createDbMock = () => ({
  query: {
    sessionEvents: {
      findFirst: vi.fn().mockResolvedValue({ offset: 2 }),
    },
  },
  insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
});

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
    expect(db.insert).toHaveBeenCalled();
    const valuesMock = db.insert.mock.results[0]?.value.values;
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'evt_fixed_123',
        sessionId: 'session-1',
      })
    );
    expect(server.publish).toHaveBeenCalledWith('session-1', 'container-agent:message', payload);
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

    const valuesMock = db.insert.mock.results[0]?.value.values;
    const persistedRow = valuesMock.mock.calls[0]?.[0] as {
      id: string;
      data: { meta?: { eventId?: string; streamId?: string; partType?: string } };
    };
    const publishedPayload = server.publish.mock.calls[0]?.[2] as {
      meta?: { eventId?: string; streamId?: string; partType?: string };
    };

    expect(persistedRow.id).toBeTruthy();
    expect(persistedRow.data.meta).toMatchObject({
      eventId: persistedRow.id,
      streamId: 'session-2',
      partType: 'system',
    });
    expect(publishedPayload.meta).toMatchObject({
      eventId: persistedRow.id,
      streamId: 'session-2',
      partType: 'system',
    });
  });
});
