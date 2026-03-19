import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowService } from '../../../services/workflow.service.js';
import { createWorkflowsRoutes } from '../workflows.js';

// ── Mock Database ──

function createMockDb() {
  return {
    query: {
      workflows: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

// Helper to set up chainable select (for count query)
function setupSelectMock(db: ReturnType<typeof createMockDb>, returnValue: unknown[]) {
  const where = vi.fn().mockResolvedValue(returnValue);
  const from = vi.fn().mockReturnValue({ where });
  db.select.mockReturnValue({ from });
  return { from, where };
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
  const workflowService = new WorkflowService(db as never);
  const routes = createWorkflowsRoutes({ workflowService });
  const app = new Hono();
  app.route('/api/workflows', routes);
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

describe('Workflows API Routes', () => {
  // ── GET /api/workflows ──

  describe('GET /api/workflows', () => {
    it('returns paginated workflows list', async () => {
      const { app, db } = createTestApp();
      const mockWorkflows = [
        { id: 'wf-1', name: 'Workflow 1', status: 'draft', updatedAt: '2025-01-01' },
      ];
      setupSelectMock(db, [{ total: 1 }]);
      db.query.workflows.findMany.mockResolvedValue(mockWorkflows);

      const res = await request(app, 'GET', '/api/workflows');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.totalCount).toBe(1);
      expect(json.data.limit).toBe(50);
      expect(json.data.offset).toBe(0);
    });

    it('supports limit and offset query params', async () => {
      const { app, db } = createTestApp();
      setupSelectMock(db, [{ total: 100 }]);
      db.query.workflows.findMany.mockResolvedValue([]);

      const res = await request(app, 'GET', '/api/workflows?limit=10&offset=20');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.limit).toBe(10);
      expect(json.data.offset).toBe(20);
      expect(json.data.hasMore).toBe(true);
    });

    it('supports status filter', async () => {
      const { app, db } = createTestApp();
      setupSelectMock(db, [{ total: 0 }]);
      db.query.workflows.findMany.mockResolvedValue([]);

      const res = await request(app, 'GET', '/api/workflows?status=published');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();
      db.select.mockImplementation(() => {
        throw new Error('DB failure');
      });

      const res = await request(app, 'GET', '/api/workflows');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_DATABASE_ERROR');
    });
  });

  // ── POST /api/workflows ──

  describe('POST /api/workflows', () => {
    it('creates a workflow and returns 201', async () => {
      const { app, db } = createTestApp();
      const created = { id: 'wf-new', name: 'New Workflow', status: 'draft' };
      setupInsertMock(db, created);

      const res = await request(app, 'POST', '/api/workflows', {
        name: 'New Workflow',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('wf-new');
    });

    it('returns 400 when name is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/workflows', {
        description: 'No name',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/workflows', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('accepts optional fields like nodes, edges, tags', async () => {
      const { app, db } = createTestApp();
      const created = {
        id: 'wf-full',
        name: 'Full Workflow',
        status: 'published',
        nodes: [{ id: 'n1' }],
        edges: [{ id: 'e1' }],
        tags: ['tag1'],
      };
      setupInsertMock(db, created);

      const res = await request(app, 'POST', '/api/workflows', {
        name: 'Full Workflow',
        status: 'published',
        nodes: [{ id: 'n1' }],
        edges: [{ id: 'e1' }],
        tags: ['tag1'],
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.tags).toEqual(['tag1']);
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();
      db.insert.mockImplementation(() => {
        throw new Error('DB failure');
      });

      const res = await request(app, 'POST', '/api/workflows', {
        name: 'Workflow',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_DATABASE_ERROR');
    });
  });

  // ── GET /api/workflows/:id ──

  describe('GET /api/workflows/:id', () => {
    it('returns a workflow by id', async () => {
      const { app, db } = createTestApp();
      const workflow = { id: 'wf-1', name: 'Workflow 1', status: 'draft' };
      db.query.workflows.findFirst.mockResolvedValue(workflow);

      const res = await request(app, 'GET', '/api/workflows/wf-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('wf-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/workflows/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when workflow not found', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockResolvedValue(undefined);

      const res = await request(app, 'GET', '/api/workflows/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockRejectedValue(new Error('DB failure'));

      const res = await request(app, 'GET', '/api/workflows/wf-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_DATABASE_ERROR');
    });
  });

  // ── PATCH /api/workflows/:id ──

  describe('PATCH /api/workflows/:id', () => {
    it('updates a workflow', async () => {
      const { app, db } = createTestApp();
      const existing = { id: 'wf-1', name: 'Old Name', status: 'draft' };
      const updated = { id: 'wf-1', name: 'New Name', status: 'draft' };
      db.query.workflows.findFirst.mockResolvedValue(existing);
      setupUpdateMock(db, updated);

      const res = await request(app, 'PATCH', '/api/workflows/wf-1', {
        name: 'New Name',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('New Name');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/workflows/bad!id', {
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
      const res = await app.request('/api/workflows/wf-1', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 404 when workflow not found', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockResolvedValue(undefined);

      const res = await request(app, 'PATCH', '/api/workflows/nonexistent-id', {
        name: 'Updated',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockResolvedValue({ id: 'wf-1' });
      db.update.mockImplementation(() => {
        throw new Error('DB failure');
      });

      const res = await request(app, 'PATCH', '/api/workflows/wf-1', {
        name: 'Updated',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_DATABASE_ERROR');
    });
  });

  // ── DELETE /api/workflows/:id ──

  describe('DELETE /api/workflows/:id', () => {
    it('deletes a workflow', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockResolvedValue({ id: 'wf-1', name: 'Workflow' });
      setupDeleteMock(db);

      const res = await request(app, 'DELETE', '/api/workflows/wf-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/workflows/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when workflow not found', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockResolvedValue(undefined);

      const res = await request(app, 'DELETE', '/api/workflows/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_NOT_FOUND');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();
      db.query.workflows.findFirst.mockRejectedValue(new Error('DB failure'));

      const res = await request(app, 'DELETE', '/api/workflows/wf-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('WORKFLOW_DATABASE_ERROR');
    });
  });
});
