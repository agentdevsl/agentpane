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

async function createTestSession(projectId: string): Promise<string> {
  const db = getTestDb();
  const { createId } = await import('@paralleldrive/cuid2');
  const id = createId();
  // Insert directly to avoid circular service dependencies
  await db.insert((await import('../../src/db/schema')).sessions).values({
    id,
    projectId,
    status: 'idle',
    url: `/api/sessions/${id}/stream`,
  });
  return id;
}

describe('DurableStreamsService', () => {
  let mockServer: DurableStreamsServer;
  let service: DurableStreamsService;
  let projectId: string;
  let sessionId: string;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await clearTestDatabase();
    mockServer = createMockServer();

    const project = await createTestProject({ name: 'Streams Test Project' });
    projectId = project.id;
    sessionId = await createTestSession(projectId);

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
      await service.createStream('stream-1', { version: 1 });

      expect(mockServer.createStream).toHaveBeenCalledWith('stream-1', { version: 1 });
    });

    it('throws when streamId is empty', async () => {
      await expect(service.createStream('', {})).rejects.toThrow('streamId is required');
    });

    it('throws when streamId is whitespace only', async () => {
      await expect(service.createStream('   ', {})).rejects.toThrow('streamId is required');
    });

    it('wraps server errors with context', async () => {
      const failServer = createMockServer({
        createStream: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const failService = new DurableStreamsService(failServer, getTestDb() as any);

      await expect(failService.createStream('stream-1', {})).rejects.toThrow(
        "Failed to create stream 'stream-1'"
      );
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
    it('publishes to server and persists to database', async () => {
      const data = {
        sessionId,
        taskId: 'task-1',
        projectId,
      };

      const offset = await service.publish(sessionId, 'plan:started', data);

      // Server should be called
      expect(mockServer.publish).toHaveBeenCalledWith(sessionId, 'plan:started', data);

      // Should persist to DB
      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('plan:started');
      expect(events[0].channel).toBe('plan');
      expect(events[0].offset).toBe(0);
      expect(offset).toBe(0);
    });

    it('increments offsets for successive events', async () => {
      await service.publish(sessionId, 'plan:started', {
        sessionId,
        taskId: 'task-1',
        projectId,
      });

      await service.publish(sessionId, 'plan:token', {
        sessionId,
        delta: 'Hello',
        accumulated: 'Hello',
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(2);
      expect(events[0].offset).toBe(0);
      expect(events[1].offset).toBe(1);
    });

    it('throws when streamId is empty', async () => {
      await expect(
        service.publish('', 'plan:started', {
          sessionId: 's1',
          taskId: 't1',
          projectId: 'p1',
        })
      ).rejects.toThrow('streamId is required');
    });

    it('still persists to DB when server publish fails', async () => {
      const failServer = createMockServer({
        publish: vi.fn().mockRejectedValue(new Error('caddy down')),
      });
      const svc = new DurableStreamsService(failServer, getTestDb() as any);

      // publish should NOT throw (caddy failure is best-effort)
      const offset = await svc.publish(sessionId, 'sandbox:creating', {
        sandboxId: 'sb-1',
        projectId,
        image: 'node:20',
      });

      expect(offset).toBe(0);

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('sandbox:creating');
    });

    it('uses server offset when no DB is configured', async () => {
      const serverOnly = createMockServer({
        publish: vi.fn().mockResolvedValue(42),
      });
      const svc = new DurableStreamsService(serverOnly); // no DB

      const offset = await svc.publish(sessionId, 'plan:started', {
        sessionId,
        taskId: 't1',
        projectId: 'p1',
      });

      expect(offset).toBe(42);
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
        data: { text: 'hello' },
      };

      await service.publishSessionEvent(sessionId, event);

      expect(mockServer.publish).toHaveBeenCalledWith(sessionId, 'chunk', { text: 'hello' });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('chunk');
      expect(events[0].channel).toBe('session');
    });

    it('throws when streamId is empty', async () => {
      await expect(
        service.publishSessionEvent('', {
          id: 'evt-1',
          type: 'chunk',
          timestamp: Date.now(),
          data: {},
        })
      ).rejects.toThrow('streamId is required');
    });

    it('survives caddy failure for session events', async () => {
      const failServer = createMockServer({
        publish: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const svc = new DurableStreamsService(failServer, getTestDb() as any);

      // Should not throw
      await expect(
        svc.publishSessionEvent(sessionId, {
          id: 'evt-2',
          type: 'tool:start',
          timestamp: Date.now(),
          data: { toolName: 'Read' },
        })
      ).resolves.toBeUndefined();

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

      await expect(
        svc.publishSessionEvent(sessionId, {
          id: 'evt-3',
          type: 'agent:started',
          timestamp: Date.now(),
          data: { agentId: 'a1' },
        })
      ).resolves.toBeUndefined();

      expect(serverOnly.publish).toHaveBeenCalledWith(sessionId, 'agent:started', {
        agentId: 'a1',
      });
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
      expect(events[0].channel).toBe('plan');
    });

    it('maps sandbox: events to sandbox channel', async () => {
      await service.publish(sessionId, 'sandbox:ready', {
        sandboxId: 'sb-1',
        projectId,
        containerId: 'ctr-1',
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0].channel).toBe('sandbox');
    });

    it('maps task-creation: events to taskCreation channel', async () => {
      await service.publish(sessionId, 'task-creation:started', {
        sessionId,
        projectId,
      });

      const db = getTestDb();
      const events = await db.query.sessionEvents.findMany({
        where: eq(sessionEvents.sessionId, sessionId),
      });
      expect(events[0].channel).toBe('taskCreation');
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
      expect(events[0].channel).toBe('containerAgent');
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
      expect(events[0].channel).toBe('topology');
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
      expect(events[0].channel).toBe('terraform');
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
        projectId,
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'plan:started', {
        sessionId,
        taskId: 'task-1',
        projectId,
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
        projectId,
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionId, 'task-creation:started', {
        sessionId,
        projectId,
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
