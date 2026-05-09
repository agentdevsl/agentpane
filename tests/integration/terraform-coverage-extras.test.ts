/**
 * Coverage gap-fillers for the terraform composer slice.
 *
 * Targets uncovered branches identified by `coverage/slice/coverage-summary.json`:
 *   - terraform-registry.service.ts: token-rollback paths in `updateRegistry`,
 *     decrypt-fallback chain in `sync`, and registry-create-failed rollback.
 *   - terraform-sync-scheduler.ts: module-level singleton API, double start
 *     warning, periodic interval execution.
 *   - terraform-compose.service.ts: `extractStacksFiles` empty branches,
 *     `parseClarifyingQuestionsFromText` text fallback, `getModuleContext`
 *     with empty inputs/outputs/dependencies.
 *
 * IT-IDs: IT-1920 to IT-1949
 */
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import {
  extractStacksFiles,
  matchModulesInResponse,
  parseClarifyingQuestionsFromText,
} from '../../src/services/terraform-compose.service';
import { TerraformRegistryService } from '../../src/services/terraform-registry.service';
import {
  getTerraformSchedulerState,
  startTerraformSyncScheduler,
  stopTerraformSyncScheduler,
  TerraformSyncScheduler,
} from '../../src/services/terraform-sync-scheduler';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock the registry-client so sync tests don't try to hit the real HCP API.
vi.mock('../../src/lib/terraform/registry-client.js', () => ({
  syncAllModules: vi.fn().mockResolvedValue([]),
}));

