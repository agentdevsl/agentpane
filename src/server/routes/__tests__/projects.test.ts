import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createProjectsRoutes } from '../projects.js';

// ── Mock Database ──

function createMockDb() {
  return {
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
  };
}

// Helper to set up chainable insert mock
function setupInsertMock(db: ReturnType<typeof createMockDb>, returnValue: unknown) {
  const returning = vi.fn().mockResolvedValue(returnValue ? [returnValue] : []);
  const values = vi.fn().mockReturnValue({ returning });
  db.insert.mockReturnValue({ values });
  return { values, returning };
}

// Helper to set up chainable update mock
function setupUpdateMock(db: ReturnType<typeof createMockDb>, returnValue: unknown) {
  const returning = vi.fn().mockResolvedValue(returnValue ? [returnValue] : []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  db.update.mockReturnValue({ set });
  return { set, where, returning };
}

// Helper to set up chainable delete mock
function setupDeleteMock(db: ReturnType<typeof createMockDb>) {
  const where = vi.fn().mockResolvedValue(undefined);
  db.delete.mockReturnValue({ where });
  return { where };
}

// ── Test App Factory ──

function createTestApp() {
  const db = createMockDb();
  const routes = createProjectsRoutes({ db: db as never });
  const app = new Hono();
  app.route('/api/projects', routes);
  return { app, db };
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
      const { app, db } = createTestApp();
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
      db.query.projects.findMany.mockResolvedValue(mockProjects);

      const res = await request(app, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.items[0].id).toBe('proj-1');
      expect(json.data.items[0].name).toBe('Project 1');
    });

    it('returns empty list when no projects exist', async () => {
      const { app, db } = createTestApp();
      db.query.projects.findMany.mockResolvedValue([]);

      const res = await request(app, 'GET', '/api/projects');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(0);
      expect(json.data.totalCount).toBe(0);
    });

    it('returns 500 when database fails', async () => {
      const { app, db } = createTestApp();
      db.query.projects.findMany.mockRejectedValue(new Error('DB connection failed'));

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
      const { app, db } = createTestApp();
      const created = {
        id: 'proj-new',
        name: 'New Project',
        path: '/home/user/new-project',
        description: 'A new project',
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      };
      db.query.projects.findFirst.mockResolvedValue(null); // no duplicate
      setupInsertMock(db, created);

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

    it('returns 400 for duplicate path', async () => {
      const { app, db } = createTestApp();
      db.query.projects.findFirst.mockResolvedValue({
        id: 'existing',
        path: '/home/user/project',
      });

      const res = await request(app, 'POST', '/api/projects', {
        name: 'Duplicate',
        path: '/home/user/project',
      });

      expect(res.status).toBe(400);
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
      const { app, db } = createTestApp();
      const project = {
        id: 'proj-1',
        name: 'Project 1',
        path: '/home/user/project1',
        description: 'A project',
        createdAt: '2025-01-01',
        updatedAt: '2025-01-02',
      };
      db.query.projects.findFirst.mockResolvedValue(project);

      const res = await request(app, 'GET', '/api/projects/proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('proj-1');
    });

    it('returns config and maxConcurrentAgents in GET response', async () => {
      const { app, db } = createTestApp();
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
      db.query.projects.findFirst.mockResolvedValue(project);

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
      const { app, db } = createTestApp();
      db.query.projects.findFirst.mockResolvedValue(null);

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
      const { app, db } = createTestApp();
      const existing = {
        id: 'proj-1',
        name: 'Old Name',
        path: '/project',
        config: {},
      };
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
      db.query.projects.findFirst.mockResolvedValue(existing);
      setupUpdateMock(db, updated);

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
      const { app, db } = createTestApp();
      db.query.projects.findFirst.mockResolvedValue(null);

      const res = await request(app, 'PATCH', '/api/projects/nonexistent-id', {
        name: 'Updated',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── DELETE /api/projects/:id ──

  describe('DELETE /api/projects/:id', () => {
    it('deletes a project', async () => {
      const { app, db } = createTestApp();
      const existing = { id: 'proj-1', name: 'Project', path: '/project' };
      db.query.projects.findFirst.mockResolvedValue(existing);
      db.query.agents.findMany.mockResolvedValue([]); // no running agents
      setupDeleteMock(db);

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
      const { app, db } = createTestApp();
      db.query.projects.findFirst.mockResolvedValue(null);

      const res = await request(app, 'DELETE', '/api/projects/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 when project has running agents', async () => {
      const { app, db } = createTestApp();
      const existing = { id: 'proj-1', name: 'Project', path: '/project' };
      db.query.projects.findFirst.mockResolvedValue(existing);
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
      const { app, db } = createTestApp();
      const mockProjects = [
        {
          id: 'proj-1',
          name: 'Project 1',
          path: '/project1',
          description: 'A project',
          createdAt: '2025-01-01',
          updatedAt: '2025-01-02',
        },
      ];
      const mockTasks = [
        { id: 'task-1', column: 'backlog', projectId: 'proj-1', updatedAt: '2025-01-02' },
        { id: 'task-2', column: 'in_progress', projectId: 'proj-1', updatedAt: '2025-01-03' },
      ];
      db.query.projects.findMany.mockResolvedValue(mockProjects);
      db.query.tasks.findMany.mockResolvedValue(mockTasks);
      db.query.agents.findMany.mockResolvedValue([]);

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
      const { app, db } = createTestApp();
      db.query.projects.findMany.mockResolvedValue([
        {
          id: 'proj-1',
          name: 'P1',
          path: '/p1',
          description: null,
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
        },
      ]);
      db.query.tasks.findMany.mockResolvedValue([]);
      db.query.agents.findMany.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'Agent 1',
          status: 'running',
          projectId: 'proj-1',
          currentTaskId: null,
        },
      ]);

      const res = await request(app, 'GET', '/api/projects/summaries');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.items[0].status).toBe('running');
      expect(json.data.items[0].runningAgents).toHaveLength(1);
    });

    it('returns 500 when database fails', async () => {
      const { app, db } = createTestApp();
      db.query.projects.findMany.mockRejectedValue(new Error('DB error'));

      const res = await request(app, 'GET', '/api/projects/summaries');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });
});
