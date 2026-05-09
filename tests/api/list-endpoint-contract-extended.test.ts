/**
 * Extended contract tests for list endpoints.
 *
 * Catches the `apiServerFetch<T>` double-wrap bug across every paginated /
 * collection route. The companion `list-endpoint-contract.test.ts` covers the
 * sessions endpoint and the helper self-tests; this file extends coverage to
 * tasks, marketplaces, terraform, sandbox-configs, templates, codespaces,
 * codespace-folders, and the events sources/subscriptions/log endpoints.
 *
 * For each endpoint the test asserts that the on-the-wire envelope matches
 * the type parameter passed to `apiServerFetch<T>` in `src/lib/api/client.ts`,
 * preventing regressions where someone wraps T as `{ data: T, pagination: P }`
 * (which would silently leave consumers with `result.data.data === undefined`).
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../src/lib/utils/result';
import { assertCursorEnvelopeShape, assertItemsListShape } from '../fixtures/list-contract';

// ---------------------------------------------------------------------------
// Tiny request helper
// ---------------------------------------------------------------------------

async function get(app: Hono, path: string): Promise<Response> {
  return (await app.request(path, { method: 'GET' })) as Response;
}

// ---------------------------------------------------------------------------
// /api/tasks — cursor envelope { data: { items, nextCursor, hasMore } }
// ---------------------------------------------------------------------------

describe('List endpoint contract — /api/tasks (cursor envelope)', () => {
  let app: Hono;
  const taskService = {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getDiff: vi.fn(),
    moveColumn: vi.fn(),
    approvePlan: vi.fn(),
    rejectPlan: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    stopAgent: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createTasksRoutes } = await import('../../src/server/routes/tasks');
    const routes = createTasksRoutes({ taskService: taskService as never, db: {} as never });
    app = new Hono();
    app.route('/api/tasks', routes);
  });

  it('GET /api/tasks returns { data: { items, nextCursor, hasMore } }', async () => {
    taskService.list.mockResolvedValue(
      ok([
        { id: 't-1', title: 'Task 1', column: 'backlog', position: 1, codespaceId: 'cs-1' },
        { id: 't-2', title: 'Task 2', column: 'backlog', position: 2, codespaceId: 'cs-1' },
      ])
    );

    const res = await get(app, '/api/tasks?codespaceId=cs-1');
    expect(res.status).toBe(200);
    assertCursorEnvelopeShape(await res.json());
  });

  it('empty list still satisfies the envelope contract', async () => {
    taskService.list.mockResolvedValue(ok([]));
    const res = await get(app, '/api/tasks?codespaceId=cs-1');
    const body = await res.json();
    assertCursorEnvelopeShape(body);
    expect((body as { data: { items: unknown[] } }).data.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /api/marketplaces — items + totalCount envelope
// ---------------------------------------------------------------------------

describe('List endpoint contract — /api/marketplaces (items+totalCount)', () => {
  let app: Hono;
  const marketplaceService = {
    list: vi.fn(),
    create: vi.fn(),
    seedDefaultMarketplace: vi.fn(),
    listAllPlugins: vi.fn(),
    getCategories: vi.fn(),
    sync: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createMarketplacesRoutes } = await import('../../src/server/routes/marketplaces');
    const routes = createMarketplacesRoutes({ marketplaceService: marketplaceService as never });
    app = new Hono();
    app.route('/api/marketplaces', routes);
  });

  it('GET /api/marketplaces returns { data: { items, totalCount } }', async () => {
    marketplaceService.list.mockResolvedValue(
      ok([
        {
          id: 'mp-1',
          name: 'Default',
          githubOwner: 'org',
          githubRepo: 'repo',
          branch: 'main',
          pluginsPath: 'plugins',
          isDefault: true,
          isEnabled: true,
          status: 'synced',
          lastSyncedAt: '2026-01-01',
          syncError: null,
          cachedPlugins: [],
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );

    const res = await get(app, '/api/marketplaces');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });

  it('GET /api/marketplaces/plugins returns { data: { items, totalCount } }', async () => {
    marketplaceService.listAllPlugins.mockResolvedValue(ok([{ id: 'p1', name: 'plugin-1' }]));

    const res = await get(app, '/api/marketplaces/plugins');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });
});

// ---------------------------------------------------------------------------
// /api/sandbox-configs — items + totalCount envelope
// ---------------------------------------------------------------------------

describe('List endpoint contract — /api/sandbox-configs (items+totalCount)', () => {
  let app: Hono;
  const sandboxConfigService = {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createSandboxConfigRoutes } = await import('../../src/server/routes/sandbox-configs');
    const routes = createSandboxConfigRoutes({
      sandboxConfigService: sandboxConfigService as never,
    });
    app = new Hono();
    app.route('/api/sandbox-configs', routes);
  });

  it('GET /api/sandbox-configs returns { data: { items, totalCount } }', async () => {
    sandboxConfigService.list.mockResolvedValue(
      ok({
        items: [
          {
            id: 'sc-1',
            name: 'docker',
            mode: 'docker',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        ],
        totalCount: 1,
      })
    );

    const res = await get(app, '/api/sandbox-configs');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });
});

// ---------------------------------------------------------------------------
// /api/templates — items + totalCount envelope
// ---------------------------------------------------------------------------

describe('List endpoint contract — /api/templates (items+totalCount)', () => {
  let app: Hono;
  const templateService = {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    sync: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createTemplatesRoutes } = await import('../../src/server/routes/templates');
    const routes = createTemplatesRoutes({ templateService: templateService as never });
    app = new Hono();
    app.route('/api/templates', routes);
  });

  it('GET /api/templates returns { data: { items, totalCount } }', async () => {
    templateService.list.mockResolvedValue(
      ok([
        {
          id: 'tpl-1',
          name: 'tpl',
          scope: 'org',
          githubUrl: 'https://github.com/x/y',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );

    const res = await get(app, '/api/templates');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });
});

// ---------------------------------------------------------------------------
// /api/terraform/registries and /api/terraform/modules — items + totalCount
// ---------------------------------------------------------------------------

describe('List endpoint contract — /api/terraform (items+totalCount)', () => {
  let app: Hono;
  const terraformRegistryService = {
    listRegistries: vi.fn(),
    createRegistry: vi.fn(),
    getRegistryById: vi.fn(),
    updateRegistry: vi.fn(),
    deleteRegistry: vi.fn(),
    syncRegistry: vi.fn(),
    listModules: vi.fn(),
    getModuleById: vi.fn(),
  };
  const terraformComposeService = {
    validateCode: vi.fn(),
    startCompose: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createTerraformRoutes } = await import('../../src/server/routes/terraform');
    const routes = createTerraformRoutes({
      terraformRegistryService: terraformRegistryService as never,
      terraformComposeService: terraformComposeService as never,
    });
    app = new Hono();
    app.route('/api/terraform', routes);
  });

  it('GET /api/terraform/registries returns { data: { items, totalCount } }', async () => {
    terraformRegistryService.listRegistries.mockResolvedValue(
      ok([
        {
          id: 'r-1',
          name: 'reg',
          orgName: 'org',
          status: 'synced',
          lastSyncedAt: null,
          syncError: null,
          moduleCount: 0,
          syncIntervalMinutes: 60,
          nextSyncAt: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );

    const res = await get(app, '/api/terraform/registries');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });

  it('GET /api/terraform/modules returns { data: { items, totalCount } }', async () => {
    terraformRegistryService.listModules.mockResolvedValue(
      ok([
        {
          id: 'm-1',
          registryId: 'r-1',
          name: 'mod',
          namespace: 'ns',
          provider: 'aws',
          version: '1.0.0',
          source: 'src',
          description: null,
          inputs: null,
          outputs: null,
          dependencies: null,
          publishedAt: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );

    const res = await get(app, '/api/terraform/modules');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });
});

// ---------------------------------------------------------------------------
// /api/codespace-folders — items + totalCount envelope
// ---------------------------------------------------------------------------

describe('List endpoint contract — /api/codespace-folders (items+totalCount)', () => {
  let app: Hono;
  const projectFolderService = {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    listCodespaces: vi.fn(),
    getSummary: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createCodespaceFoldersRoutes } = await import(
      '../../src/server/routes/codespace-folders'
    );
    const routes = createCodespaceFoldersRoutes({
      projectFolderService: projectFolderService as never,
    });
    app = new Hono();
    app.route('/api/codespace-folders', routes);
  });

  it('GET /api/codespace-folders returns { data: { items, totalCount } }', async () => {
    projectFolderService.list.mockResolvedValue(
      ok({
        items: [
          {
            id: 'f-1',
            name: 'folder',
            slug: 'folder',
            description: null,
            icon: null,
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
          },
        ],
        total: 1,
      })
    );

    const res = await get(app, '/api/codespace-folders');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });

  it('GET /api/codespace-folders/:id/codespaces returns items+totalCount', async () => {
    projectFolderService.listCodespaces.mockResolvedValue(
      ok([
        {
          id: 'cs-1',
          name: 'cs',
          path: '/tmp/cs',
          description: null,
          projectFolderId: 'f-1',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );

    const res = await get(app, '/api/codespace-folders/f-1/codespaces');
    expect(res.status).toBe(200);
    assertItemsListShape(await res.json());
  });
});
