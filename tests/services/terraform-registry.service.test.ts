import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import { decryptToken } from '../../src/lib/crypto/server-encryption';
import { TerraformRegistryService } from '../../src/services/terraform-registry.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock the registry client to prevent real HTTP calls
vi.mock('../../src/lib/terraform/registry-client.js', () => ({
  syncAllModules: vi.fn(),
}));

import { syncAllModules } from '../../src/lib/terraform/registry-client';

describe('TerraformRegistryService', () => {
  let service: TerraformRegistryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestDatabase();
    execRawSql(TERRAFORM_MIGRATION_SQL);
    service = new TerraformRegistryService(getTestDb());
  });

  afterEach(async () => {
    const db = getTestDb();
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await db.delete(settings);
    await clearTestDatabase();
  });

  // ===========================================================================
  // Create Registry (6 tests)
  // ===========================================================================

  describe('createRegistry', () => {
    it('creates a registry with encrypted token', async () => {
      const result = await service.createRegistry({
        name: 'Acme Registry',
        orgName: 'acme-org',
        apiToken: 'sk-tfe-secret-token',
        syncIntervalMinutes: 15,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe('Acme Registry');
      expect(result.value.orgName).toBe('acme-org');
      expect(result.value.status).toBe('active');
      expect(result.value.syncIntervalMinutes).toBe(15);
      expect(result.value.tokenSettingKey).toContain(result.value.id);

      // Verify token is encrypted
      const db = getTestDb();
      const storedSetting = await db.query.settings.findFirst({
        where: (table, { eq }) => eq(table.key, result.value.tokenSettingKey),
      });
      expect(storedSetting).toBeTruthy();
      expect(storedSetting?.value).not.toBe('sk-tfe-secret-token');
      expect(decryptToken(storedSetting?.value ?? '')).toBe('sk-tfe-secret-token');
    });

    it('creates a registry without sync interval', async () => {
      const result = await service.createRegistry({
        name: 'No Sync Registry',
        orgName: 'nosync-org',
        apiToken: 'sk-token',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.syncIntervalMinutes).toBeNull();
      expect(result.value.nextSyncAt).toBeNull();
    });

    it('sets nextSyncAt when sync interval is provided', async () => {
      const result = await service.createRegistry({
        name: 'Sync Registry',
        orgName: 'sync-org',
        apiToken: 'sk-token',
        syncIntervalMinutes: 30,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.nextSyncAt).toBeDefined();
      expect(result.value.nextSyncAt).not.toBeNull();
    });

    it('rejects duplicate orgName', async () => {
      const first = await service.createRegistry({
        name: 'First',
        orgName: 'shared-org',
        apiToken: 'sk-first',
      });
      expect(first.ok).toBe(true);

      const second = await service.createRegistry({
        name: 'Second',
        orgName: 'shared-org',
        apiToken: 'sk-second',
      });

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe('TERRAFORM_REGISTRY_ALREADY_EXISTS');
      }
    });

    it('uses distinct token keys for different registries', async () => {
      const first = await service.createRegistry({
        name: 'Registry One',
        orgName: 'acme-one',
        apiToken: 'sk-tfe-one',
      });
      const second = await service.createRegistry({
        name: 'Registry Two',
        orgName: 'acme-two',
        apiToken: 'sk-tfe-two',
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(first.value.tokenSettingKey).not.toBe(second.value.tokenSettingKey);

      // Verify each token decrypts to the correct value
      const db = getTestDb();
      const firstSetting = await db.query.settings.findFirst({
        where: eq(settings.key, first.value.tokenSettingKey),
      });
      const secondSetting = await db.query.settings.findFirst({
        where: eq(settings.key, second.value.tokenSettingKey),
      });
      expect(decryptToken(firstSetting?.value ?? '')).toBe('sk-tfe-one');
      expect(decryptToken(secondSetting?.value ?? '')).toBe('sk-tfe-two');
    });

    it('sets createdAt and updatedAt timestamps', async () => {
      const result = await service.createRegistry({
        name: 'Timestamped',
        orgName: 'ts-org',
        apiToken: 'sk-token',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.createdAt).toBeDefined();
      expect(result.value.updatedAt).toBeDefined();
      // createdAt should equal updatedAt on creation
      expect(result.value.createdAt).toBe(result.value.updatedAt);
    });
  });

  // ===========================================================================
  // Get Registry (3 tests)
  // ===========================================================================

  describe('getRegistryById', () => {
    it('returns a registry by ID', async () => {
      const createResult = await service.createRegistry({
        name: 'Test Registry',
        orgName: 'test-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.getRegistryById(createResult.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(createResult.value.id);
        expect(result.value.name).toBe('Test Registry');
      }
    });

    it('returns error for non-existent registry', async () => {
      const result = await service.getRegistryById('non-existent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
      }
    });

    it('returns full registry fields', async () => {
      const createResult = await service.createRegistry({
        name: 'Full Registry',
        orgName: 'full-org',
        apiToken: 'sk-full',
        syncIntervalMinutes: 60,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.getRegistryById(createResult.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Full Registry');
        expect(result.value.orgName).toBe('full-org');
        expect(result.value.syncIntervalMinutes).toBe(60);
        expect(result.value.status).toBe('active');
        expect(result.value.tokenSettingKey).toBeDefined();
      }
    });
  });

  // ===========================================================================
  // List Registries (3 tests)
  // ===========================================================================

  describe('listRegistries', () => {
    it('returns empty array when no registries exist', async () => {
      const result = await service.listRegistries();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns all registries', async () => {
      await service.createRegistry({ name: 'R1', orgName: 'org-1', apiToken: 'sk-1' });
      await service.createRegistry({ name: 'R2', orgName: 'org-2', apiToken: 'sk-2' });
      await service.createRegistry({ name: 'R3', orgName: 'org-3', apiToken: 'sk-3' });

      const result = await service.listRegistries();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(3);
      }
    });

    it('orders registries by most recently updated', async () => {
      await service.createRegistry({ name: 'First', orgName: 'org-1', apiToken: 'sk-1' });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await service.createRegistry({ name: 'Second', orgName: 'org-2', apiToken: 'sk-2' });

      const result = await service.listRegistries();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        // Most recently updated first
        expect(result.value[0].name).toBe('Second');
        expect(result.value[1].name).toBe('First');
      }
    });
  });

  // ===========================================================================
  // Update Registry (5 tests)
  // ===========================================================================

  describe('updateRegistry', () => {
    it('updates registry name and orgName', async () => {
      const createResult = await service.createRegistry({
        name: 'Original',
        orgName: 'original-org',
        apiToken: 'sk-original',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        name: 'Updated Name',
        orgName: 'updated-org',
      });

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        expect(updateResult.value.name).toBe('Updated Name');
        expect(updateResult.value.orgName).toBe('updated-org');
      }
    });

    it('updates encrypted token without changing key', async () => {
      const createResult = await service.createRegistry({
        name: 'Token Update Test',
        orgName: 'token-org',
        apiToken: 'sk-tfe-original',
        syncIntervalMinutes: 30,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        apiToken: 'sk-tfe-updated',
      });

      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      // Token setting key should remain the same
      expect(updateResult.value.tokenSettingKey).toBe(createResult.value.tokenSettingKey);

      // Verify the token was updated
      const db = getTestDb();
      const storedSetting = await db.query.settings.findFirst({
        where: eq(settings.key, createResult.value.tokenSettingKey),
      });
      expect(decryptToken(storedSetting?.value ?? '')).toBe('sk-tfe-updated');
    });

    it('updates sync interval and nextSyncAt', async () => {
      const createResult = await service.createRegistry({
        name: 'Sync Update Test',
        orgName: 'sync-org',
        apiToken: 'sk-token',
        syncIntervalMinutes: 15,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        syncIntervalMinutes: 60,
      });

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        expect(updateResult.value.syncIntervalMinutes).toBe(60);
        expect(updateResult.value.nextSyncAt).not.toBeNull();
      }
    });

    it('clears nextSyncAt when sync interval is set to null', async () => {
      const createResult = await service.createRegistry({
        name: 'Clear Sync Test',
        orgName: 'clearsync-org',
        apiToken: 'sk-token',
        syncIntervalMinutes: 30,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        syncIntervalMinutes: null,
      });

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        expect(updateResult.value.syncIntervalMinutes).toBeNull();
        expect(updateResult.value.nextSyncAt).toBeNull();
      }
    });

    it('returns error for non-existent registry', async () => {
      const result = await service.updateRegistry('non-existent', { name: 'Updated' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
      }
    });
  });

  // ===========================================================================
  // Delete Registry (4 tests)
  // ===========================================================================

  describe('deleteRegistry', () => {
    it('deletes registry and its token setting', async () => {
      const createResult = await service.createRegistry({
        name: 'To Delete',
        orgName: 'delete-org',
        apiToken: 'sk-tfe-delete-me',
        syncIntervalMinutes: 15,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const deleteResult = await service.deleteRegistry(createResult.value.id);
      expect(deleteResult.ok).toBe(true);

      // Verify registry is gone
      const getResult = await service.getRegistryById(createResult.value.id);
      expect(getResult.ok).toBe(false);

      // Verify token setting is gone
      const db = getTestDb();
      const storedSetting = await db.query.settings.findFirst({
        where: eq(settings.key, createResult.value.tokenSettingKey),
      });
      expect(storedSetting).toBeUndefined();
    });

    it('returns error for non-existent registry', async () => {
      const result = await service.deleteRegistry('non-existent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
      }
    });

    it('deletes associated modules when registry is deleted', async () => {
      const createResult = await service.createRegistry({
        name: 'With Modules',
        orgName: 'modules-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Insert a module for this registry
      const db = getTestDb();
      const now = new Date().toISOString();
      await db.insert(terraformModules).values({
        id: 'mod-1',
        registryId: createResult.value.id,
        name: 'test-module',
        namespace: 'acme',
        provider: 'aws',
        version: '1.0.0',
        source: 'acme/test-module/aws',
        createdAt: now,
        updatedAt: now,
      });

      // Verify module exists
      const moduleBefore = await db.query.terraformModules.findFirst({
        where: eq(terraformModules.id, 'mod-1'),
      });
      expect(moduleBefore).toBeDefined();

      // Delete registry
      await service.deleteRegistry(createResult.value.id);

      // Verify module is gone
      const moduleAfter = await db.query.terraformModules.findFirst({
        where: eq(terraformModules.id, 'mod-1'),
      });
      expect(moduleAfter).toBeUndefined();
    });

    it('allows creating a new registry with same orgName after deletion', async () => {
      const createResult = await service.createRegistry({
        name: 'Original',
        orgName: 'reuse-org',
        apiToken: 'sk-first',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await service.deleteRegistry(createResult.value.id);

      const recreateResult = await service.createRegistry({
        name: 'Recreated',
        orgName: 'reuse-org',
        apiToken: 'sk-second',
      });
      expect(recreateResult.ok).toBe(true);
      if (recreateResult.ok) {
        expect(recreateResult.value.name).toBe('Recreated');
      }
    });
  });

  // ===========================================================================
  // Sync Operations (7 tests)
  // ===========================================================================

  describe('sync', () => {
    it('syncs modules from registry API', async () => {
      const createResult = await service.createRegistry({
        name: 'Sync Test',
        orgName: 'sync-org',
        apiToken: 'sk-tfe-valid',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const now = new Date().toISOString();
      vi.mocked(syncAllModules).mockResolvedValue([
        {
          id: 'mod-1',
          name: 'vpc',
          namespace: 'sync-org',
          provider: 'aws',
          version: '2.0.0',
          source: 'sync-org/vpc/aws',
          description: 'VPC module',
          inputs: [],
          outputs: [],
          dependencies: [],
          createdAt: now,
          updatedAt: now,
        } as never,
      ]);

      const result = await service.sync(createResult.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.moduleCount).toBe(1);
        expect(result.value.registryId).toBe(createResult.value.id);
        expect(result.value.syncedAt).toBeDefined();
      }

      // Verify registry status updated
      const registryResult = await service.getRegistryById(createResult.value.id);
      expect(registryResult.ok).toBe(true);
      if (registryResult.ok) {
        expect(registryResult.value.status).toBe('active');
        expect(registryResult.value.moduleCount).toBe(1);
        expect(registryResult.value.lastSyncedAt).toBeDefined();
        expect(registryResult.value.syncError).toBeNull();
      }
    });

    it('returns error for non-existent registry', async () => {
      const result = await service.sync('non-existent-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
      }
    });

    it('returns error when token setting is missing', async () => {
      const createResult = await service.createRegistry({
        name: 'No Token',
        orgName: 'notoken-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Delete the token setting manually
      const db = getTestDb();
      await db.delete(settings).where(eq(settings.key, createResult.value.tokenSettingKey));

      const result = await service.sync(createResult.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_INVALID_TOKEN');
      }

      // Verify registry status set to error
      const registryResult = await service.getRegistryById(createResult.value.id);
      expect(registryResult.ok).toBe(true);
      if (registryResult.ok) {
        expect(registryResult.value.status).toBe('error');
        expect(registryResult.value.syncError).toContain('API token not configured');
      }
    });

    it('returns error when no modules found', async () => {
      const createResult = await service.createRegistry({
        name: 'Empty Registry',
        orgName: 'empty-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      vi.mocked(syncAllModules).mockResolvedValue([]);

      const result = await service.sync(createResult.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_NO_MODULES_SYNCED');
      }

      // Verify registry shows 0 modules but status is active
      const registryResult = await service.getRegistryById(createResult.value.id);
      expect(registryResult.ok).toBe(true);
      if (registryResult.ok) {
        expect(registryResult.value.status).toBe('active');
        expect(registryResult.value.moduleCount).toBe(0);
      }
    });

    it('handles sync API failure', async () => {
      const createResult = await service.createRegistry({
        name: 'Fail Registry',
        orgName: 'fail-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      vi.mocked(syncAllModules).mockRejectedValue(new Error('HTTP 503 Service Unavailable'));

      const result = await service.sync(createResult.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_SYNC_FAILED');
      }

      // Verify registry status set to error
      const registryResult = await service.getRegistryById(createResult.value.id);
      expect(registryResult.ok).toBe(true);
      if (registryResult.ok) {
        expect(registryResult.value.status).toBe('error');
        expect(registryResult.value.syncError).toContain('HTTP 503');
      }
    });

    it('redacts sensitive information from error messages', async () => {
      const createResult = await service.createRegistry({
        name: 'Sensitive Error',
        orgName: 'sensitive-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      vi.mocked(syncAllModules).mockRejectedValue(new Error('Invalid Bearer token: sk-secret-123'));

      await service.sync(createResult.value.id);

      const registryResult = await service.getRegistryById(createResult.value.id);
      expect(registryResult.ok).toBe(true);
      if (registryResult.ok) {
        // Should be redacted (contains 'bearer' and 'token')
        expect(registryResult.value.syncError).toBe(
          'Sync failed due to an API error. Check your token and try again.'
        );
      }
    });

    it('replaces existing modules with fresh data on sync', async () => {
      const createResult = await service.createRegistry({
        name: 'Replace Test',
        orgName: 'replace-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const now = new Date().toISOString();

      // First sync: 2 modules
      vi.mocked(syncAllModules).mockResolvedValue([
        {
          id: 'mod-a',
          name: 'moduleA',
          namespace: 'replace-org',
          provider: 'aws',
          version: '1.0.0',
          source: 'replace-org/moduleA/aws',
          createdAt: now,
          updatedAt: now,
        } as never,
        {
          id: 'mod-b',
          name: 'moduleB',
          namespace: 'replace-org',
          provider: 'aws',
          version: '1.0.0',
          source: 'replace-org/moduleB/aws',
          createdAt: now,
          updatedAt: now,
        } as never,
      ]);

      const first = await service.sync(createResult.value.id);
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value.moduleCount).toBe(2);

      // Second sync: 1 module (moduleB removed)
      vi.mocked(syncAllModules).mockResolvedValue([
        {
          id: 'mod-a-v2',
          name: 'moduleA',
          namespace: 'replace-org',
          provider: 'aws',
          version: '2.0.0',
          source: 'replace-org/moduleA/aws',
          createdAt: now,
          updatedAt: now,
        } as never,
      ]);

      const second = await service.sync(createResult.value.id);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value.moduleCount).toBe(1);

      // Verify only 1 module remains
      const modules = await service.listModules({ registryId: createResult.value.id });
      expect(modules.ok).toBe(true);
      if (modules.ok) {
        expect(modules.value).toHaveLength(1);
        expect(modules.value[0].version).toBe('2.0.0');
      }
    });
  });

  // ===========================================================================
  // List Modules (5 tests)
  // ===========================================================================

  describe('listModules', () => {
    async function createRegistryWithModules(
      orgName: string,
      moduleDefs: Array<{ name: string; provider: string; description?: string }>
    ): Promise<string> {
      const createResult = await service.createRegistry({
        name: `${orgName} Registry`,
        orgName,
        apiToken: 'sk-token',
      });
      if (!createResult.ok) throw new Error('Failed to create registry');

      const registryId = createResult.value.id;
      const db = getTestDb();
      const now = new Date().toISOString();

      for (let i = 0; i < moduleDefs.length; i++) {
        const mod = moduleDefs[i];
        await db.insert(terraformModules).values({
          id: `mod-${orgName}-${i}`,
          registryId,
          name: mod.name,
          namespace: orgName,
          provider: mod.provider,
          version: '1.0.0',
          source: `${orgName}/${mod.name}/${mod.provider}`,
          description: mod.description ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }

      return registryId;
    }

    it('returns all modules without filters', async () => {
      await createRegistryWithModules('list-org', [
        { name: 'vpc', provider: 'aws' },
        { name: 'storage', provider: 'gcp' },
      ]);

      const result = await service.listModules();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
      }
    });

    it('filters modules by registryId', async () => {
      const id1 = await createRegistryWithModules('reg1-org', [{ name: 'vpc', provider: 'aws' }]);
      await createRegistryWithModules('reg2-org', [
        { name: 'bucket', provider: 'gcp' },
        { name: 'compute', provider: 'gcp' },
      ]);

      const result = await service.listModules({ registryId: id1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0].name).toBe('vpc');
      }
    });

    it('filters modules by provider', async () => {
      await createRegistryWithModules('provider-org', [
        { name: 'vpc', provider: 'aws' },
        { name: 'bucket', provider: 'gcp' },
        { name: 'lambda', provider: 'aws' },
      ]);

      const result = await service.listModules({ provider: 'aws' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        for (const mod of result.value) {
          expect(mod.provider).toBe('aws');
        }
      }
    });

    it('searches modules by name and description', async () => {
      await createRegistryWithModules('search-org', [
        { name: 'vpc-network', provider: 'aws', description: 'Virtual Private Cloud' },
        { name: 'storage-bucket', provider: 'gcp', description: 'Object storage' },
        { name: 'database', provider: 'aws', description: 'RDS instance' },
      ]);

      const result = await service.listModules({ search: 'vpc' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should match 'vpc-network' by name and possibly 'Virtual Private Cloud' by description
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        const names = result.value.map((m) => m.name);
        expect(names).toContain('vpc-network');
      }
    });

    it('respects limit and offset for pagination', async () => {
      await createRegistryWithModules('paged-org', [
        { name: 'mod-a', provider: 'aws' },
        { name: 'mod-b', provider: 'aws' },
        { name: 'mod-c', provider: 'aws' },
        { name: 'mod-d', provider: 'aws' },
      ]);

      const page1 = await service.listModules({ limit: 2, offset: 0 });
      expect(page1.ok).toBe(true);
      if (page1.ok) {
        expect(page1.value).toHaveLength(2);
      }

      const page2 = await service.listModules({ limit: 2, offset: 2 });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        expect(page2.value).toHaveLength(2);
      }
    });
  });

  // ===========================================================================
  // Get Module By ID (2 tests)
  // ===========================================================================

  describe('getModuleById', () => {
    it('returns a module by ID', async () => {
      const createResult = await service.createRegistry({
        name: 'Module Test',
        orgName: 'modtest-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const db = getTestDb();
      const now = new Date().toISOString();
      await db.insert(terraformModules).values({
        id: 'target-mod',
        registryId: createResult.value.id,
        name: 'target',
        namespace: 'modtest-org',
        provider: 'aws',
        version: '3.0.0',
        source: 'modtest-org/target/aws',
        description: 'Target module for test',
        createdAt: now,
        updatedAt: now,
      });

      const result = await service.getModuleById('target-mod');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('target');
        expect(result.value.version).toBe('3.0.0');
        expect(result.value.description).toBe('Target module for test');
      }
    });

    it('returns error for non-existent module', async () => {
      const result = await service.getModuleById('non-existent-mod');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TERRAFORM_MODULE_NOT_FOUND');
      }
    });
  });

  // ===========================================================================
  // Module Context (3 tests)
  // ===========================================================================

  describe('getModuleContext', () => {
    it('returns formatted context string for available modules', async () => {
      const createResult = await service.createRegistry({
        name: 'Context Test',
        orgName: 'ctx-org',
        apiToken: 'sk-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const db = getTestDb();
      const now = new Date().toISOString();
      await db.insert(terraformModules).values({
        id: 'ctx-mod-1',
        registryId: createResult.value.id,
        name: 'vpc',
        namespace: 'ctx-org',
        provider: 'aws',
        version: '2.0.0',
        source: 'ctx-org/vpc/aws',
        description: 'VPC module for AWS',
        inputs: [{ name: 'cidr_block', type: 'string', required: true, description: 'CIDR block' }],
        outputs: [{ name: 'vpc_id', description: 'The VPC ID' }],
        dependencies: ['aws_subnet'],
        createdAt: now,
        updatedAt: now,
      });

      const result = await service.getModuleContext();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('# Available Terraform Modules');
        expect(result.value).toContain('ctx-org/vpc/aws');
        expect(result.value).toContain('v2.0.0');
        expect(result.value).toContain('VPC module for AWS');
        expect(result.value).toContain('cidr_block');
        expect(result.value).toContain('(required)');
        expect(result.value).toContain('vpc_id');
        expect(result.value).toContain('aws_subnet');
      }
    });

    it('returns default text when no modules exist', async () => {
      const result = await service.getModuleContext();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('No Terraform modules available.');
      }
    });

    it('filters context by registryId', async () => {
      const reg1 = await service.createRegistry({
        name: 'Ctx R1',
        orgName: 'ctxr1-org',
        apiToken: 'sk-1',
      });
      const reg2 = await service.createRegistry({
        name: 'Ctx R2',
        orgName: 'ctxr2-org',
        apiToken: 'sk-2',
      });
      expect(reg1.ok && reg2.ok).toBe(true);
      if (!reg1.ok || !reg2.ok) return;

      const db = getTestDb();
      const now = new Date().toISOString();
      await db.insert(terraformModules).values([
        {
          id: 'ctx-r1-mod',
          registryId: reg1.value.id,
          name: 'only-in-r1',
          namespace: 'ctxr1-org',
          provider: 'aws',
          version: '1.0.0',
          source: 'ctxr1-org/only-in-r1/aws',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'ctx-r2-mod',
          registryId: reg2.value.id,
          name: 'only-in-r2',
          namespace: 'ctxr2-org',
          provider: 'gcp',
          version: '1.0.0',
          source: 'ctxr2-org/only-in-r2/gcp',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await service.getModuleContext(reg1.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('only-in-r1');
        expect(result.value).not.toContain('only-in-r2');
      }
    });
  });

  // ===========================================================================
  // Token Management (2 tests)
  // ===========================================================================

  describe('token management', () => {
    it('encrypts tokens on create and they can be decrypted', async () => {
      const result = await service.createRegistry({
        name: 'Enc Test',
        orgName: 'enc-org',
        apiToken: 'my-super-secret-token-12345',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const db = getTestDb();
      const stored = await db.query.settings.findFirst({
        where: eq(settings.key, result.value.tokenSettingKey),
      });

      expect(stored).toBeDefined();
      // Raw value should NOT be the plaintext token
      expect(stored!.value).not.toBe('my-super-secret-token-12345');
      // But it should decrypt to the original
      expect(decryptToken(stored!.value)).toBe('my-super-secret-token-12345');
    });

    it('token setting key follows expected naming convention', async () => {
      const result = await service.createRegistry({
        name: 'Key Test',
        orgName: 'key-org',
        apiToken: 'sk-token',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.tokenSettingKey).toBe(`terraform.registry.${result.value.id}.apiToken`);
    });
  });
});
