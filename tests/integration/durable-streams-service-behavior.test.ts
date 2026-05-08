import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import {
  type DurableStreamsServer,
  DurableStreamsService,
} from '../../src/services/durable-streams.service';
import { createSessionEventWithMetadata } from '../../src/services/session/event-metadata';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createServer(overrides: Partial<DurableStreamsServer> = {}): DurableStreamsServer {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: async function* () {},
    deleteStream: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('DurableStreamsService integration behavior', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('validates createStream inputs and wraps server creation failures', async () => {
    const failingServer = createServer({
      createStream: vi.fn().mockRejectedValue(new Error('caddy unavailable')),
    });
    const service = new DurableStreamsService(failingServer, db);

    const missingId = await service.createStream('', {});
    expect(missingId.ok).toBe(false);
    if (!missingId.ok) {
      expect(missingId.error.code).toBe('STREAM_VALIDATION');
    }

    const failedCreate = await service.createStream('session-1', {});
    expect(failedCreate.ok).toBe(false);
    if (!failedCreate.ok) {
      expect(failedCreate.error.code).toBe('STREAM_CREATE_FAILED');
      expect(failedCreate.error.message).toContain('caddy unavailable');
    }
  });

  it('publishSessionEvent persists metadata-wrapped session events and rejects mismatches', async () => {
    const project = await createTestProject();
    const session = await createTestSession(project.id);
    const service = new DurableStreamsService(createServer(), db);

    const event = createSessionEventWithMetadata({
      sessionId: session.id,
      type: 'chunk',
      partType: 'chunk_delta',
      blockId: 'chunk-1',
      data: { text: 'hello' },
    });

    const result = await service.publishSessionEvent(session.id, event);
    expect(result.ok).toBe(true);

    const persisted = await db.query.sessionEvents.findFirst({
      where: eq(sessionEvents.id, event.id),
    });
    expect(persisted).toMatchObject({
      sessionId: session.id,
      streamKind: 'session',
      type: 'chunk',
      channel: 'session',
    });
    expect(persisted?.data).toMatchObject({
      text: 'hello',
      meta: {
        eventId: event.id,
        streamId: session.id,
        blockId: 'chunk-1',
        partType: 'chunk_delta',
      },
    });

    const wrongStream = await service.publishSessionEvent(`plan:${createId()}`, event);
    expect(wrongStream.ok).toBe(false);
    if (!wrongStream.ok) {
      expect(wrongStream.error.code).toBe('STREAM_PROTOCOL_MISMATCH');
    }

    const missingMetadata = await service.publishSessionEvent(session.id, {
      id: createId(),
      type: 'chunk',
      timestamp: Date.now(),
      data: { text: 'missing meta' },
    });
    expect(missingMetadata.ok).toBe(false);
    if (!missingMetadata.ok) {
      expect(missingMetadata.error.code).toBe('STREAM_PROTOCOL_MISMATCH');
    }
  });

  it('derives metadata part types and block ids for representative typed events', async () => {
    const project = await createTestProject();
    const session = await createTestSession(project.id);
    const service = new DurableStreamsService(createServer(), db);

    const toolResult = await service.publish(session.id, 'container-agent:tool:result', {
      taskId: 'task-1',
      sessionId: session.id,
      toolName: 'Read',
      toolId: 'tool-err-1',
      result: 'failed',
      isError: true,
      durationMs: 42,
    });
    expect(toolResult.ok).toBe(true);

    const fileChanged = await service.publish(session.id, 'container-agent:file_changed', {
      taskId: 'task-1',
      sessionId: session.id,
      path: 'src/app.ts',
      operation: 'modified',
      additions: 3,
      deletions: 1,
    });
    expect(fileChanged.ok).toBe(true);

    const questions = await service.publish(session.id, 'task-creation:questions', {
      sessionId: session.id,
      questions: {
        id: 'questions-1',
        round: 1,
        totalAsked: 1,
        maxQuestions: 4,
        questions: [
          {
            header: 'Scope',
            question: 'What should be tested?',
            options: [{ label: 'API', description: 'API behavior' }],
          },
        ],
      },
    });
    expect(questions.ok).toBe(true);

    const rows = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, session.id),
      orderBy: [sessionEvents.offset],
    });
    expect(rows.map((row) => row.type)).toEqual([
      'container-agent:tool:result',
      'container-agent:file_changed',
      'task-creation:questions',
    ]);
    expect(rows[0].data).toMatchObject({
      meta: { blockId: 'tool-err-1', partType: 'tool_error' },
    });
    expect(rows[1].data).toMatchObject({
      meta: { blockId: 'task-1', partType: 'diff' },
    });
    expect(rows[2].data).toMatchObject({
      meta: { blockId: 'questions-1', partType: 'system' },
    });
  });

  it('reports backpressure metadata when direct publish latency crosses threshold', async () => {
    const server = createServer({
      publish: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 520));
        return 7;
      }),
    });
    const service = new DurableStreamsService(server);

    const result = await service.publishWithBackpressure('session-no-db', 'container-agent:token', {
      taskId: 'task-1',
      sessionId: 'session-no-db',
      delta: 'slow',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ offset: 7, signalPause: true });
    expect(service.getPublishLagMetrics()).toMatchObject({
      sampleCount: 1,
      signalPause: true,
    });
  });
});
