import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createProjectsRoutes } from '../projects.js';

// ── Mock Database ──

function createMockDb() {
  const db: Record<string, any> = {
    query: {
      projects: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      tasks: {
        findMany: vi.fn(),
      },
      agents: {
        findMany: vi.fn(),
      },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  // transaction mock: calls the callback with the mock db itself
  db.transaction.mockImplementation(async (callback: (tx: any) => any) => {
    return callback(db);
  });
  return db;
}

// ── Mock ProjectService ──

function createMockProjectService() {
  return {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    listWithSummaries: vi.fn(),
    validatePath: vi.fn(),
    validateConfig: vi.fn(),
    updateConfig: vi.fn(),
    syncFromGitHub: vi.fn(),
    cloneRepository: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const db = createMockDb();
  const projectService = createMockProjectService();
  const routes = createProjectsRoutes({ projectService: projectService as never, db: db as never });
  const app = new Hono();
  app.route('/api/projects', routes);
  return { app, db, projectService };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('Projects API Routes', () => {
  // ── GET /api/projects ──

  describe('GET /api/projects', () => {
    it('returns projects list', async () => {
      const { app, projectService } = createTestApp();
      const mockProjects = [
        {
          id: 'proj-1',
          name: 'Project 1',
          path: '/home/user/project1',
          description: 'A project',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-02',
        },
      ];
      projectService.list.mockResolvedValue({ ok: true, value: mockProjects });

      const res = await request(app, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.items[0].id).toBe('proj-1');
      expect(json.data.items[0].name).toBe('Project 1');
    });

    it('returns empty list when no projects exist', async () => {
      const { app, projectService } = createTestApp();
      projectService.list.mockResolvedValue({ ok: true, value: [] });

      const res = await request(app, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(0);
      expect(json.data.totalCount).toBe(0);
    });

    it('returns 500 when database fails', async () => {
      const { app, projectService } = createTestApp();
      projectService.list.mockRejectedValue(new Error('DB connection failed'));

      const res = await request(app, 'GET', '/api/projects');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── POST /api/projects ──

  describe('POST /api/projects', () => {
    it('creates a project', async () => {
      const { app, projectService } = createTestApp();
      const created = {
        id: 'proj-new',
        name: 'New Project',
        path: '/home/user/new-project',
        description: 'A new project',
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      };
      projectService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/projects', {
        name: 'New Project',
        path: '/home/user/new-project',
        description: 'A new project',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('proj-new');
      expect(json.data.name).toBe('New Project');
    });

    it('returns 400 when name is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/projects', {
        path: '/home/user/project',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when path is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/projects', {
        name: 'Project',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns error for duplicate path', async () => {
      const { app, projectService } = createTestApp();
      projectService.create.mockResolvedValue({
        ok: false,
        error: {
          code: 'PROJECT_PATH_EXISTS',
          message: 'A project with this path already exists',
          status: 409,
        },
      });

      const res = await request(app, 'POST', '/api/projects', {
        name: 'Duplicate',
        path: '/home/user/project',
      });

      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DUPLICATE');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/projects', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });
  });

  // ── GET /api/projects/:id ──

  describe('GET /api/projects/:id', () => {
    it('returns a project by id', async () => {
      const { app, projectService } = createTestApp();
      const project = {
        id: 'proj-1',
        name: 'Project 1',
        path: '/home/user/project1',
        description: 'A project',
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
      };
      projectService.getById.mockResolvedValue({ ok: true, value: project });

      const res = await request(app, 'GET', '/api/projects/proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('proj-1');
    });

    it('returns config and maxConcurrentAgents in GET response', async () => {
      const { app, projectService } = createTestApp();
      const project = {
        id: 'proj-1',
        name: 'Project 1',
        path: '/home/user/project1',
        description: 'A project',
        maxConcurrentAgents: 5,
        config: {
          defaultBranch: 'main',
          maxTurns: 100,
          sandbox: { enabled: true, provider: 'kubernetes' },
        },
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
      };
      projectService.getById.mockResolvedValue({ ok: true, value: project });

      const res = await request(app, 'GET', '/api/projects/proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.config).toEqual(project.config);
      expect(json.data.config.sandbox.provider).toBe('kubernetes');
      expect(json.data.maxConcurrentAgents).toBe(5);
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/projects/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when project not found', async () => {
      const { app, projectService } = createTestApp();
      projectService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/projects/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── PATCH /api/projects/:id ──

  describe('PATCH /api/projects/:id', () => {
    it('updates a project', async () => {
      const { app, projectService } = createTestApp();
      const updated = {
        id: 'proj-1',
        name: 'New Name',
        path: '/project',
        description: null,
        maxConcurrentAgents: 3,
        config: {},
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
      };
      projectService.update.mockResolvedValue({ ok: true, value: updated });

      const res = await request(app, 'PATCH', '/api/projects/proj-1', {
        name: 'New Name',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('New Name');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/projects/bad!id', {
        name: 'Updated',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/projects/proj-1', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 404 when project not found', async () => {
      const { app, projectService } = createTestApp();
      projectService.update.mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', status: 404 },
      });

      const res = await request(app, 'PATCH', '/api/projects/nonexistent-id', {
        name: 'Updated',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  // ── DELETE /api/projects/:id ──

  describe('DELETE /api/projects/:id', () => {
    it('deletes a project', async () => {
      const { app, db, projectService } = createTestApp();
      const existing = { id: 'proj-1', name: 'Project', path: '/project' };
      projectService.getById.mockResolvedValue({ ok: true, value: existing });
      db.query.agents.findMany.mockResolvedValue([]); // no running agents
      projectService.delete.mockResolvedValue({ ok: true, value: undefined });

      const res = await request(app, 'DELETE', '/api/projects/proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/projects/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when project not found', async () => {
      const { app, projectService } = createTestApp();
      projectService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/projects/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 when project has running agents', async () => {
      const { app, db, projectService } = createTestApp();
      const existing = { id: 'proj-1', name: 'Project', path: '/project' };
      projectService.getById.mockResolvedValue({ ok: true, value: existing });
      db.query.agents.findMany.mockResolvedValue([
        { id: 'agent-1', status: 'running', projectId: 'proj-1' },
      ]);

      const res = await request(app, 'DELETE', '/api/projects/proj-1');

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('PROJECT_HAS_RUNNING_AGENTS');
    });
  });

  // ── GET /api/projects/summaries ──

  describe('GET /api/projects/summaries', () => {
    it('returns project summaries with task counts and agent info', async () => {
      const { app, projectService } = createTestApp();
      projectService.listWithSummaries.mockResolvedValue({
        ok: true,
        value: [
          {
            project: {
              id: 'proj-1',
              name: 'Project 1',
              path: '/project1',
              description: 'A project',
              createdAt: '2025-01-01',
              updatedAt: '2025-01-02',
            },
            taskCounts: {
              backlog: 1,
              inProgress: 1,
              waitingApproval: 0,
              verified: 0,
              total: 2,
            },
            runningAgents: [],
            status: 'idle' as const,
            lastActivityAt: '2025-01-03',
          },
        ],
      });

      const res = await request(app, 'GET', '/api/projects/summaries');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.items[0].taskCounts.backlog).toBe(1);
      expect(json.data.items[0].taskCounts.inProgress).toBe(1);
      expect(json.data.items[0].taskCounts.total).toBe(2);
      expect(json.data.items[0].status).toBe('idle');
    });

    it('returns running status when agents are active', async () => {
      const { app, projectService } = createTestApp();
      projectService.listWithSummaries.mockResolvedValue({
        ok: true,
        value: [
          {
            project: {
              id: 'proj-1',
              name: 'P1',
              path: '/p1',
              description: null,
              createdAt: '2025-01-01',
              updatedAt: '2025-01-01',
            },
            taskCounts: { backlog: 0, inProgress: 0, waitingApproval: 0, verified: 0, total: 0 },
            runningAgents: [{ id: 'agent-1', name: 'Agent 1', currentTaskId: null }],
            status: 'running' as const,
            lastActivityAt: '2025-01-01',
          },
        ],
      });

      const res = await request(app, 'GET', '/api/projects/summaries');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.items[0].status).toBe('running');
      expect(json.data.items[0].runningAgents).toHaveLength(1);
    });

    it('returns 500 when database fails', async () => {
      const { app, projectService } = createTestApp();
      projectService.listWithSummaries.mockRejectedValue(new Error('DB error'));

      const res = await request(app, 'GET', '/api/projects/summaries');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });
});
