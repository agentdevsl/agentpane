import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketplaces } from '../../src/db/schema';
import type { CachedPlugin } from '../../src/db/schema/sqlite/marketplaces';
import { MarketplaceService } from '../../src/services/marketplace.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('MarketplaceService (IT-200)', () => {
  let service: MarketplaceService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    // Clear marketplaces table before each test
    await db.delete(marketplaces);
    service = new MarketplaceService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('create (IT-201)', () => {
    it('creates a marketplace from githubOwner and githubRepo', async () => {
      const result = await service.create({
        name: 'My Plugins',
        githubOwner: 'acme',
        githubRepo: 'plugins',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('My Plugins');
      expect(result.value.githubOwner).toBe('acme');
      expect(result.value.githubRepo).toBe('plugins');
      expect(result.value.branch).toBe('main');
      expect(result.value.pluginsPath).toBe('plugins');
      expect(result.value.isDefault).toBe(false);
      expect(result.value.isEnabled).toBe(true);
      expect(result.value.status).toBe('active');
    });

    it('creates a marketplace from a GitHub URL', async () => {
      const result = await service.create({
        name: 'URL Marketplace',
        githubUrl: 'https://github.com/myorg/my-plugins',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.githubOwner).toBe('myorg');
      expect(result.value.githubRepo).toBe('my-plugins');
    });

    it('creates a marketplace from a GitHub URL with .git suffix', async () => {
      const result = await service.create({
        name: 'Git URL Marketplace',
        githubUrl: 'https://github.com/myorg/my-plugins.git',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.githubOwner).toBe('myorg');
      expect(result.value.githubRepo).toBe('my-plugins');
    });

    it('creates a marketplace with custom branch and pluginsPath', async () => {
      const result = await service.create({
        name: 'Custom Marketplace',
        githubOwner: 'acme',
        githubRepo: 'tools',
        branch: 'develop',
        pluginsPath: 'src/plugins',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.branch).toBe('develop');
      expect(result.value.pluginsPath).toBe('src/plugins');
    });

    it('returns error for invalid GitHub URL', async () => {
      const result = await service.create({
        name: 'Bad URL',
        githubUrl: 'not-a-valid-url',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_INVALID_URL');
    });

    it('returns error when neither URL nor owner/repo provided', async () => {
      const result = await service.create({
        name: 'Missing Info',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_MISSING_REPO_INFO');
    });

    it('returns error for duplicate owner/repo combination', async () => {
      await service.create({
        name: 'First',
        githubOwner: 'acme',
        githubRepo: 'plugins',
      });

      const duplicate = await service.create({
        name: 'Second',
        githubOwner: 'acme',
        githubRepo: 'plugins',
      });

      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) return;
      expect(duplicate.error.code).toBe('MARKETPLACE_ALREADY_EXISTS');
    });
  });

  describe('getById (IT-202)', () => {
    it('returns a marketplace by ID', async () => {
      const created = await service.create({
        name: 'Lookup Test',
        githubOwner: 'acme',
        githubRepo: 'lookup-repo',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await service.getById(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(created.value.id);
      expect(result.value.name).toBe('Lookup Test');
    });

    it('returns NOT_FOUND for nonexistent ID', async () => {
      const result = await service.getById('nonexistent-id');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_NOT_FOUND');
    });
  });

  describe('list (IT-203)', () => {
    it('returns only enabled marketplaces by default', async () => {
      const db = getTestDb();
      // Create two marketplaces, disable one
      const m1 = await service.create({
        name: 'Enabled',
        githubOwner: 'org1',
        githubRepo: 'repo1',
      });
      const m2 = await service.create({
        name: 'Disabled',
        githubOwner: 'org2',
        githubRepo: 'repo2',
      });
      expect(m1.ok && m2.ok).toBe(true);
      if (!m2.ok) return;

      await db
        .update(marketplaces)
        .set({ isEnabled: false })
        .where(eq(marketplaces.id, m2.value.id));

      const result = await service.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.name).toBe('Enabled');
    });

    it('returns all marketplaces when includeDisabled is true', async () => {
      const db = getTestDb();
      await service.create({
        name: 'Enabled',
        githubOwner: 'org1',
        githubRepo: 'repo1',
      });
      const m2 = await service.create({
        name: 'Disabled',
        githubOwner: 'org2',
        githubRepo: 'repo2',
      });
      if (!m2.ok) return;

      await db
        .update(marketplaces)
        .set({ isEnabled: false })
        .where(eq(marketplaces.id, m2.value.id));

      const result = await service.list({ includeDisabled: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it('supports limit and offset pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await service.create({
          name: `Marketplace ${i}`,
          githubOwner: `org${i}`,
          githubRepo: `repo${i}`,
        });
      }

      const page1 = await service.list({ limit: 2, offset: 0 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.value).toHaveLength(2);

      const page2 = await service.list({ limit: 2, offset: 2 });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.value).toHaveLength(2);

      const page3 = await service.list({ limit: 2, offset: 4 });
      expect(page3.ok).toBe(true);
      if (!page3.ok) return;
      expect(page3.value).toHaveLength(1);
    });
  });

  describe('update (IT-204)', () => {
    it('updates marketplace name, branch, and pluginsPath', async () => {
      const created = await service.create({
        name: 'Original',
        githubOwner: 'acme',
        githubRepo: 'plugins',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const updated = await service.update(created.value.id, {
        name: 'Updated Name',
        branch: 'develop',
        pluginsPath: 'custom/path',
      });

      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.name).toBe('Updated Name');
      expect(updated.value.branch).toBe('develop');
      expect(updated.value.pluginsPath).toBe('custom/path');
    });

    it('disables a non-default marketplace', async () => {
      const created = await service.create({
        name: 'Disable Test',
        githubOwner: 'acme',
        githubRepo: 'disable-repo',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const updated = await service.update(created.value.id, { isEnabled: false });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.isEnabled).toBe(false);
    });

    it('prevents disabling the default marketplace', async () => {
      // Seed the default marketplace
      await service.seedDefaultMarketplace();
      const listed = await service.list();
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const defaultMp = listed.value.find((m) => m.isDefault);
      expect(defaultMp).toBeDefined();

      const result = await service.update(defaultMp!.id, { isEnabled: false });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_CANNOT_DISABLE_DEFAULT');
    });

    it('returns NOT_FOUND when updating nonexistent ID', async () => {
      const result = await service.update('nonexistent-id', { name: 'Whatever' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_NOT_FOUND');
    });
  });

  describe('delete (IT-205)', () => {
    it('deletes a non-default marketplace', async () => {
      const created = await service.create({
        name: 'Delete Me',
        githubOwner: 'acme',
        githubRepo: 'delete-repo',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const deleteResult = await service.delete(created.value.id);
      expect(deleteResult.ok).toBe(true);

      // Verify it is gone
      const getResult = await service.getById(created.value.id);
      expect(getResult.ok).toBe(false);
    });

    it('prevents deleting the default marketplace', async () => {
      await service.seedDefaultMarketplace();
      const listed = await service.list();
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const defaultMp = listed.value.find((m) => m.isDefault);
      expect(defaultMp).toBeDefined();

      const result = await service.delete(defaultMp!.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_CANNOT_DELETE_DEFAULT');
    });

    it('returns NOT_FOUND for nonexistent ID', async () => {
      const result = await service.delete('nonexistent-id');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('MARKETPLACE_NOT_FOUND');
    });
  });

  describe('seedDefaultMarketplace (IT-206)', () => {
    it('creates the default marketplace when none exists', async () => {
      const result = await service.seedDefaultMarketplace();
      expect(result.ok).toBe(true);

      const listed = await service.list();
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const defaultMp = listed.value.find((m) => m.isDefault);
      expect(defaultMp).toBeDefined();
      expect(defaultMp!.id).toBe('anthropic-official-marketplace');
      expect(defaultMp!.name).toBe('Claude Plugins Official');
      expect(defaultMp!.githubOwner).toBe('anthropics');
      expect(defaultMp!.githubRepo).toBe('claude-plugins-official');
    });

    it('returns null when default marketplace already exists', async () => {
      await service.seedDefaultMarketplace();
      const result = await service.seedDefaultMarketplace();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it('returns null when a legacy default marketplace exists', async () => {
      // Insert a marketplace with isDefault=true but different ID
      const db = getTestDb();
      await db.insert(marketplaces).values({
        id: 'legacy-default',
        name: 'Legacy Default',
        githubOwner: 'old-org',
        githubRepo: 'old-repo',
        isDefault: true,
        isEnabled: true,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await service.seedDefaultMarketplace();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe('listAllPlugins (IT-207)', () => {
    async function seedMarketplaceWithPlugins(
      name: string,
      owner: string,
      repo: string,
      plugins: CachedPlugin[]
    ): Promise<string> {
      const db = getTestDb();
      const created = await service.create({ name, githubOwner: owner, githubRepo: repo });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('Failed to create marketplace');

      await db
        .update(marketplaces)
        .set({ cachedPlugins: plugins })
        .where(eq(marketplaces.id, created.value.id));
      return created.value.id;
    }

    it('returns plugins from all enabled marketplaces', async () => {
      await seedMarketplaceWithPlugins('MP1', 'org1', 'repo1', [
        { id: 'p1', name: 'Plugin One', description: 'First plugin' },
        { id: 'p2', name: 'Plugin Two', description: 'Second plugin' },
      ]);
      await seedMarketplaceWithPlugins('MP2', 'org2', 'repo2', [
        { id: 'p3', name: 'Plugin Three', description: 'Third plugin' },
      ]);

      const result = await service.listAllPlugins();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
      expect(result.value.map((p) => p.id)).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
    });

    it('filters by marketplace ID', async () => {
      const mp1Id = await seedMarketplaceWithPlugins('MP1', 'org1', 'repo1', [
        { id: 'p1', name: 'Plugin One' },
      ]);
      await seedMarketplaceWithPlugins('MP2', 'org2', 'repo2', [{ id: 'p2', name: 'Plugin Two' }]);

      const result = await service.listAllPlugins({ marketplaceId: mp1Id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe('p1');
    });

    it('filters by category', async () => {
      await seedMarketplaceWithPlugins('MP1', 'org1', 'repo1', [
        { id: 'p1', name: 'Plugin One', category: 'testing' },
        { id: 'p2', name: 'Plugin Two', category: 'deployment' },
      ]);

      const result = await service.listAllPlugins({ category: 'testing' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe('p1');
    });

    it('filters by search term (name match)', async () => {
      await seedMarketplaceWithPlugins('MP1', 'org1', 'repo1', [
        { id: 'p1', name: 'Code Formatter', description: 'Formats code' },
        { id: 'p2', name: 'Test Runner', description: 'Runs tests' },
      ]);

      const result = await service.listAllPlugins({ search: 'formatter' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe('p1');
    });

    it('filters by search term (description match)', async () => {
      await seedMarketplaceWithPlugins('MP1', 'org1', 'repo1', [
        { id: 'p1', name: 'Plugin A', description: 'Handles deployment pipelines' },
        { id: 'p2', name: 'Plugin B', description: 'Runs unit tests' },
      ]);

      const result = await service.listAllPlugins({ search: 'pipeline' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe('p1');
    });

    it('excludes plugins from disabled marketplaces', async () => {
      const db = getTestDb();
      const mpId = await seedMarketplaceWithPlugins('MP1', 'org1', 'repo1', [
        { id: 'p1', name: 'Visible Plugin' },
      ]);

      // Disable the marketplace
      await db.update(marketplaces).set({ isEnabled: false }).where(eq(marketplaces.id, mpId));

      const result = await service.listAllPlugins();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('returns empty array when no plugins exist', async () => {
      const result = await service.listAllPlugins();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('includes marketplace metadata on each plugin', async () => {
      const mpId = await seedMarketplaceWithPlugins('Acme Plugins', 'acme', 'plugins-repo', [
        { id: 'p1', name: 'My Plugin', category: 'tools' },
      ]);

      const result = await service.listAllPlugins();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.marketplaceId).toBe(mpId);
      expect(result.value[0]?.marketplaceName).toBe('Acme Plugins');
      expect(result.value[0]?.isEnabled).toBe(true);
    });
  });

  describe('getCategories (IT-208)', () => {
    it('returns unique sorted categories from all enabled marketplaces', async () => {
      const db = getTestDb();
      const m1 = await service.create({ name: 'MP1', githubOwner: 'o1', githubRepo: 'r1' });
      const m2 = await service.create({ name: 'MP2', githubOwner: 'o2', githubRepo: 'r2' });
      expect(m1.ok && m2.ok).toBe(true);
      if (!m1.ok || !m2.ok) return;

      await db
        .update(marketplaces)
        .set({
          cachedPlugins: [
            { id: 'p1', name: 'P1', category: 'testing' },
            { id: 'p2', name: 'P2', category: 'deployment' },
          ] as CachedPlugin[],
        })
        .where(eq(marketplaces.id, m1.value.id));

      await db
        .update(marketplaces)
        .set({
          cachedPlugins: [
            { id: 'p3', name: 'P3', category: 'testing' }, // duplicate category
            { id: 'p4', name: 'P4', category: 'analytics' },
          ] as CachedPlugin[],
        })
        .where(eq(marketplaces.id, m2.value.id));

      const result = await service.getCategories();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(['analytics', 'deployment', 'testing']);
    });

    it('returns empty array when no plugins have categories', async () => {
      const result = await service.getCategories();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });
  });
});
