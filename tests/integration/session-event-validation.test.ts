import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStreamService } from '../../src/services/session/session-stream.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function buildStreamMeta(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    streamId: 'session-1',
    blockId: null,
    partType: 'chunk_delta',
    durability: 'durable',
    sequence: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildEvent(id: string, sessionId: string, metaOverrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'chunk' as const,
    timestamp: Date.now(),
    data: {
      text: 'hello',
      meta: buildStreamMeta({
        eventId: id,
        streamId: sessionId,
        ...metaOverrides,
      }),
    },
  };
}

describe('IT-015: SessionStreamService metadata validation', () => {
  let sessionStreamService: SessionStreamService;
  let sessionId: string;

  const mockStreams = {
    publish: vi.fn().mockResolvedValue(0),
    createStream: vi.fn(),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as any;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();

    const project = await createTestProject();
    const session = await createTestSession(project.id);
    sessionId = session.id;

    sessionStreamService = new SessionStreamService(db, mockStreams);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearTestDatabase();
  });

  it('rejects event with mismatched streamId', async () => {
    const event = buildEvent('evt-1', 'wrong-session-id');

    const result = await sessionStreamService.publish(sessionId, event);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_STREAM_PROTOCOL_MISMATCH');
      expect(result.error.message).toContain('wrong-session-id');
    }
  });

  it('rejects event with mismatched eventId', async () => {
    const event = {
      id: 'evt-wrapper',
      type: 'chunk' as const,
      timestamp: Date.now(),
      data: {
        text: 'hello',
        meta: buildStreamMeta({
          eventId: 'evt-payload-mismatch',
          streamId: sessionId,
        }),
      },
    };

    const result = await sessionStreamService.publish(sessionId, event);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_STREAM_PROTOCOL_MISMATCH');
      expect(result.error.message).toContain('evt-payload-mismatch');
    }
  });

  it('publishes event with correct metadata successfully', async () => {
    const event = buildEvent('evt-ok', sessionId);

    const result = await sessionStreamService.publish(sessionId, event);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.offset).toBe('number');
    }
  });

  it('rejects event without stream metadata', async () => {
    const event = {
      id: 'evt-no-meta',
      type: 'chunk' as const,
      timestamp: Date.now(),
      data: { text: 'no metadata here' },
    };

    const result = await sessionStreamService.publish(sessionId, event);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_STREAM_PROTOCOL_MISMATCH');
    }
  });

  it('persists event with correct metadata and returns offset', async () => {
    const event = buildEvent('evt-persist', sessionId);

    const result = await sessionStreamService.persistEvent(sessionId, event);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('evt-persist');
      expect(result.value.offset).toBe(0);
    }
  });

  it('rejects persist with mismatched streamId', async () => {
    const event = buildEvent('evt-bad-persist', 'wrong-session-id');

    const result = await sessionStreamService.persistEvent(sessionId, event);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SESSION_STREAM_PROTOCOL_MISMATCH');
    }
  });

  it('maps event types to correct channels', () => {
    expect(sessionStreamService.getChannelFromEventType('chunk')).toBe('chunks');
    expect(sessionStreamService.getChannelFromEventType('tool:start')).toBe('toolCalls');
    expect(sessionStreamService.getChannelFromEventType('tool:result')).toBe('toolCalls');
    expect(sessionStreamService.getChannelFromEventType('terminal:output')).toBe('terminal');
    expect(sessionStreamService.getChannelFromEventType('presence:joined')).toBe('presence');
    expect(sessionStreamService.getChannelFromEventType('approval:requested')).toBe('approval');
    expect(sessionStreamService.getChannelFromEventType('agent:started')).toBe('agent');
    expect(sessionStreamService.getChannelFromEventType('state:update')).toBe('state');
  });
});
