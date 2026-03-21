import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Codespace } from '@/db/schema';
import { DEFAULT_CODESPACE_CONFIG } from '@/lib/config/types';

// Hoisted mocks for file deletion tests
const fsMocks = vi.hoisted(() => ({
  stat: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  stat: fsMocks.stat,
  rm: fsMocks.rm,
}));

// =============================================================================
// File Deletion Security Tests (using Hono routes directly)
// =============================================================================

describe('DELETE /api/codespaces/:id - File Deletion Security', () => {
  // Import the Hono route factory
  let createCodespacesRoutes: typeof import('@/server/routes/codespaces').createCodespacesRoutes;

  // Mock codespace service
  const mockCodespaceService: Record<string, any> = {
    getById: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    listWithSummaries: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };

  // Mock database (still needed for running agents check)
  const mockDb: Record<string, any> = {
    query: {
      codespaces: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      agents: {
        findMany: vi.fn(),
      },
    },
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    transaction: vi.fn(),
  };
  // transaction mock: calls the callback with the mock db itself
  mockDb.transaction.mockImplementation(async (callback: (tx: any) => any) => {
    return callback(mockDb);
  });

  const createTestCodespace = (overrides: Partial<Codespace> = {}): Codespace => ({
    id: 'proj-test-1',
    projectFolderId: 'default-folder',
    name: 'Test Project',
    path: '/Users/testuser/projects/myproject',
    description: null,
    config: DEFAULT_CODESPACE_CONFIG,
    maxConcurrentAgents: 3,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
    sandboxConfigId: null,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-02T00:00:00Z').toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-import after reset to get fresh module with mocks
    const module = await import('@/server/routes/codespaces');
    createCodespacesRoutes = module.createCodespacesRoutes;

    // Reset mock codespace service
    mockCodespaceService.getById.mockReset();
    mockCodespaceService.delete.mockReset();

    // Reset mock database
    mockDb.query.codespaces.findFirst.mockReset();
    mockDb.query.agents.findMany.mockReset();
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockDb.transaction.mockImplementation(async (callback: (tx: any) => any) => {
      return callback(mockDb);
    });
  });

  it('returns filesDeleted: false with reason when path is too shallow', async () => {
    const codespace = createTestCodespace({ path: '/home/user' }); // Only 2 components
    mockCodespaceService.getById.mockResolvedValue({ ok: true, value: codespace });
    mockCodespaceService.delete.mockResolvedValue({ ok: true, value: undefined });
    mockDb.query.agents.findMany.mockResolvedValue([]);

    const app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as never,
      db: mockDb as never,
    });
    const response = await app.request('/proj-test-1?deleteFiles=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.deleted).toBe(true);
    expect(data.data.filesDeleted).toBe(false);
    expect(data.data.reason).toContain('too shallow');
  });

  it('returns filesDeleted: false with reason when path matches system directory', async () => {
    const codespace = createTestCodespace({ path: '/Users' }); // Exact match to dangerous prefix
    mockCodespaceService.getById.mockResolvedValue({ ok: true, value: codespace });
    mockCodespaceService.delete.mockResolvedValue({ ok: true, value: undefined });
    mockDb.query.agents.findMany.mockResolvedValue([]);

    const app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as never,
      db: mockDb as never,
    });
    const response = await app.request('/proj-test-1?deleteFiles=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.deleted).toBe(true);
    expect(data.data.filesDeleted).toBe(false);
    expect(data.data.reason).toContain('system directory');
  });

  it('returns filesDeleted: false with reason when path has insufficient depth under system prefix', async () => {
    const codespace = createTestCodespace({ path: '/Users/testuser/projects' }); // 3 components, but under dangerous prefix needs 4
    mockCodespaceService.getById.mockResolvedValue({ ok: true, value: codespace });
    mockCodespaceService.delete.mockResolvedValue({ ok: true, value: undefined });
    mockDb.query.agents.findMany.mockResolvedValue([]);

    const app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as never,
      db: mockDb as never,
    });
    const response = await app.request('/proj-test-1?deleteFiles=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.deleted).toBe(true);
    expect(data.data.filesDeleted).toBe(false);
    // The reason from path-safety.ts is: "Path under system directory must have at least 4 components"
    expect(data.data.reason).toContain('at least 4 components');
  });

  it('returns filesDeleted: true when path is safe and deletion succeeds', async () => {
    const codespace = createTestCodespace({ path: '/Users/testuser/projects/myproject' }); // 4 components - safe
    mockCodespaceService.getById.mockResolvedValue({ ok: true, value: codespace });
    mockCodespaceService.delete.mockResolvedValue({ ok: true, value: undefined });
    mockDb.query.agents.findMany.mockResolvedValue([]);

    // Mock fs.stat to return directory
    fsMocks.stat.mockResolvedValue({ isDirectory: () => true });
    // Mock fs.rm to succeed
    fsMocks.rm.mockResolvedValue(undefined);

    const app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as never,
      db: mockDb as never,
    });
    const response = await app.request('/proj-test-1?deleteFiles=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.deleted).toBe(true);
    expect(data.data.filesDeleted).toBe(true);
    expect(fsMocks.rm).toHaveBeenCalledWith(codespace.path, { recursive: true, force: true });
  });

  it('returns filesDeleted: false with error when fs.rm fails', async () => {
    const codespace = createTestCodespace({ path: '/Users/testuser/projects/myproject' });
    mockCodespaceService.getById.mockResolvedValue({ ok: true, value: codespace });
    mockCodespaceService.delete.mockResolvedValue({ ok: true, value: undefined });
    mockDb.query.agents.findMany.mockResolvedValue([]);

    // Mock fs.stat to return directory
    fsMocks.stat.mockResolvedValue({ isDirectory: () => true });
    // Mock fs.rm to fail
    fsMocks.rm.mockRejectedValue(new Error('Permission denied'));

    const app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as never,
      db: mockDb as never,
    });
    const response = await app.request('/proj-test-1?deleteFiles=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.deleted).toBe(true);
    // When fs.rm fails, filesDeleted is false and fileDeletionError contains the error message
    expect(data.data.filesDeleted).toBe(false);
    expect(data.data.fileDeletionError).toBe('Permission denied');
  });

  it('returns filesDeleted: false when path is not a directory', async () => {
    const codespace = createTestCodespace({ path: '/Users/testuser/projects/myproject' });
    mockCodespaceService.getById.mockResolvedValue({ ok: true, value: codespace });
    mockCodespaceService.delete.mockResolvedValue({ ok: true, value: undefined });
    mockDb.query.agents.findMany.mockResolvedValue([]);

    // Mock fs.stat to return a file (not a directory)
    fsMocks.stat.mockResolvedValue({ isDirectory: () => false });

    const app = createCodespacesRoutes({
      codespaceService: mockCodespaceService as never,
      db: mockDb as never,
    });
    const response = await app.request('/proj-test-1?deleteFiles=true', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.data.deleted).toBe(true);
    // Path exists but is not a directory - files cannot be deleted
    expect(data.data.filesDeleted).toBe(false);
    expect(data.data.reason).toBe('Path is not a directory');
    // fs.rm should not be called since it's not a directory
    expect(fsMocks.rm).not.toHaveBeenCalled();
  });
});
