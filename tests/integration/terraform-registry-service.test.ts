import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import { TerraformRegistryService } from '../../src/services/terraform-registry.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock external I/O: Terraform Registry HTTP API
// ---------------------------------------------------------------------------

vi.mock('../../src/lib/terraform/registry-client.js', () => ({
  syncAllModules: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TerraformRegistryService (IT-420 to IT-435)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: TerraformRegistryService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    try {
      execRawSql(TERRAFORM_MIGRATION_SQL);
    } catch {
      // Tables may already exist
    }
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    service = new TerraformRegistryService(db as any);
  });

  afterEach(async () => {
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // createRegistry
  // -------------------------------------------------------------------------

  describe('createRegistry (IT-420)', () => {
    it('IT-420a: creates registry with encrypted token in settings', async () => {
      const result = await service.createRegistry({
        name: 'My Registry',
        orgName: 'my-org',
        apiToken: 'test-api-token-123',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe('My Registry');
      expect(result.value.orgName).toBe('my-org');
      expect(result.value.status).toBe('active');

      // Verify token was stored encrypted in settings
      const tokenSetting = await db.query.settings.findFirst({
        where: eq(settings.key, result.value.tokenSettingKey),
      });
      expect(tokenSetting).toBeTruthy();
      // Encrypted token should NOT be the same as the plain token
      expect(tokenSetting!.value).not.toBe('test-api-token-123');
    });

    it('IT-420b: rejects duplicate orgName', async () => {
      await service.createRegistry({
        name: 'First',
        orgName: 'duplicate-org',
        apiToken: 'token-1',
      });

      const result = await service.createRegistry({
        name: 'Second',
        orgName: 'duplicate-org',
        apiToken: 'token-2',
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_REGISTRY_ALREADY_EXISTS');
    });

    it('IT-420c: sets syncIntervalMinutes and nextSyncAt when provided', async () => {
      const result = await service.createRegistry({
        name: 'Scheduled Registry',
        orgName: 'scheduled-org',
        apiToken: 'token',
        syncIntervalMinutes: 60,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.syncIntervalMinutes).toBe(60);
      expect(result.value.nextSyncAt).toBeTruthy();

      // nextSyncAt should be approximately 60 minutes from now
      const nextSync = new Date(result.value.nextSyncAt!).getTime();
      const now = Date.now();
      expect(nextSync).toBeGreaterThan(now);
      expect(nextSync).toBeLessThan(now + 61 * 60 * 1000);
    });

    it('IT-420d: sets nextSyncAt to null when no sync interval', async () => {
      const result = await service.createRegistry({
        name: 'No Sync',
        orgName: 'no-sync-org',
        apiToken: 'token',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.syncIntervalMinutes).toBeNull();
      expect(result.value.nextSyncAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getRegistryById
  // -------------------------------------------------------------------------

  describe('getRegistryById (IT-421)', () => {
    it('IT-421a: returns registry by ID', async () => {
      const createResult = await service.createRegistry({
        name: 'Fetch Me',
        orgName: 'fetch-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const getResult = await service.getRegistryById(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.name).toBe('Fetch Me');
      expect(getResult.value.orgName).toBe('fetch-org');
    });

    it('IT-421b: returns REGISTRY_NOT_FOUND for nonexistent ID', async () => {
      const result = await service.getRegistryById('nonexistent-id');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // listRegistries
  // -------------------------------------------------------------------------

  describe('listRegistries (IT-422)', () => {
    it('IT-422a: returns empty array when no registries', async () => {
      const result = await service.listRegistries();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('IT-422b: returns all registries ordered by updatedAt', async () => {
      await service.createRegistry({ name: 'First', orgName: 'org-1', apiToken: 't1' });
      await service.createRegistry({ name: 'Second', orgName: 'org-2', apiToken: 't2' });
      await service.createRegistry({ name: 'Third', orgName: 'org-3', apiToken: 't3' });

      const result = await service.listRegistries();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // updateRegistry
  // -------------------------------------------------------------------------

  describe('updateRegistry (IT-423)', () => {
    it('IT-423a: updates registry name', async () => {
      const createResult = await service.createRegistry({
        name: 'Old Name',
        orgName: 'update-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        name: 'New Name',
      });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value.name).toBe('New Name');
      expect(updateResult.value.orgName).toBe('update-org'); // unchanged
    });

    it('IT-423b: updates orgName', async () => {
      const createResult = await service.createRegistry({
        name: 'Registry',
        orgName: 'old-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        orgName: 'new-org',
      });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value.orgName).toBe('new-org');
    });

    it('IT-423c: updates API token in settings', async () => {
      const createResult = await service.createRegistry({
        name: 'Token Update',
        orgName: 'token-org',
        apiToken: 'original-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const tokenKey = createResult.value.tokenSettingKey;
      const originalSetting = await db.query.settings.findFirst({
        where: eq(settings.key, tokenKey),
      });

      const updateResult = await service.updateRegistry(createResult.value.id, {
        apiToken: 'new-api-token',
      });
      expect(updateResult.ok).toBe(true);

      // Token should have changed
      const updatedSetting = await db.query.settings.findFirst({
        where: eq(settings.key, tokenKey),
      });
      expect(updatedSetting).toBeTruthy();
      expect(updatedSetting!.value).not.toBe(originalSetting!.value);
    });

    it('IT-423d: updates syncIntervalMinutes and recalculates nextSyncAt', async () => {
      const createResult = await service.createRegistry({
        name: 'Sync Update',
        orgName: 'sync-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        syncIntervalMinutes: 30,
      });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value.syncIntervalMinutes).toBe(30);
      expect(updateResult.value.nextSyncAt).toBeTruthy();
    });

    it('IT-423e: clears nextSyncAt when syncIntervalMinutes set to null', async () => {
      const createResult = await service.createRegistry({
        name: 'Clear Sync',
        orgName: 'clear-org',
        apiToken: 'token',
        syncIntervalMinutes: 60,
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = await service.updateRegistry(createResult.value.id, {
        syncIntervalMinutes: null,
      });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value.syncIntervalMinutes).toBeNull();
      expect(updateResult.value.nextSyncAt).toBeNull();
    });

    it('IT-423f: returns REGISTRY_NOT_FOUND for nonexistent ID', async () => {
      const result = await service.updateRegistry('nonexistent', { name: 'Test' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // deleteRegistry
  // -------------------------------------------------------------------------

  describe('deleteRegistry (IT-424)', () => {
    it('IT-424a: deletes registry, its modules, and token setting', async () => {
      const createResult = await service.createRegistry({
        name: 'To Delete',
        orgName: 'delete-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const registryId = createResult.value.id;
      const tokenKey = createResult.value.tokenSettingKey;

      // Add some modules
      await db.insert(terraformModules).values({
        id: createId(),
        registryId,
        name: 'mod-to-delete',
        namespace: 'ns',
        provider: 'aws',
        version: '1.0.0',
        source: 'ns/mod/aws',
      });

      const deleteResult = await service.deleteRegistry(registryId);
      expect(deleteResult.ok).toBe(true);

      // Registry should be gone
      const getResult = await service.getRegistryById(registryId);
      expect(getResult.ok).toBe(false);

      // Modules should be gone
      const modules = await db.query.terraformModules.findMany({
        where: eq(terraformModules.registryId, registryId),
      });
      expect(modules).toHaveLength(0);

      // Token setting should be gone
      const token = await db.query.settings.findFirst({
        where: eq(settings.key, tokenKey),
      });
      expect(token).toBeUndefined();
    });

    it('IT-424b: returns REGISTRY_NOT_FOUND for nonexistent ID', async () => {
      const result = await service.deleteRegistry('nonexistent');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  describe('sync (IT-425)', () => {
    it('IT-425a: returns REGISTRY_NOT_FOUND for nonexistent registry', async () => {
      const result = await service.sync('nonexistent');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
    });

    it('IT-425b: returns INVALID_TOKEN when token setting is missing', async () => {
      // Create registry but manually delete the token setting
      const createResult = await service.createRegistry({
        name: 'No Token',
        orgName: 'no-token-org',
        apiToken: 'temp-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await db.delete(settings).where(eq(settings.key, createResult.value.tokenSettingKey));

      const syncResult = await service.sync(createResult.value.id);
      expect(syncResult.ok).toBe(false);
      if (syncResult.ok) return;
      expect(syncResult.error.code).toBe('TERRAFORM_INVALID_TOKEN');

      // Verify registry status was set to 'error'
      const registry = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, createResult.value.id),
      });
      expect(registry!.status).toBe('error');
    });

    it('IT-425c: marks registry as syncing during sync', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      // Make the mock return modules after a brief delay
      (syncAllModules as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // Check registry status during sync
        const reg = await db.query.terraformRegistries.findFirst({
          where: eq(terraformRegistries.orgName, 'syncing-org'),
        });
        expect(reg!.status).toBe('syncing');
        return [
          {
            id: createId(),
            name: 'synced-module',
            namespace: 'test',
            provider: 'aws',
            version: '1.0.0',
            source: 'test/synced-module/aws',
            description: 'A synced module',
            inputs: [],
            outputs: [],
            dependencies: [],
          },
        ];
      });

      const createResult = await service.createRegistry({
        name: 'Syncing',
        orgName: 'syncing-org',
        apiToken: 'valid-token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const syncResult = await service.sync(createResult.value.id);
      expect(syncResult.ok).toBe(true);
      if (!syncResult.ok) return;

      expect(syncResult.value.moduleCount).toBe(1);

      // After sync, status should be 'active'
      const registry = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, createResult.value.id),
      });
      expect(registry!.status).toBe('active');
      expect(registry!.moduleCount).toBe(1);
    });

    it('IT-425d: returns NO_MODULES_SYNCED when registry has no modules', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      (syncAllModules as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const createResult = await service.createRegistry({
        name: 'Empty',
        orgName: 'empty-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const syncResult = await service.sync(createResult.value.id);
      expect(syncResult.ok).toBe(false);
      if (syncResult.ok) return;
      expect(syncResult.error.code).toBe('TERRAFORM_NO_MODULES_SYNCED');
    });

    it('IT-425e: replaces existing modules on re-sync', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');

      const createResult = await service.createRegistry({
        name: 'Replace',
        orgName: 'replace-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const regId = createResult.value.id;

      // First sync: 2 modules
      (syncAllModules as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: createId(),
          name: 'module-a',
          namespace: 'ns',
          provider: 'aws',
          version: '1.0.0',
          source: 'ns/module-a/aws',
        },
        {
          id: createId(),
          name: 'module-b',
          namespace: 'ns',
          provider: 'aws',
          version: '1.0.0',
          source: 'ns/module-b/aws',
        },
      ]);

      await service.sync(regId);
      let modules = await db.query.terraformModules.findMany({
        where: eq(terraformModules.registryId, regId),
      });
      expect(modules).toHaveLength(2);

      // Second sync: 1 module (replaces old)
      (syncAllModules as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: createId(),
          name: 'module-c',
          namespace: 'ns',
          provider: 'aws',
          version: '2.0.0',
          source: 'ns/module-c/aws',
        },
      ]);

      await service.sync(regId);
      modules = await db.query.terraformModules.findMany({
        where: eq(terraformModules.registryId, regId),
      });
      expect(modules).toHaveLength(1);
      expect(modules[0]!.name).toBe('module-c');
    });

    it('IT-425f: sets error status and safe message on sync failure', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      (syncAllModules as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error: connection refused')
      );

      const createResult = await service.createRegistry({
        name: 'Fail',
        orgName: 'fail-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const syncResult = await service.sync(createResult.value.id);
      expect(syncResult.ok).toBe(false);

      const registry = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, createResult.value.id),
      });
      expect(registry!.status).toBe('error');
      expect(registry!.syncError).toContain('Network error');
    });

    it('IT-425g: scrubs credential-containing error messages', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      (syncAllModules as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('401 Unauthorized: Bearer token is invalid')
      );

      const createResult = await service.createRegistry({
        name: 'Cred Fail',
        orgName: 'cred-org',
        apiToken: 'token',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await service.sync(createResult.value.id);

      const registry = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, createResult.value.id),
      });
      // Error message should be sanitized — no Bearer token reference
      expect(registry!.syncError).toBe(
        'Sync failed due to an API error. Check your token and try again.'
      );
    });
  });

  // -------------------------------------------------------------------------
  // listModules
  // -------------------------------------------------------------------------

  describe('listModules (IT-426)', () => {
    it('IT-426a: returns empty array when no modules', async () => {
      const result = await service.listModules();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('IT-426b: filters by registryId', async () => {
      const reg1 = await insertRegistry('org-1');
      const reg2 = await insertRegistry('org-2');
      await insertModule(reg1.id, 'mod-a');
      await insertModule(reg1.id, 'mod-b');
      await insertModule(reg2.id, 'mod-c');

      const result = await service.listModules({ registryId: reg1.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it('IT-426c: filters by provider', async () => {
      const reg = await insertRegistry('prov-org');
      await insertModule(reg.id, 'vpc', 'aws');
      await insertModule(reg.id, 'vnet', 'azure');

      const result = await service.listModules({ provider: 'aws' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.name).toBe('vpc');
    });

    it('IT-426d: searches by name', async () => {
      const reg = await insertRegistry('search-org');
      await insertModule(reg.id, 'networking-vpc');
      await insertModule(reg.id, 'compute-instance');

      const result = await service.listModules({ search: 'networking' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.name).toBe('networking-vpc');
    });

    it('IT-426e: respects limit and offset', async () => {
      const reg = await insertRegistry('page-org');
      for (let i = 0; i < 5; i++) {
        await insertModule(reg.id, `mod-${i}`);
      }

      const page1 = await service.listModules({ limit: 2, offset: 0 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.value).toHaveLength(2);

      const page2 = await service.listModules({ limit: 2, offset: 2 });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.value).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getModuleById
  // -------------------------------------------------------------------------

  describe('getModuleById (IT-427)', () => {
    it('IT-427a: returns module by ID', async () => {
      const reg = await insertRegistry('get-org');
      const mod = await insertModule(reg.id, 'target-module');

      const result = await service.getModuleById(mod.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('target-module');
    });

    it('IT-427b: returns MODULE_NOT_FOUND for nonexistent ID', async () => {
      const result = await service.getModuleById('nonexistent');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_MODULE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // getModuleContext
  // -------------------------------------------------------------------------

  describe('getModuleContext (IT-428)', () => {
    it('IT-428a: formats module context with inputs and outputs', async () => {
      const reg = await insertRegistry('context-org');
      await db.insert(terraformModules).values({
        id: createId(),
        registryId: reg.id,
        name: 'vpc',
        namespace: 'hashicorp',
        provider: 'aws',
        version: '5.0.0',
        source: 'hashicorp/vpc/aws',
        description: 'AWS VPC module',
        inputs: [
          { name: 'cidr_block', type: 'string', required: true, description: 'CIDR block' },
          { name: 'enable_dns', type: 'bool', required: false, default: true },
        ],
        outputs: [{ name: 'vpc_id', description: 'The VPC ID' }],
        dependencies: ['aws_subnet'],
      });

      const result = await service.getModuleContext(reg.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toContain('hashicorp/vpc/aws');
      expect(result.value).toContain('cidr_block');
      expect(result.value).toContain('(required)');
      expect(result.value).toContain('vpc_id');
      expect(result.value).toContain('Dependencies: aws_subnet');
      expect(result.value).toContain('AWS VPC module');
    });

    it('IT-428b: returns placeholder when no modules found', async () => {
      const result = await service.getModuleContext('nonexistent');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe('No Terraform modules available.');
    });

    it('IT-428c: returns all modules when no registryId filter', async () => {
      const reg1 = await insertRegistry('ctx-org-1');
      const reg2 = await insertRegistry('ctx-org-2');
      await insertModule(reg1.id, 'mod-from-1');
      await insertModule(reg2.id, 'mod-from-2');

      const result = await service.getModuleContext();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toContain('mod-from-1');
      expect(result.value).toContain('mod-from-2');
    });
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function insertRegistry(orgName: string) {
    const id = createId();
    const [reg] = await db
      .insert(terraformRegistries)
      .values({
        id,
        name: `Registry for ${orgName}`,
        orgName,
        tokenSettingKey: `terraform.registry.${id}.apiToken`,
        status: 'active',
        moduleCount: 0,
      })
      .returning();
    return reg!;
  }

  async function insertModule(registryId: string, name: string, provider = 'aws') {
    const [mod] = await db
      .insert(terraformModules)
      .values({
        id: createId(),
        registryId,
        name,
        namespace: 'test',
        provider,
        version: '1.0.0',
        source: `test/${name}/${provider}`,
        description: `Module ${name}`,
      })
      .returning();
    return mod!;
  }
});
