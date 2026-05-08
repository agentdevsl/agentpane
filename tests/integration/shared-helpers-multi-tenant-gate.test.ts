/**
 * Integration tests for the multi-tenant gate in shared-helpers.
 *
 * Exercises the real `assertSharedSandboxAllowed` and `resolveSandboxMode`
 * helpers against a real SQLite database — the unit-project test for the
 * same helpers uses an inline mock db, which leaves the integration project
 * coverage at zero for these branches. Adding these as integration tests
 * brings the multi-tenant gate paths into the integration+functional
 * coverage report.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema';
import {
  assertSharedSandboxAllowed,
  resolveSandboxMode,
} from '../../src/services/container-agent/shared-helpers';
import { createTestTeam } from '../factories/team.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

async function setSandboxModeSetting(value: 'shared' | 'per-project' | 'malformed'): Promise<void> {
  const db = getTestDb();
  const raw =
    value === 'malformed' ? 'not-valid-json{' : JSON.stringify(value as 'shared' | 'per-project');
  // TEST-SETUP: settings infrastructure config — direct insert/update is the
  // canonical pattern (no service API to seed). Upsert to avoid UNIQUE clashes.
  try {
    await db.insert(settings).values({ key: 'sandbox.mode', value: raw });
  } catch {
    await db.update(settings).set({ value: raw }).where(eq(settings.key, 'sandbox.mode'));
  }
}

describe('shared-helpers multi-tenant gate (integration)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    const db = getTestDb();
    try {
      await db.delete(settings).where(eq(settings.key, 'sandbox.mode'));
    } catch {
      // safe to ignore
    }
    await clearTestDatabase();
  });

  describe('resolveSandboxMode', () => {
    it('returns "shared" when no sandbox.mode setting row exists', async () => {
      const db = getTestDb();
      const mode = await resolveSandboxMode(db);
      expect(mode).toBe('shared');
    });

    it('returns "per-project" when explicitly configured', async () => {
      await setSandboxModeSetting('per-project');
      const db = getTestDb();
      const mode = await resolveSandboxMode(db);
      expect(mode).toBe('per-project');
    });

    it('returns "shared" when explicitly configured', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      const mode = await resolveSandboxMode(db);
      expect(mode).toBe('shared');
    });

    it('returns "shared" when value is malformed JSON (safer default)', async () => {
      await setSandboxModeSetting('malformed');
      const db = getTestDb();
      const mode = await resolveSandboxMode(db);
      expect(mode).toBe('shared');
    });
  });

  describe('assertSharedSandboxAllowed — MULTI_TENANT=true env opt-in', () => {
    it('throws MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX when env=true and mode=shared', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      await expect(
        assertSharedSandboxAllowed(db, 'codespace-1', { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv)
      ).rejects.toMatchObject({ code: 'MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX' });
    });

    it('throws and attaches the codespaceId to error details', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      try {
        await assertSharedSandboxAllowed(db, 'codespace-with-details', {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv);
        throw new Error('expected gate to throw');
      } catch (caught) {
        const e = caught as { code?: string; details?: Record<string, unknown> };
        expect(e.code).toBe('MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX');
        expect(e.details).toMatchObject({ codespaceId: 'codespace-with-details' });
      }
    });

    it('does not throw when env=true and mode=per-project', async () => {
      await setSandboxModeSetting('per-project');
      const db = getTestDb();
      await expect(
        assertSharedSandboxAllowed(db, 'codespace-isolated', {
          MULTI_TENANT: 'true',
        } as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });

    it('throws when env=true and mode setting row is missing (defaults to shared)', async () => {
      const db = getTestDb();
      await expect(
        assertSharedSandboxAllowed(db, undefined, { MULTI_TENANT: 'true' } as NodeJS.ProcessEnv)
      ).rejects.toMatchObject({ code: 'MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX' });
    });
  });

  describe('assertSharedSandboxAllowed — implicit multi-tenant via DB rows', () => {
    it('skips gate when env unset and only one team exists', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      // No teams → single-tenant inference → no throw even on shared mode
      await expect(
        assertSharedSandboxAllowed(db, 'self-hosted', {} as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });

    it('throws when env unset but multiple teams exist (implicit multi-tenant)', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      await createTestTeam({ name: 'Team Alpha' });
      await createTestTeam({ name: 'Team Beta' });
      await expect(
        assertSharedSandboxAllowed(db, 'multi-team', {} as NodeJS.ProcessEnv)
      ).rejects.toMatchObject({ code: 'MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX' });
    });

    it('throws when env unset but multiple users exist (implicit multi-tenant)', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      await createTestUser({ githubLogin: 'alice' });
      await createTestUser({ githubLogin: 'bob' });
      await expect(
        assertSharedSandboxAllowed(db, 'multi-user', {} as NodeJS.ProcessEnv)
      ).rejects.toMatchObject({ code: 'MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX' });
    });

    it('does not throw when multiple users exist but mode is per-project', async () => {
      await setSandboxModeSetting('per-project');
      const db = getTestDb();
      await createTestUser({ githubLogin: 'alice' });
      await createTestUser({ githubLogin: 'bob' });
      await expect(
        assertSharedSandboxAllowed(db, undefined, {} as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });

    it('treats MULTI_TENANT="1" as not opting in (only "true" opts in)', async () => {
      await setSandboxModeSetting('shared');
      const db = getTestDb();
      await expect(
        assertSharedSandboxAllowed(db, 'self-hosted', { MULTI_TENANT: '1' } as NodeJS.ProcessEnv)
      ).resolves.toBeUndefined();
    });
  });
});
