import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import type { DurableStreamsServer } from '../../src/services/durable-streams.service';
import { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import {
  clearTestDatabase,
  closeTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database';

// ============================================
// Mock DurableStreamsServer
// ============================================

function createMockServer(overrides: Partial<DurableStreamsServer> = {}): DurableStreamsServer {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }),
    deleteStream: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// ============================================
// Helper to create a session in the DB (for FK constraint)
// ============================================

async function createTestSession(codespaceId: string): Promise<string> {
  const db = getTestDb();
  const { createId } = await import('@paralleldrive/cuid2');
  const id = createId();
  // Insert directly to avoid circular service dependencies
  await db.insert((await import('../../src/db/schema')).sessions).values({
    id,
    codespaceId,
    status: 'idle',
    url: `/api/sessions/${id}/stream`,
  });
  return id;
}

describe('DurableStreamsService', () => {
  let mockServer: DurableStreamsServer;
  let service: DurableStreamsService;
  let codespaceId: string;
  let sessionId: string;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await clearTestDatabase();
    mockServer = createMockServer();

    const project = await createTestProject({ name: 'Streams Test Project' });
    codespaceId = project.id;
    sessionId = await createTestSession(codespaceId);

    service = new DurableStreamsService(mockServer, getTestDb() as any);
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  // ============================================
  // createStream
  // ============================================

  describe('createStream', () => {
    it('delegates to server.createStream', async () => {
      const result = await service.createStream('stream-1', { version: 1 });

      expect(result.ok).toBe(true);
      expect(mockServer.createStream).toHaveBeenCalledWith('stream-1', { version: 1 });
    });

    it('returns error when streamId is empty', async () => {
      const result = await service.createStream('', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('streamId is required');
      }
    });

    it('returns error when streamId is whitespace only', async () => {
      const result = await service.createStream('   ', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('streamId is required');
      }
    });

    it('wraps server errors with context', async () => {
      const failServer = createMockServer({
        createStream: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const failService = new DurableStreamsService(failServer, getTestDb() as any);

      const result = await failService.createStream('stream-1', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to create stream 'stream-1'");
      }
    });
  });

  // ============================================
  // deleteStream
  // ============================================

  describe('deleteStream', () => {
    it('delegates to server.deleteStream', async () => {
      await service.deleteStream('stream-1');

      expect(mockServer.deleteStream).toHaveBeenCalledWith('stream-1');
    });

    it('handles server without deleteStream method', async () => {
      const serverWithoutDelete = createMockServer();
      delete (serverWithoutDelete as any).deleteStream;
      const svc = new DurableStreamsService(serverWithoutDelete, getTestDb() as any);

      // Should not throw
      await expect(svc.deleteStream('stream-1')).resolves.toBeUndefined();
    });
  });

  // ============================================
  // publish (type-safe)
  // ============================================

  describe('publish', () => {
    it('persists to session_events and enqueues to event_outbox (F05-19)', async () => {
      const data = {
        sessionId,
        taskId: 'task-1',
        codespaceId,
      };

      const result = await service.publish(sessionId, 'plan:started', data);
      expect(result.ok).toBe(true);

      // F05-19: server.publish is called by the relay, not from publish().
      expect(mockServer.publish).not.toHaveBeenCalled();

      // Should persist to session_events (durable replay).
      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('plan:started');
      expect(events[0]?.channel).toBe('plan');
      expect(events[0]?.offset).toBe(0);
      if (result.ok) expect(result.value).toBe(0);

      // Should also enqueue an outbox row for the relay to drain.
      const { eventOutbox } = await import('../../src/db/schema/sqlite/event-outbox.js');
      const outboxRows = await db
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.streamId, sessionId));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]?.type).toBe('plan:started');
      expect(outboxRows[0]?.status).toBe('pending');
    });

    it('increments offsets for successive events', async () => {
      await service.publish(sessionId, 'plan:started', {
        sessionId,
        taskId: 'task-1',
        codespaceId,
      });

      // RS-008: Use plan:turn instead of plan:token since token events are
      // now batched with a 50ms delay and won't be in the DB immediately.
      await service.publish(sessionId, 'plan:turn', {
        sessionId,
        turnId: 'turn-1',
        role: 'assistant',
        content: 'Hello',
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(2);
      expect(events[0]?.offset).toBe(0);
      expect(events[1]?.offset).toBe(1);
    });

    it('returns error when streamId is empty', async () => {
      const result = await service.publish('', 'plan:started', {
        sessionId: 's1',
        taskId: 't1',
        codespaceId: 'p1',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('streamId is required');
      }
    });

    it('still persists to DB when server publish fails', async () => {
      const failServer = createMockServer({
        publish: vi.fn().mockRejectedValue(new Error('caddy down')),
      });
      const svc = new DurableStreamsService(failServer, getTestDb() as any);

      // publish should succeed (caddy failure is best-effort)
      const result = await svc.publish(sessionId, 'sandbox:creating', {
        sandboxId: 'sb-1',
        codespaceId,
        image: 'node:20',
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('sandbox:creating');
    });

    it('uses server offset when no DB is configured', async () => {
      const serverOnly = createMockServer({
        publish: vi.fn().mockResolvedValue(42),
      });
      const svc = new DurableStreamsService(serverOnly); // no DB

      const result = await svc.publish(sessionId, 'plan:started', {
        sessionId,
        taskId: 't1',
        codespaceId: 'p1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(42);
    });

    it('blocks typed stream publishes when payload metadata conflicts with the envelope gate', async () => {
      const result = await service.publish(sessionId, 'plan:started', {
        sessionId,
        taskId: 'task-1',
        codespaceId,
        meta: {
          schemaVersion: 1,
          eventId: 'evt-conflict',
          streamId: 'other-stream',
          blockId: null,
          partType: 'lifecycle',
          durability: 'durable',
          sequence: null,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      } as never);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('STREAM_PROTOCOL_MISMATCH');
      }
      expect(mockServer.publish).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // publishSessionEvent
  // ============================================

  describe('publishSessionEvent', () => {
    it('publishes a session event and persists to DB', async () => {
      const event = {
        id: 'evt-1',
        type: 'chunk' as const,
        timestamp: Date.now(),
        data: {
          text: 'hello',
          meta: {
            schemaVersion: 1,
            eventId: 'evt-1',
            streamId: sessionId,
            blockId: 'block-1',
            partType: 'chunk_end',
            durability: 'durable',
            sequence: null,
            createdAt: '2026-03-23T00:00:00.000Z',
          },
        },
      };

      await service.publishSessionEvent(sessionId, event);

      expect(mockServer.publish).toHaveBeenCalledWith(
        sessionId,
        'chunk',
        expect.objectContaining({
          text: 'hello',
          meta: expect.objectContaining({
            schemaVersion: 1,
            eventId: 'evt-1',
            streamId: sessionId,
          }),
        })
      );

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('chunk');
      expect(events[0]?.channel).toBe('session');
    });

    it('returns error when streamId is empty', async () => {
      const result = await service.publishSessionEvent('', {
        id: 'evt-1',
        type: 'chunk',
        timestamp: Date.now(),
        data: {},
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('streamId is required');
      }
    });

    it('blocks legacy session event publishes that omit structured metadata', async () => {
      const result = await service.publishSessionEvent(sessionId, {
        id: 'evt-legacy',
        type: 'chunk',
        timestamp: Date.now(),
        data: { text: 'legacy chunk' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('STREAM_PROTOCOL_MISMATCH');
      }
      expect(mockServer.publish).not.toHaveBeenCalled();
    });

    it('survives caddy failure for session events', async () => {
      const failServer = createMockServer({
        publish: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const svc = new DurableStreamsService(failServer, getTestDb() as any);

      // Should succeed (caddy failure is best-effort)
      const result = await svc.publishSessionEvent(sessionId, {
        id: 'evt-2',
        type: 'tool:start',
        timestamp: Date.now(),
        data: {
          toolName: 'Read',
          meta: {
            schemaVersion: 1,
            eventId: 'evt-2',
            streamId: sessionId,
            blockId: 'tool-1',
            partType: 'tool_start',
            durability: 'durable',
            sequence: null,
            createdAt: '2026-03-23T00:00:00.000Z',
          },
        },
      });
      expect(result.ok).toBe(true);

      // But event should be in DB
      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
    });

    it('works without DB (server-only mode)', async () => {
      const serverOnly = createMockServer();
      const svc = new DurableStreamsService(serverOnly); // no DB

      const result = await svc.publishSessionEvent(sessionId, {
        id: 'evt-3',
        type: 'agent:started',
        timestamp: Date.now(),
        data: {
          agentId: 'a1',
          meta: {
            schemaVersion: 1,
            eventId: 'evt-3',
            streamId: sessionId,
            blockId: 'a1',
            partType: 'lifecycle',
            durability: 'durable',
            sequence: null,
            createdAt: '2026-03-23T00:00:00.000Z',
          },
        },
      });
      expect(result.ok).toBe(true);

      expect(serverOnly.publish).toHaveBeenCalledWith(
        sessionId,
        'agent:started',
        expect.objectContaining({
          agentId: 'a1',
          meta: expect.objectContaining({
            schemaVersion: 1,
            eventId: 'evt-3',
            streamId: sessionId,
          }),
        })
      );
    });
  });

  // ============================================
  // Channel mapping (getChannelForType)
  // ============================================

  describe('channel mapping', () => {
    it('maps plan: events to plan channel', async () => {
      await service.publish(sessionId, 'plan:completed', {
        sessionId,
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0]?.channel).toBe('plan');
    });

    it('maps sandbox: events to sandbox channel', async () => {
      await service.publish(sessionId, 'sandbox:ready', {
        sandboxId: 'sb-1',
        codespaceId,
        containerId: 'ctr-1',
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0]?.channel).toBe('sandbox');
    });

    it('maps task-creation: events to taskCreation channel', async () => {
      await service.publish(sessionId, 'task-creation:started', {
        sessionId,
        codespaceId,
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0]?.channel).toBe('taskCreation');
    });

    it('maps container-agent: events to containerAgent channel', async () => {
      await service.publish(sessionId, 'container-agent:started', {
        taskId: 'task-1',
        sessionId,
        model: 'claude-sonnet-4-6',
        maxTurns: 50,
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0]?.channel).toBe('containerAgent');
    });

    it('maps topology: events to topology channel', async () => {
      await service.publish(sessionId, 'topology:agent_spawned', {
        agentId: 'a-1',
        name: 'Worker 1',
        role: 'executor',
        parentId: null,
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0]?.channel).toBe('topology');
    });

    it('maps terraform: events to terraform channel', async () => {
      await service.publish(sessionId, 'terraform:status', {
        jobId: 'job-1',
        stage: 'generating' as any,
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0]?.channel).toBe('terraform');
    });
  });

  // ============================================
  // Compatibility helper methods
  // ============================================

  describe('compatibility helpers', () => {
    it('publishPlanStarted delegates to publish', async () => {
      const publishSpy = vi.spyOn(service, 'publish');

      await service.publishPlanStarted(sessionId, {
        sessionId,
        taskId: 'task-1',
        codespaceId,
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'plan:started', {
        sessionId,
        taskId: 'task-1',
        codespaceId,
      });
    });

    it('publishPlanCompleted delegates to publish', async () => {
      const publishSpy = vi.spyOn(service, 'publish');

      await service.publishPlanCompleted(sessionId, { sessionId });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'plan:completed', {
        sessionId,
      });
    });

    it('publishPlanError delegates to publish', async () => {
      const publishSpy = vi.spyOn(service, 'publish');

      await service.publishPlanError(sessionId, {
        sessionId,
        error: 'something broke',
        code: 'PLAN_FAILED',
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'plan:error', {
        sessionId,
        error: 'something broke',
        code: 'PLAN_FAILED',
      });
    });

    it('publishTaskCreationStarted delegates to publish', async () => {
      const publishSpy = vi.spyOn(service, 'publish');

      await service.publishTaskCreationStarted(sessionId, {
        sessionId,
        codespaceId,
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'task-creation:started', {
        sessionId,
        codespaceId,
      });
    });

    it('publishTaskCreationError delegates to publish', async () => {
      const publishSpy = vi.spyOn(service, 'publish');

      await service.publishTaskCreationError(sessionId, {
        sessionId,
        error: 'failed',
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'task-creation:error', {
        sessionId,
        error: 'failed',
      });
    });
  });
});
