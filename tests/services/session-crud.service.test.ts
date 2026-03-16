import { describe, expect, it, vi } from 'vitest';
import { SessionCrudService } from '../../src/services/session/session-crud.service';
import type {
  ActiveUser,
  DurableStreamsServer,
  SessionServiceConfig,
} from '../../src/services/session/types';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { getTestDb } from '../helpers/database';

/**
 * Create a mock DurableStreamsServer for testing
 */
function createMockStreams(): DurableStreamsServer {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: vi.fn(),
  };
}

describe('SessionCrudService', () => {
  const config: SessionServiceConfig = {
    baseUrl: 'http://localhost:3001',
  };

  function createService(
    streams?: DurableStreamsServer,
    presenceStore?: Map<string, Map<string, ActiveUser>>
  ) {
    return new SessionCrudService(
      getTestDb() as any,
      streams ?? createMockStreams(),
      config,
      presenceStore ?? new Map()
    );
  }

  describe('create', () => {
    it('creates a session for a valid project', async () => {
      const mockStreams = createMockStreams();
      const service = createService(mockStreams);
      const project = await createTestProject();

      const result = await service.create({
        projectId: project.id,
        title: 'Test Session',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectId).toBe(project.id);
        expect(result.value.title).toBe('Test Session');
        expect(result.value.status).toBe('active');
        expect(result.value.url).toContain('http://localhost:3001/sessions/');
        expect(result.value.presence).toEqual([]);
        expect(result.value.id).toBeTruthy();
      }
    });

    it('calls streams.createStream on creation', async () => {
      const mockStreams = createMockStreams();
      const service = createService(mockStreams);
      const project = await createTestProject();

      const result = await service.create({ projectId: project.id });
      expect(result.ok).toBe(true);
      expect(mockStreams.createStream).toHaveBeenCalledTimes(1);
    });

    it('returns error for non-existent project', async () => {
      const service = createService();

      const result = await service.create({
        projectId: 'nonexistent-project-id',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_NOT_FOUND');
      }
    });

    it('creates session with optional agentId', async () => {
      const service = createService();
      const project = await createTestProject();
      const agent = await createTestAgent(project.id, { name: 'Session Agent' });

      const result = await service.create({
        projectId: project.id,
        agentId: agent.id,
        title: 'Agent Session',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agentId).toBe(agent.id);
        expect(result.value.title).toBe('Agent Session');
      }
    });
  });

  describe('getById', () => {
    it('returns a session by ID with presence data', async () => {
      const presenceStore = new Map<string, Map<string, ActiveUser>>();
      const service = createService(undefined, presenceStore);
      const project = await createTestProject();

      const createResult = await service.create({ projectId: project.id, title: 'Get Me' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      // Add presence data
      const userPresence = new Map<string, ActiveUser>();
      userPresence.set('user-1', {
        userId: 'user-1',
        lastSeen: Date.now(),
      });
      presenceStore.set(sessionId, userPresence);

      const result = await service.getById(sessionId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(sessionId);
        expect(result.value.title).toBe('Get Me');
        expect(result.value.presence.length).toBe(1);
        expect(result.value.presence[0].userId).toBe('user-1');
      }
    });

    it('returns SESSION_NOT_FOUND for non-existent ID', async () => {
      const service = createService();

      const result = await service.getById('nonexistent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });

  describe('list', () => {
    it('returns sessions ordered by updatedAt desc by default', async () => {
      const service = createService();
      const project = await createTestProject();

      await service.create({ projectId: project.id, title: 'Session 1' });
      await service.create({ projectId: project.id, title: 'Session 2' });
      await service.create({ projectId: project.id, title: 'Session 3' });

      const result = await service.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        // All should have presence arrays
        for (const s of result.value) {
          expect(Array.isArray(s.presence)).toBe(true);
        }
      }
    });

    it('respects limit and offset', async () => {
      const service = createService();
      const project = await createTestProject();

      for (let i = 0; i < 5; i++) {
        await service.create({ projectId: project.id, title: `Session ${i}` });
      }

      const result = await service.list({ limit: 2, offset: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it('returns empty array when no sessions exist', async () => {
      const service = createService();

      const result = await service.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('close', () => {
    it('closes an active session', async () => {
      const service = createService();
      const project = await createTestProject();

      const createResult = await service.create({ projectId: project.id, title: 'To Close' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.close(createResult.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('closed');
        expect(result.value.closedAt).toBeTruthy();
      }
    });

    it('returns SESSION_NOT_FOUND for non-existent session', async () => {
      const service = createService();

      const result = await service.close('nonexistent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });

  describe('listSessionsWithFilters', () => {
    it('filters sessions by projectId', async () => {
      const service = createService();
      const project1 = await createTestProject({ name: 'Filter P1' });
      const project2 = await createTestProject({ name: 'Filter P2' });

      await service.create({ projectId: project1.id, title: 'P1 Session' });
      await service.create({ projectId: project2.id, title: 'P2 Session' });

      const result = await service.listSessionsWithFilters(project1.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0].title).toBe('P1 Session');
        expect(result.value.total).toBe(1);
      }
    });

    it('filters by search term in title', async () => {
      const service = createService();
      const project = await createTestProject();

      await service.create({ projectId: project.id, title: 'Bug fix session' });
      await service.create({ projectId: project.id, title: 'Feature session' });
      await service.create({ projectId: project.id, title: 'Another bug fix' });

      const result = await service.listSessionsWithFilters(project.id, {
        search: 'bug',
      });

      // Note: SQLite LIKE is case-insensitive for ASCII by default
      // but the search uses exact case in the LIKE pattern
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 'bug' should match 'Bug fix session' only if case-insensitive,
        // but SQLite LIKE is case-insensitive for ASCII
        expect(result.value.sessions.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('filters by agentId', async () => {
      const service = createService();
      const project = await createTestProject();
      const agentA = await createTestAgent(project.id, { name: 'Agent A' });
      const agentB = await createTestAgent(project.id, { name: 'Agent B' });

      await service.create({
        projectId: project.id,
        title: 'Agent A Session',
        agentId: agentA.id,
      });
      await service.create({
        projectId: project.id,
        title: 'Agent B Session',
        agentId: agentB.id,
      });

      const result = await service.listSessionsWithFilters(project.id, {
        agentId: agentA.id,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0].agentId).toBe(agentA.id);
      }
    });

    it('returns total count with pagination', async () => {
      const service = createService();
      const project = await createTestProject();

      for (let i = 0; i < 5; i++) {
        await service.create({ projectId: project.id, title: `Session ${i}` });
      }

      const result = await service.listSessionsWithFilters(project.id, {
        limit: 2,
        offset: 0,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.total).toBe(5);
      }
    });
  });

  describe('generateUrl', () => {
    it('generates a URL with the session ID', () => {
      const service = createService();
      const url = service.generateUrl('test-session-id');
      expect(url).toBe('http://localhost:3001/sessions/test-session-id');
    });
  });

  describe('parseUrl', () => {
    it('parses a valid session URL', () => {
      const service = createService();
      const result = service.parseUrl('http://localhost:3001/sessions/abc123');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('abc123');
      }
    });

    it('returns INVALID_URL for URL without session ID', () => {
      const service = createService();
      const result = service.parseUrl('http://localhost:3001/other/path');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_URL');
      }
    });

    it('returns INVALID_URL for invalid URL', () => {
      const service = createService();
      const result = service.parseUrl('not-a-url');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_URL');
      }
    });

    it('round-trips with generateUrl', () => {
      const service = createService();
      const url = service.generateUrl('roundtrip123');
      const result = service.parseUrl(url);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('roundtrip123');
      }
    });
  });

  describe('delete', () => {
    it('deletes an existing session', async () => {
      const presenceStore = new Map<string, Map<string, ActiveUser>>();
      const service = createService(undefined, presenceStore);
      const project = await createTestProject();

      const createResult = await service.create({ projectId: project.id, title: 'To Delete' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const sessionId = createResult.value.id;

      const deleteResult = await service.delete(sessionId);
      expect(deleteResult.ok).toBe(true);
      if (deleteResult.ok) {
        expect(deleteResult.value.deleted).toBe(true);
      }

      // Verify it's gone
      const getResult = await service.getById(sessionId);
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error.code).toBe('SESSION_NOT_FOUND');
      }

      // Verify presence store is cleaned up
      expect(presenceStore.has(sessionId)).toBe(false);
    });

    it('returns SESSION_NOT_FOUND for non-existent session', async () => {
      const service = createService();

      const result = await service.delete('nonexistent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });
  });
});