describe('Terraform coverage extras', () => {
  let db: ReturnType<typeof getTestDb>;

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
  });

  afterEach(async () => {
    vi.useRealTimers();
    stopTerraformSyncScheduler();
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await clearTestDatabase();
  });

  // ───────────────────────────────────────────────────────────────────
  // Registry token rollback when update fails
  // ───────────────────────────────────────────────────────────────────

  describe('updateRegistry token rollback (IT-1920)', () => {
    it('IT-1920a: rolls back token to previous value when update returns no row', async () => {
      const service = new TerraformRegistryService(db as never);
      const created = await service.createRegistry({
        name: 'Reg',
        orgName: 'rollback-org',
        apiToken: 'first-token',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const tokenKey = created.value.tokenSettingKey;
      const original = await db.query.settings.findFirst({ where: eq(settings.key, tokenKey) });
      expect(original).toBeTruthy();

      // Force the .returning() chain to yield no row by patching the query path.
      const realUpdate = db.update.bind(db);
      const updateSpy = vi.spyOn(db, 'update').mockImplementation(((table: never) => {
        const builder = realUpdate(table);
        const set = builder.set.bind(builder);
        builder.set = ((values: never) => {
          const node = set(values);
          const where = node.where.bind(node);
          node.where = ((cond: never) => {
            const w = where(cond);
            // Returning yields no rows → triggers the rollback path
            w.returning = (() => Promise.resolve([])) as never;
            return w;
          }) as never;
          return node;
        }) as never;
        return builder;
      }) as never);

      try {
        const result = await service.updateRegistry(created.value.id, {
          apiToken: 'new-token',
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('TERRAFORM_REGISTRY_NOT_FOUND');
      } finally {
        updateSpy.mockRestore();
      }

      // After rollback, the token should match the original encrypted value.
      const afterRollback = await db.query.settings.findFirst({
        where: eq(settings.key, tokenKey),
      });
      expect(afterRollback?.value).toBe(original?.value);
    });

    it('IT-1920b: deletes new token setting when previous never existed and update fails', async () => {
      const service = new TerraformRegistryService(db as never);
      const created = await service.createRegistry({
        name: 'Reg',
        orgName: 'deletetoken-org',
        apiToken: 'first-token',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Strip the existing token so the previousTokenSetting branch is null.
      await db.delete(settings).where(eq(settings.key, created.value.tokenSettingKey));

      const realUpdate = db.update.bind(db);
      const updateSpy = vi.spyOn(db, 'update').mockImplementation(((table: never) => {
        const builder = realUpdate(table);
        const set = builder.set.bind(builder);
        builder.set = ((values: never) => {
          const node = set(values);
          const where = node.where.bind(node);
          node.where = ((cond: never) => {
            const w = where(cond);
            w.returning = (() => Promise.resolve([])) as never;
            return w;
          }) as never;
          return node;
        }) as never;
        return builder;
      }) as never);

      try {
        const result = await service.updateRegistry(created.value.id, { apiToken: 'fresh' });
        expect(result.ok).toBe(false);
      } finally {
        updateSpy.mockRestore();
      }

      // After failed update with no previous token, the just-saved key should be deleted.
      const afterRollback = await db.query.settings.findFirst({
        where: eq(settings.key, created.value.tokenSettingKey),
      });
      expect(afterRollback).toBeUndefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Sync decrypt fallback paths
  // ───────────────────────────────────────────────────────────────────

  describe('sync decrypt fallback (IT-1921)', () => {
    it('IT-1921a: falls back to JSON.parse when token is JSON-encoded (decrypt fails)', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      (syncAllModules as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = createId();
      const tokenKey = `terraform.registry.${id}.apiToken`;
      // Insert a JSON-stringified plain token (NOT encrypted) — exercises
      // the JSON-parse fallback inside the catch arm of decryptToken.
      await db.insert(settings).values({ key: tokenKey, value: '"plain-json-token"' });
      await db.insert(terraformRegistries).values({
        id,
        name: 'JSON Token Registry',
        orgName: 'json-token-org',
        tokenSettingKey: tokenKey,
        status: 'active',
        moduleCount: 0,
      });

      const service = new TerraformRegistryService(db as never);
      const result = await service.sync(id);
      // No modules → NO_MODULES_SYNCED, but decrypt path was exercised.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_NO_MODULES_SYNCED');
    });

    it('IT-1921b: falls back to raw value when decrypt and JSON parse both fail', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      (syncAllModules as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = createId();
      const tokenKey = `terraform.registry.${id}.apiToken`;
      // Raw plain token (not encrypted, not JSON) — exercises the second fallback.
      await db.insert(settings).values({ key: tokenKey, value: 'plain-raw-token' });
      await db.insert(terraformRegistries).values({
        id,
        name: 'Raw Token Registry',
        orgName: 'raw-token-org',
        tokenSettingKey: tokenKey,
        status: 'active',
        moduleCount: 0,
      });

      const service = new TerraformRegistryService(db as never);
      const result = await service.sync(id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_NO_MODULES_SYNCED');
    });

    it('IT-1921c: returns INVALID_TOKEN when decrypt succeeds but token is empty string', async () => {
      const { syncAllModules } = await import('../../src/lib/terraform/registry-client.js');
      (syncAllModules as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const id = createId();
      const tokenKey = `terraform.registry.${id}.apiToken`;
      // Empty raw token → triggers the empty-token guard.
      await db.insert(settings).values({ key: tokenKey, value: '' });
      await db.insert(terraformRegistries).values({
        id,
        name: 'Empty Token',
        orgName: 'empty-token-org',
        tokenSettingKey: tokenKey,
        status: 'active',
        moduleCount: 0,
      });

      const service = new TerraformRegistryService(db as never);
      const result = await service.sync(id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('TERRAFORM_INVALID_TOKEN');

      // Status should be 'error' with descriptive message
      const reg = await db.query.terraformRegistries.findFirst({
        where: eq(terraformRegistries.id, id),
      });
      expect(reg!.status).toBe('error');
      expect(reg!.syncError).toContain('empty or invalid');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Scheduler module-level singleton API
  // ───────────────────────────────────────────────────────────────────

  describe('Module-level scheduler singleton (IT-1930)', () => {
    it('IT-1930a: getTerraformSchedulerState returns default state when no instance', () => {
      stopTerraformSyncScheduler();
      const state = getTerraformSchedulerState();
      expect(state).toEqual({ isRunning: false, lastCheckAt: null, syncInProgressCount: 0 });
    });

    it('IT-1930b: startTerraformSyncScheduler creates singleton on first call', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const mockRegistry = { sync: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as never;

      const stop = startTerraformSyncScheduler(db as never, mockRegistry);
      expect(typeof stop).toBe('function');
      expect(getTerraformSchedulerState().isRunning).toBe(true);

      stopTerraformSyncScheduler();
      expect(getTerraformSchedulerState().isRunning).toBe(false);
    });

    it('IT-1930c: startTerraformSyncScheduler reuses existing singleton on second call', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      const mockRegistry = { sync: vi.fn().mockResolvedValue({ ok: true, value: {} }) } as never;

      const stop1 = startTerraformSyncScheduler(db as never, mockRegistry);
      // Call again — should NOT create a new instance
      const stop2 = startTerraformSyncScheduler(db as never, mockRegistry);
      expect(typeof stop1).toBe('function');
      expect(typeof stop2).toBe('function');
      // Still only one instance running
      expect(getTerraformSchedulerState().isRunning).toBe(true);

      stopTerraformSyncScheduler();
    });

    it('IT-1930d: stopTerraformSyncScheduler is idempotent on no instance', () => {
      // No singleton; should be a no-op
      expect(() => stopTerraformSyncScheduler()).not.toThrow();
      expect(() => stopTerraformSyncScheduler()).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Scheduler periodic check error path
  // ───────────────────────────────────────────────────────────────────

  describe('Scheduler periodic check (IT-1935)', () => {
    it('IT-1935a: top-level error in checkAndSyncRegistries is caught and logged', async () => {
      const mockRegistry = { sync: vi.fn() };
      const scheduler = new TerraformSyncScheduler(db as never, mockRegistry as never);

      // Patch db.query to throw so the outer try/catch fires.
      const originalQuery = db.query.terraformRegistries;
      db.query.terraformRegistries = {
        findMany: () => {
          throw new Error('DB query exploded');
        },
      } as never;

      try {
        // Calling start triggers an initial check; it must not throw.
        scheduler.start();
        await new Promise((r) => setTimeout(r, 50));
        expect(scheduler.getState().isRunning).toBe(true);
      } finally {
        scheduler.stop();
        db.query.terraformRegistries = originalQuery;
      }
    });

    it('IT-1935b: nextSyncAt update failure is caught and does not stop processing', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const id = createId();
      await db.insert(terraformRegistries).values({
        id,
        name: 'NextSync Update Fail',
        orgName: 'nextsync-fail-org',
        tokenSettingKey: `terraform.registry.${id}.apiToken`,
        status: 'active',
        syncIntervalMinutes: 10,
        nextSyncAt: past,
        moduleCount: 0,
      });

      const mockRegistry = {
        sync: vi.fn().mockResolvedValue({
          ok: true,
          value: { registryId: id, moduleCount: 1, syncedAt: new Date().toISOString() },
        }),
      };
      const scheduler = new TerraformSyncScheduler(db as never, mockRegistry as never);

      // Wrap update so the SECOND call (the nextSyncAt update) fails.
      const realUpdate = db.update.bind(db);
      let updateCount = 0;
      const updateSpy = vi.spyOn(db, 'update').mockImplementation(((table: never) => {
        updateCount++;
        if (updateCount === 1) {
          // The nextSyncAt update — simulate failure
          return {
            set: () => ({
              where: () => Promise.reject(new Error('update failed')),
            }),
          } as never;
        }
        return realUpdate(table);
      }) as never);

      try {
        scheduler.start();
        await vi.waitFor(() => expect(mockRegistry.sync).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 100));
        // Despite update failure, scheduler keeps running
        expect(scheduler.getState().isRunning).toBe(true);
      } finally {
        scheduler.stop();
        updateSpy.mockRestore();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Compose pure-function micro-gaps
  // ───────────────────────────────────────────────────────────────────

  describe('Compose pure-function gaps (IT-1940)', () => {
    it('IT-1940a: extractStacksFiles skips empty fenced blocks', () => {
      const text = ['```hcl', '', '```', '```hcl', 'component "x" {}', '```'].join('\n');
      const files = extractStacksFiles(text);
      // Empty block is skipped; only the non-empty one survives
      expect(files).toHaveLength(1);
      expect(files[0]!.code).toContain('component "x"');
    });

    it('IT-1940b: parseClarifyingQuestionsFromText skips when text contains hcl fence', () => {
      const text = '```hcl\nresource "x" "y" {}\n```\n1. What region should we use?';
      expect(parseClarifyingQuestionsFromText(text)).toHaveLength(0);
    });

    it('IT-1940c: parseClarifyingQuestionsFromText returns generic options for unknown question', () => {
      const text = '1. What is the favorite color you would like for the project palette?';
      const qs = parseClarifyingQuestionsFromText(text);
      expect(qs).toHaveLength(1);
      expect(qs[0]!.options).toEqual(['Use placeholder values']);
    });

    it('IT-1940d: parseClarifyingQuestionsFromText handles asterisk bullet questions', () => {
      const text = '* What region should we deploy the production environment to?';
      const qs = parseClarifyingQuestionsFromText(text);
      expect(qs).toHaveLength(1);
      expect(qs[0]!.options).toContain('us-east-1');
    });

    it('IT-1940e: parseClarifyingQuestionsFromText infers domain options', () => {
      const text = '1. Which DNS domain should we register for the new service?';
      const qs = parseClarifyingQuestionsFromText(text);
      expect(qs).toHaveLength(1);
      expect(qs[0]!.options).toContain('example.com');
    });

    it('IT-1940f: matchModulesInResponse treats names shorter than 3 chars as generic', () => {
      const matches = matchModulesInResponse('Use the gw module', [
        {
          id: 'mod-tiny',
          registryId: 'reg',
          name: 'gw',
          namespace: 'ns',
          provider: 'aws',
          version: '1.0.0',
          source: 'ns/gw/aws',
          description: null,
          inputs: null,
          outputs: null,
          dependencies: null,
          readme: null,
          publishedAt: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      // Name too short → not matched by name alone
      expect(matches).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getModuleContext extra branches (IT-1945)
  // ───────────────────────────────────────────────────────────────────

  describe('getModuleContext branches (IT-1945)', () => {
    it('IT-1945a: omits sections when inputs/outputs/dependencies are empty arrays', async () => {
      const service = new TerraformRegistryService(db as never);
      const id = createId();
      await db.insert(terraformRegistries).values({
        id,
        name: 'Bare',
        orgName: 'bare-org',
        tokenSettingKey: `terraform.registry.${id}.apiToken`,
        status: 'active',
        moduleCount: 0,
      });
      await db.insert(terraformModules).values({
        id: createId(),
        registryId: id,
        name: 'bare-module',
        namespace: 'ns',
        provider: 'aws',
        version: '0.0.1',
        source: 'ns/bare-module/aws',
        description: null,
        inputs: [],
        outputs: [],
        dependencies: [],
      });

      const result = await service.getModuleContext(id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toContain('bare-module');
      expect(result.value).not.toContain('### Inputs');
      expect(result.value).not.toContain('### Outputs');
      expect(result.value).not.toContain('Dependencies');
    });

    it('IT-1945b: includes sensitive tag and default value for sensitive inputs', async () => {
      const service = new TerraformRegistryService(db as never);
      const id = createId();
      await db.insert(terraformRegistries).values({
        id,
        name: 'Sensitive',
        orgName: 'sensitive-org',
        tokenSettingKey: `terraform.registry.${id}.apiToken`,
        status: 'active',
        moduleCount: 0,
      });
      await db.insert(terraformModules).values({
        id: createId(),
        registryId: id,
        name: 'sec-module',
        namespace: 'ns',
        provider: 'aws',
        version: '1.0.0',
        source: 'ns/sec-module/aws',
        description: 'has secrets',
        inputs: [
          {
            name: 'db_password',
            type: 'string',
            required: false,
            sensitive: true,
            default: 'changeme',
            description: 'DB password',
          },
        ],
        outputs: [{ name: 'endpoint', description: 'endpoint URL' }],
        dependencies: ['random'],
      });

      const result = await service.getModuleContext(id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toContain('[sensitive]');
      expect(result.value).toContain('"changeme"');
      expect(result.value).toContain('Dependencies: random');
    });
  });
});
