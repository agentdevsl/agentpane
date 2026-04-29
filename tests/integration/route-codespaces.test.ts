import { createId } from '@paralleldrive/cuid2';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, codespaces, projectFolders } from '../../src/db/schema';
import { createCodespacesRoutes } from '../../src/server/routes/codespaces';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for codespaces API routes.
 *
 * Tests create (path validation, traversal prevention), list, summaries,
 * get, update, delete (running agents check, file deletion), and skills
 * endpoints.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

function createMockCodespaceService() {
  return {
    list: vi.fn(),
    listWithSummaries: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockTemplateService() {
  return {
    getMergedConfig: vi.fn(),
  };
}

describe('Codespaces Routes (IT-1150)', () => {
  let app: Hono;
  let db: ReturnType<typeof getTestDb>;
  let mockCodespaceService: ReturnType<typeof createMockCodespaceService>;
  let mockTemplateService: ReturnType<typeof createMockTemplateService>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    mockCodespaceService = createMockCodespaceService();
    mockTemplateService = createMockTemplateService();

    app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as any,
      templateService: mockTemplateService as any,
      db: db as any,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  // ─── GET / (list) ─────────────────────────────────────

  it('IT-1150: GET / lists codespaces', async () => {
    const now = new Date().toISOString();
    mockCodespaceService.list.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'cs-1',
          name: 'Project A',
          path: '/home/user/projecta',
          description: 'Desc',
          projectFolderId: 'default-folder',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const res = await app.request('http://localhost/');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].name).toBe('Project A');
    expect(body.data.totalCount).toBe(1);
  });

  it('IT-1151: GET / respects limit parameter', async () => {
    mockCodespaceService.list.mockResolvedValue({
      ok: true,
      value: [],
    });

    await app.request('http://localhost/?limit=5');

    expect(mockCodespaceService.list).toHaveBeenCalledWith({ limit: 5 });
  });

  it('IT-1152: GET / returns error on service failure', async () => {
    mockCodespaceService.list.mockResolvedValue({
      ok: false,
      error: { code: 'DB_ERROR', message: 'Connection failed', status: 500 },
    });

    const res = await app.request('http://localhost/');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  // ─── POST / (create) ──────────────────────────────────

  it('IT-1153: POST / creates a codespace', async () => {
    const now = new Date().toISOString();
    mockCodespaceService.create.mockResolvedValue({
      ok: true,
      value: {
        id: 'cs-new',
        name: 'New CS',
        path: '/home/user/project',
        description: null,
        projectFolderId: 'default-folder',
        createdAt: now,
        updatedAt: now,
      },
    });

    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'New CS',
        path: '/home/user/project',
        projectFolderId: 'default-folder',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('New CS');
  });

  it('IT-1154: POST / returns 400 when name is missing', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/', {
        path: '/home/user/project',
        projectFolderId: 'default-folder',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1155: POST / returns 400 when path is too shallow (< 3 components)', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Bad Path',
        path: '/tmp',
        projectFolderId: 'default-folder',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('too shallow');
  });

  it('IT-1156: POST / returns 400 for root path traversal attack', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Evil',
        path: '/home/user/../../../etc',
        projectFolderId: 'default-folder',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // path.resolve('/home/user/../../../etc') = '/etc' which has < 3 components
    expect(body.error.message).toContain('too shallow');
  });

  it('IT-1157: POST / returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1158: POST / returns service error code for duplicate path', async () => {
    mockCodespaceService.create.mockResolvedValue({
      ok: false,
      error: {
        code: 'CODESPACE_PATH_EXISTS',
        message: 'Path already registered',
        status: 409,
      },
    });

    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Dupe',
        path: '/home/user/existing',
        projectFolderId: 'default-folder',
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('DUPLICATE');
  });

  // ─── GET /summaries ───────────────────────────────────

  it('IT-1159: GET /summaries returns codespaces with task counts', async () => {
    const now = new Date().toISOString();
    mockCodespaceService.listWithSummaries.mockResolvedValue({
      ok: true,
      value: [
        {
          codespace: {
            id: 'cs-1',
            name: 'P1',
            path: '/p1',
            description: null,
            projectFolderId: 'default-folder',
            createdAt: now,
            updatedAt: now,
          },
          taskCounts: {
            backlog: 5,
            inProgress: 2,
            waitingApproval: 1,
            verified: 3,
            total: 11,
          },
          runningAgents: 1,
          status: 'active',
          lastActivityAt: now,
        },
      ],
    });

    const res = await app.request('http://localhost/summaries');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].taskCounts.backlog).toBe(5);
    expect(body.data.items[0].taskCounts.queued).toBe(0); // hardcoded to 0
    expect(body.data.items[0].runningAgents).toBe(1);
    expect(body.data.items[0].status).toBe('active');
  });

  // ─── GET /:id ─────────────────────────────────────────

  it('IT-1160: GET /:id returns a codespace', async () => {
    const now = new Date().toISOString();
    mockCodespaceService.getById.mockResolvedValue({
      ok: true,
      value: {
        id: 'cs-1',
        name: 'Found',
        path: '/found',
        description: 'Desc',
        projectFolderId: 'default-folder',
        maxConcurrentAgents: 3,
        config: {},
        createdAt: now,
        updatedAt: now,
      },
    });

    const res = await app.request('http://localhost/cs-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('Found');
    expect(body.data.maxConcurrentAgents).toBe(3);
  });

  it('IT-1161: GET /:id returns 404 for unknown codespace', async () => {
    mockCodespaceService.getById.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
    });

    const res = await app.request('http://localhost/cs-unknown');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-1162: GET /:id returns 400 for invalid ID format', async () => {
    const res = await app.request('http://localhost/invalid!id');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── PATCH /:id (update) ──────────────────────────────

  it('IT-1163: PATCH /:id updates a codespace', async () => {
    const now = new Date().toISOString();
    mockCodespaceService.update.mockResolvedValue({
      ok: true,
      value: {
        id: 'cs-1',
        name: 'Updated',
        path: '/p1',
        description: 'New desc',
        projectFolderId: 'default-folder',
        maxConcurrentAgents: 5,
        config: {},
        createdAt: now,
        updatedAt: now,
      },
    });

    const res = await app.request(
      new Request('http://localhost/cs-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated', description: 'New desc' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('Updated');
  });

  it('IT-1164: PATCH /:id returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/cs-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── DELETE /:id ──────────────────────────────────────

  it('IT-1165: DELETE /:id deletes a codespace', async () => {
    mockCodespaceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'cs-1', path: '/home/user/project' },
    });
    mockCodespaceService.delete.mockResolvedValue({
      ok: true,
      value: null,
    });

    const res = await app.request('http://localhost/cs-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
    expect(body.data.filesDeleted).toBe(false);
  });

  it('IT-1166: DELETE /:id returns 404 when codespace not found', async () => {
    mockCodespaceService.getById.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
    });

    const res = await app.request('http://localhost/cs-gone', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-1167: DELETE /:id returns 409 when running agents exist', async () => {
    // Create real data in the DB for this test (agents query uses real DB)
    const codespaceId = createId();

    try {
      await db.insert(projectFolders).values({
        id: 'default-folder',
        name: 'Default',
        slug: 'default',
      });
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes('UNIQUE constraint failed')) throw e;
    }

    await db.insert(codespaces).values({
      id: codespaceId,
      name: 'With Agents',
      path: `/tmp/test-${codespaceId}`,
      projectFolderId: 'default-folder',
    });

    await db.insert(agents).values({
      id: createId(),
      codespaceId,
      name: 'Running Agent',
      type: 'task',
      status: 'running',
    });

    mockCodespaceService.getById.mockResolvedValue({
      ok: true,
      value: { id: codespaceId, path: `/tmp/test-${codespaceId}` },
    });

    const res = await app.request(`http://localhost/${codespaceId}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CODESPACE_HAS_RUNNING_AGENTS');
  });

  it('IT-1168: DELETE /:id returns 400 for invalid ID', async () => {
    const res = await app.request('http://localhost/bad!id', {
      method: 'DELETE',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── GET /:id/skills ──────────────────────────────────

  it('IT-1169: GET /:id/skills returns skills list', async () => {
    mockTemplateService.getMergedConfig.mockResolvedValue({
      ok: true,
      value: {
        skills: [
          {
            id: 'deploy',
            name: 'Deploy',
            description: 'Deploy to prod',
            tags: ['devops'],
            content: 'deploy script',
            sourceType: 'template',
            sourceName: 'Infra',
          },
        ],
      },
    });

    const res = await app.request('http://localhost/cs-1/skills');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('deploy');
    // content should NOT be in list response
    expect(body.data[0].content).toBeUndefined();
  });

  it('IT-1170: GET /:id/skills propagates upstream failure (F07-03)', async () => {
    // F07-03: the skills handler must NOT mask a template-service failure
    // as an empty list. Propagate as `{ok:false, error}` so clients can
    // surface a degraded state instead of an indistinguishable empty one.
    mockTemplateService.getMergedConfig.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'No templates', status: 404 },
    });

    const res = await app.request('http://localhost/cs-1/skills');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-1171: GET /:id/skills returns empty when skills array is empty', async () => {
    mockTemplateService.getMergedConfig.mockResolvedValue({
      ok: true,
      value: { skills: [] },
    });

    const res = await app.request('http://localhost/cs-1/skills');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  // ─── GET /:id/skills/:skillId ─────────────────────────

  it('IT-1172: GET /:id/skills/:skillId returns skill with content', async () => {
    mockTemplateService.getMergedConfig.mockResolvedValue({
      ok: true,
      value: {
        skills: [
          {
            id: 'deploy',
            name: 'Deploy',
            description: 'Deploy to prod',
            tags: ['devops'],
            content: '#!/bin/bash\ndeploy.sh',
            sourceType: 'template',
            sourceName: 'Infra',
          },
        ],
      },
    });

    const res = await app.request('http://localhost/cs-1/skills/deploy');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('deploy');
    expect(body.data.content).toBe('#!/bin/bash\ndeploy.sh');
  });

  it('IT-1173: GET /:id/skills/:skillId returns 404 when skill not found', async () => {
    mockTemplateService.getMergedConfig.mockResolvedValue({
      ok: true,
      value: { skills: [] },
    });

    const res = await app.request('http://localhost/cs-1/skills/nonexistent');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SKILL_NOT_FOUND');
  });

  it('IT-1174: GET /:id/skills/:skillId returns 400 for invalid skill ID', async () => {
    const res = await app.request('http://localhost/cs-1/skills/bad!skill');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('IT-1175: GET /:id/skills/:skillId returns 404 when no templates configured', async () => {
    mockTemplateService.getMergedConfig.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'No templates', status: 404 },
    });

    const res = await app.request('http://localhost/cs-1/skills/deploy');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('SKILL_NOT_FOUND');
  });
});
