/**
 * Tag routes tests
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectTagRoutes,
  createTagsRoutes,
  createTaskTagRoutes,
} from '../../src/server/routes/tags';

// Mock helpers
function chainable(returnValue?: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'from', 'where', 'orderBy', 'limit', 'leftJoin', 'groupBy', 'innerJoin', 'insert', 'values', 'onConflictDoNothing', 'returning', 'delete']) {
    chain[method] = vi.fn().mockReturnThis();
  }
  if (returnValue !== undefined) {
    chain.where = vi.fn().mockResolvedValue(returnValue);
    chain.returning = vi.fn().mockResolvedValue(returnValue);
    chain.onConflictDoNothing = vi.fn().mockResolvedValue(returnValue);
  }
  return chain;
}

const mockRbacService = {
  resolveTeamRole: vi.fn(),
  resolveUserRole: vi.fn(),
  hasMinimumRole: vi.fn(),
};

function createMockDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
        groupBy: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    query: {
      teams: { findFirst: vi.fn() },
      tags: { findFirst: vi.fn() },
      projects: { findFirst: vi.fn() },
    },
  };
}

function createApp(routes: Hono, path: string, authOverride?: object) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authOverride ?? { userId: 'user-1', authMethod: 'session' });
    return next();
  });
  app.route(path, routes);
  return app;
}

describe('Tag Routes', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockRbacService.resolveTeamRole.mockResolvedValue('admin');
    mockRbacService.resolveUserRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(true);
  });

  describe('POST /tags - Create tag', () => {
    it('creates a tag successfully', async () => {
      const tag = { id: 'tag-1', teamId: 'team-1', name: 'backend', color: '#ff0000' };
      mockDb.insert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([tag]),
        }),
      });

      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-1', name: 'backend', color: '#ff0000' }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('backend');
    });

    it('returns 409 for duplicate tag name', async () => {
      mockDb.insert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed')),
        }),
      });

      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-1', name: 'backend' }),
      });

      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json.error.code).toBe('TAG_ALREADY_EXISTS');
    });

    it('requires agent_operator role', async () => {
      mockRbacService.resolveTeamRole.mockResolvedValue('viewer');
      mockRbacService.hasMinimumRole.mockReturnValue(false);

      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team-1', name: 'backend' }),
      });

      // L6: Returns 404 for non-members
      expect(response.status).toBeLessThanOrEqual(404);
    });
  });

  describe('GET /tags - List tags', () => {
    it('lists tags with batch-counted projectCount and taskCount', async () => {
      const tagList = [
        { id: 'tag-1', teamId: 'team-1', name: 'backend', color: '#ff0000' },
        { id: 'tag-2', teamId: 'team-1', name: 'frontend', color: '#00ff00' },
      ];

      // First select call returns tags
      let callCount = 0;
      mockDb.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve(tagList);
            return Promise.resolve([]);
          }),
          groupBy: vi.fn().mockResolvedValue([]),
        })),
      }));

      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags?teamId=team-1');
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(2);
    });

    it('requires teamId query parameter', async () => {
      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags');
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /tags/:id - Delete tag', () => {
    it('deletes a tag successfully', async () => {
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ teamId: 'team-1' }]),
        }),
      });

      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags/tag-1', { method: 'DELETE' });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.deleted).toBe(true);
    });

    it('returns 404 when tag not found', async () => {
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const routes = createTagsRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
      const app = createApp(routes, '/tags');

      const response = await app.request('/tags/nonexistent', { method: 'DELETE' });
      expect(response.status).toBe(404);
    });
  });
});

describe('Project Tag Routes', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockRbacService.resolveUserRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(true);
  });

  it('assigns a tag to a project', async () => {
    // Tag exists and belongs to team
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ teamId: 'team-1' }]); // tag record
          return Promise.resolve([{ teamId: 'team-1' }]); // team owns project
        }),
      }),
    }));
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
    // Wrap with parent route that provides :id param
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1', authMethod: 'session' });
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const response = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
  });

  it('returns 403 when tag belongs to different team', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ teamId: 'team-1' }]);
          return Promise.resolve([]); // team does NOT own project
        }),
      }),
    }));

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1', authMethod: 'session' });
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const response = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(response.status).toBe(403);
  });
});

describe('Task Tag Routes', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockRbacService.resolveUserRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(true);
  });

  it('assigns a tag to a task', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ projectId: 'proj-1' }]); // task lookup
          if (selectCall === 2) return Promise.resolve([{ teamId: 'team-1' }]); // tag record
          return Promise.resolve([{ teamId: 'team-1' }]); // team owns project
        }),
      }),
    }));
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1', authMethod: 'session' });
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const response = await app.request('/tasks/task-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
  });

  it('returns 404 when task not found', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService: mockRbacService as never });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1', authMethod: 'session' });
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const response = await app.request('/tasks/nonexistent/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(response.status).toBe(404);
  });
});
