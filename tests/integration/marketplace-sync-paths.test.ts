/**
 * Integration tests for MarketplaceService sync, listAllPlugins, getCategories.
 *
 * The GitHub-facing helpers (`resolveOctokit`, `syncMarketplaceFromGitHub`)
 * are mocked at module scope. The service still talks to the real DB for
 * status and cachedPlugins updates.
 *
 * Run: npx vitest run --project integration tests/integration/marketplace-sync-paths.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubTokens, marketplaces } from '../../src/db/schema';
import { MarketplaceService } from '../../src/services/marketplace.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const ghMocks = vi.hoisted(() => ({
  resolveOctokit: vi.fn(),
  syncMarketplaceFromGitHub: vi.fn(),
  formatGitHubError: vi.fn(),
}));

vi.mock('../../src/lib/github/resolve-octokit.js', () => ({
  resolveOctokit: ghMocks.resolveOctokit,
}));
vi.mock('../../src/lib/github/marketplace-sync.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/github/marketplace-sync.js')>(
    '../../src/lib/github/marketplace-sync.js'
  );
  return {
    ...actual,
    syncMarketplaceFromGitHub: ghMocks.syncMarketplaceFromGitHub,
  };
});
vi.mock('../../src/lib/github/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/github/client.js')>(
    '../../src/lib/github/client.js'
  );
  return {
    ...actual,
    formatGitHubError: ghMocks.formatGitHubError,
  };
});

describe('MarketplaceService sync + listAll paths', () => {
  let service: MarketplaceService;
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await db.delete(marketplaces);
    service = new MarketplaceService(db as never);
    ghMocks.resolveOctokit.mockReset();
    ghMocks.syncMarketplaceFromGitHub.mockReset();
    ghMocks.formatGitHubError.mockReset();
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════
  // sync(): success path → status=active, cachedPlugins/sha/lastSyncedAt set
  // ═══════════════════════════════════════════════════════════════════
  it('sync() success path persists plugins, sha, lastSyncedAt and clears syncError', async () => {
    const created = await service.create({
      name: 'OK Sync',
      githubOwner: 'acme',
      githubRepo: 'plugins',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    ghMocks.resolveOctokit.mockResolvedValueOnce({ ok: true, value: {} });
    ghMocks.syncMarketplaceFromGitHub.mockResolvedValueOnce({
      ok: true,
      value: {
        plugins: [
          { id: 'p1', name: 'p1', source: { type: 'github', repo: 'a/b' } },
          { id: 'p2', name: 'p2', source: { type: 'github', repo: 'a/b' } },
        ],
        sha: 'abc123',
      },
    });

    const result = await service.sync(created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pluginCount).toBe(2);
    expect(result.value.sha).toBe('abc123');

    const after = await db.query.marketplaces.findFirst({
      where: eq(marketplaces.id, created.value.id),
    });
    expect(after?.status).toBe('active');
    expect(after?.lastSyncSha).toBe('abc123');
    expect(after?.syncError).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════
  // sync(): NOT_FOUND when marketplace id doesn't exist
  // ═══════════════════════════════════════════════════════════════════
  it('sync() returns NOT_FOUND for missing marketplace id', async () => {
    const result = await service.sync('not-a-real-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MARKETPLACE_NOT_FOUND');
  });

  // ═══════════════════════════════════════════════════════════════════
  // sync(): octokit resolution failure → status=error + syncError
  // ═══════════════════════════════════════════════════════════════════
  it('sync() with octokit resolution failure sets status=error and persists syncError', async () => {
    const created = await service.create({
      name: 'No Token',
      githubOwner: 'acme',
      githubRepo: 'no-token',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    ghMocks.resolveOctokit.mockResolvedValueOnce({
      ok: false,
      error: { code: 'GH_NO_TOKEN', message: 'no GitHub token configured' },
    });

    const result = await service.sync(created.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MARKETPLACE_SYNC_FAILED');

    const after = await db.query.marketplaces.findFirst({
      where: eq(marketplaces.id, created.value.id),
    });
    expect(after?.status).toBe('error');
    expect(after?.syncError).toContain('no GitHub token');
  });

  // ═══════════════════════════════════════════════════════════════════
  // sync(): syncMarketplaceFromGitHub returning err → status=error
  // ═══════════════════════════════════════════════════════════════════
  it('sync() captures err result from syncMarketplaceFromGitHub', async () => {
    const created = await service.create({
      name: 'GH Err',
      githubOwner: 'acme',
      githubRepo: 'gh-err',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    ghMocks.resolveOctokit.mockResolvedValueOnce({ ok: true, value: {} });
    ghMocks.syncMarketplaceFromGitHub.mockResolvedValueOnce({
      ok: false,
      error: { code: 'GH_NOT_FOUND', message: 'plugins/ does not exist' },
    });

    const result = await service.sync(created.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MARKETPLACE_SYNC_FAILED');

    const after = await db.query.marketplaces.findFirst({
      where: eq(marketplaces.id, created.value.id),
    });
    expect(after?.status).toBe('error');
    expect(after?.syncError).toContain('plugins/');
  });

  // ═══════════════════════════════════════════════════════════════════
  // sync(): catch-block 401 invalidates github token
  // ═══════════════════════════════════════════════════════════════════
  it('sync() with thrown 401 marks GitHub token as invalid', async () => {
    const created = await service.create({
      name: '401 Sync',
      githubOwner: 'acme',
      githubRepo: '401',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Seed a valid github token row that should get invalidated
    // TEST-SETUP: there is no service API to seed a github token row inside
    // the marketplace service's tests; direct insert is fixture maintenance.
    await db.insert(githubTokens).values({
      id: 'tok-1',
      encryptedToken: 'enc',
      isValid: true,
    });

    ghMocks.resolveOctokit.mockResolvedValueOnce({ ok: true, value: {} });
    ghMocks.syncMarketplaceFromGitHub.mockRejectedValueOnce(
      Object.assign(new Error('401 Unauthorized'), { status: 401 })
    );
    ghMocks.formatGitHubError.mockReturnValueOnce({
      message: '401 Unauthorized',
      status: 401,
    });

    const result = await service.sync(created.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MARKETPLACE_SYNC_FAILED');

    const tokenRow = await db.query.githubTokens.findFirst({
      where: eq(githubTokens.id, 'tok-1'),
    });
    expect(tokenRow?.isValid).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // sync(): non-401 thrown error → status=error but token NOT invalidated
  // ═══════════════════════════════════════════════════════════════════
  it('sync() with thrown non-401 error does NOT invalidate the token', async () => {
    const created = await service.create({
      name: '500 Sync',
      githubOwner: 'acme',
      githubRepo: '500',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await db.insert(githubTokens).values({
      id: 'tok-keep',
      encryptedToken: 'enc',
      isValid: true,
    });

    ghMocks.resolveOctokit.mockResolvedValueOnce({ ok: true, value: {} });
    ghMocks.syncMarketplaceFromGitHub.mockRejectedValueOnce(new Error('boom'));
    ghMocks.formatGitHubError.mockReturnValueOnce({
      message: 'boom',
      status: 500,
    });

    const result = await service.sync(created.value.id);
    expect(result.ok).toBe(false);

    const tokenRow = await db.query.githubTokens.findFirst({
      where: eq(githubTokens.id, 'tok-keep'),
    });
    expect(tokenRow?.isValid).toBe(true); // untouched
  });

  // ═══════════════════════════════════════════════════════════════════
  // listAllPlugins / getCategories
  // ═══════════════════════════════════════════════════════════════════
  describe('listAllPlugins() / getCategories()', () => {
    async function seedMarketplaceWithPlugins(name: string, plugins: unknown[]) {
      const created = await service.create({
        name,
        githubOwner: 'acme',
        githubRepo: name.toLowerCase(),
      });
      if (!created.ok) throw new Error('create failed');
      // TEST-SETUP: directly populate cachedPlugins to mirror what a
      // successful sync() would have stored. There is no public service
      // method that lets a test seed plugins without exercising the
      // GitHub-facing sync flow we're not testing here.
      await db
        .update(marketplaces)
        .set({ cachedPlugins: plugins as never })
        .where(eq(marketplaces.id, created.value.id));
      return created.value;
    }

    it('returns aggregated plugins across enabled marketplaces', async () => {
      await seedMarketplaceWithPlugins('A', [
        { id: 'p1', name: 'plugin-a', description: 'A', category: 'cli' },
        { id: 'p2', name: 'plugin-b', description: 'B', category: 'web' },
      ]);
      await seedMarketplaceWithPlugins('B', [
        { id: 'p3', name: 'plugin-c', description: 'C', category: 'cli' },
      ]);

      const result = await service.listAllPlugins();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
    });

    it('filters plugins by category', async () => {
      await seedMarketplaceWithPlugins('cat', [
        { id: 'p1', name: 'plugin-a', category: 'cli' },
        { id: 'p2', name: 'plugin-b', category: 'web' },
      ]);
      const result = await service.listAllPlugins({ category: 'web' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0].name).toBe('plugin-b');
    });

    it('filters plugins by search term across name and description', async () => {
      await seedMarketplaceWithPlugins('search', [
        { id: 'p1', name: 'foo-plugin', description: 'random' },
        { id: 'p2', name: 'bar', description: 'has the FOO keyword' },
        { id: 'p3', name: 'unrelated', description: 'nope' },
      ]);
      const result = await service.listAllPlugins({ search: 'foo' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    it('filters by marketplaceId (only that marketplace contributes plugins)', async () => {
      const a = await seedMarketplaceWithPlugins('only-a', [{ id: 'pa', name: 'only-a-plugin' }]);
      await seedMarketplaceWithPlugins('only-b', [{ id: 'pb', name: 'only-b-plugin' }]);

      const result = await service.listAllPlugins({ marketplaceId: a.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0].marketplaceId).toBe(a.id);
    });

    it('getCategories returns sorted unique category list', async () => {
      await seedMarketplaceWithPlugins('cat-multi', [
        { id: 'p1', name: 'a', category: 'web' },
        { id: 'p2', name: 'b', category: 'cli' },
        { id: 'p3', name: 'c', category: 'web' },
        { id: 'p4', name: 'd' /* no category */ },
      ]);
      const result = await service.getCategories();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(['cli', 'web']);
    });
  });
});
