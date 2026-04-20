/**
 * F01-01 — Sandbox reconciliation phase.
 *
 * On startup, the reconciliation phase cross-references live provider state
 * against the `sandbox_instances` DB table:
 *   - Orphan DB row (DB says running, provider has no such sandbox) →
 *     marked `stopped` with an error message.
 *   - Orphan provider sandbox (live but no DB row) → inserted into DB.
 *
 * Uses a mock provider so the test has no real Docker/K8s/Nomad dependency.
 */

import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxInstances } from '../../src/db/schema';
import type { SandboxProvider } from '../../src/lib/sandbox/providers/sandbox-provider.js';
import type { SandboxConfig, SandboxInfo } from '../../src/lib/sandbox/types.js';
import { reconcileSandboxes } from '../../src/server/bootstrap/phases/sandbox-reconciliation.js';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * The in-memory test DB runs only a subset of migrations; the
 * `sandbox_instances` table is not part of that set. Create it on demand
 * with the shape the Drizzle schema expects. Matches the production
 * 0000_clever_red_skull migration but relaxes FKs (the helper runs with
 * `foreign_keys = OFF` anyway) and uses the `codespace_id` column
 * directly — there's no `project_id` legacy column needed here because
 * the column is created fresh, not ALTERed from an existing table.
 */
function ensureSandboxInstancesTable(): void {
  execRawSql(`
    CREATE TABLE IF NOT EXISTS sandbox_instances (
      id TEXT PRIMARY KEY NOT NULL,
      codespace_id TEXT NOT NULL,
      container_id TEXT NOT NULL,
      status TEXT DEFAULT 'stopped' NOT NULL,
      image TEXT NOT NULL,
      memory_mb INTEGER NOT NULL,
      cpu_cores INTEGER NOT NULL,
      idle_timeout_minutes INTEGER NOT NULL,
      volume_mounts TEXT DEFAULT '[]',
      env TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')) NOT NULL,
      last_activity_at TEXT DEFAULT (datetime('now')) NOT NULL,
      stopped_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);
}

/**
 * Minimal stand-in for the provider — only list() and name are used by the
 * reconciliation phase. The rest throw so any accidental dependency on them
 * surfaces immediately.
 */
function createMockProvider(list: SandboxInfo[]): SandboxProvider {
  return {
    name: 'mock',
    list: async () => list,
    // Every other method is unused in this path; fail loudly if the code
    // under test ever reaches for one.
    create: async (_config: SandboxConfig) => {
      throw new Error('mock create() should not be called');
    },
    get: async () => null,
    getById: async () => null,
    pullImage: async () => {
      throw new Error('mock pullImage() should not be called');
    },
    isImageAvailable: async () => false,
    healthCheck: async () => ({ healthy: true }),
    cleanup: async () => 0,
  };
}

function liveInfo(overrides: Partial<SandboxInfo>): SandboxInfo {
  return {
    id: overrides.id ?? 'sb-live',
    codespaceId: overrides.codespaceId ?? 'codespace-x',
    containerId: overrides.containerId ?? 'container-x',
    status: overrides.status ?? 'running',
    image: overrides.image ?? 'srlynch1/agent-sandbox:latest',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActivityAt: overrides.lastActivityAt ?? new Date().toISOString(),
    memoryMb: overrides.memoryMb ?? 8192,
    cpuCores: overrides.cpuCores ?? 4,
  };
}

describe('F01-01: Sandbox reconciliation phase', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    ensureSandboxInstancesTable();
  });

  afterEach(async () => {
    // Clear sandbox_instances first (not covered by the shared clearTestDatabase).
    try {
      execRawSql('DELETE FROM sandbox_instances');
    } catch {
      // table may not exist in some rollback states — safe to ignore
    }
    await clearTestDatabase();
  });

  it('marks an orphan DB row (running in DB, missing from provider) as stopped', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    // DB row says the sandbox is running, but the provider returns an empty list.
    const orphanId = 'sb-orphan';
    await db.insert(sandboxInstances).values({
      id: orphanId,
      codespaceId: codespace.id,
      containerId: 'container-orphan',
      status: 'running',
      image: 'srlynch1/agent-sandbox:latest',
      memoryMb: 8192,
      cpuCores: 4,
      idleTimeoutMinutes: 30,
    });

    const provider = createMockProvider([]);
    const report = await reconcileSandboxes(db as never, { provider: null }, undefined, provider);

    expect(report.terminatedCount).toBe(1);
    expect(report.terminated).toContain(orphanId);

    const [row] = await db.select().from(sandboxInstances).where(eq(sandboxInstances.id, orphanId));
    expect(row?.status).toBe('stopped');
    expect(row?.errorMessage).toContain('reconciliation');
    expect(row?.stoppedAt).toBeTruthy();
  });

  it('adopts an orphan provider sandbox (live but no DB row) into the DB', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    const liveId = 'sb-live-adopt';
    const provider = createMockProvider([
      liveInfo({ id: liveId, codespaceId: codespace.id, containerId: 'cnt-adopt' }),
    ]);

    const report = await reconcileSandboxes(db as never, { provider: null }, undefined, provider);

    expect(report.adoptedCount).toBe(1);
    expect(report.adopted).toContain(liveId);

    const [row] = await db.select().from(sandboxInstances).where(eq(sandboxInstances.id, liveId));
    expect(row?.codespaceId).toBe(codespace.id);
    expect(row?.containerId).toBe('cnt-adopt');
    expect(row?.status).toBe('running');
  });

  it('leaves matching rows untouched (no false adopt, no false terminate)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    const matchedId = 'sb-match';
    await db.insert(sandboxInstances).values({
      id: matchedId,
      codespaceId: codespace.id,
      containerId: 'cnt-match',
      status: 'running',
      image: 'srlynch1/agent-sandbox:latest',
      memoryMb: 8192,
      cpuCores: 4,
      idleTimeoutMinutes: 30,
    });

    const provider = createMockProvider([
      liveInfo({ id: matchedId, codespaceId: codespace.id, containerId: 'cnt-match' }),
    ]);

    const report = await reconcileSandboxes(db as never, { provider: null }, undefined, provider);

    expect(report.adoptedCount).toBe(0);
    expect(report.terminatedCount).toBe(0);

    const [row] = await db
      .select()
      .from(sandboxInstances)
      .where(eq(sandboxInstances.id, matchedId));
    expect(row?.status).toBe('running');
    expect(row?.stoppedAt).toBeNull();
  });

  it('does not touch DB rows already in a terminal status', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    const historicalId = 'sb-historical';
    await db.insert(sandboxInstances).values({
      id: historicalId,
      codespaceId: codespace.id,
      containerId: 'cnt-hist',
      status: 'stopped',
      image: 'srlynch1/agent-sandbox:latest',
      memoryMb: 8192,
      cpuCores: 4,
      idleTimeoutMinutes: 30,
      errorMessage: 'stopped by user',
    });

    const provider = createMockProvider([]);
    const report = await reconcileSandboxes(db as never, { provider: null }, undefined, provider);

    expect(report.terminatedCount).toBe(0);

    const [row] = await db
      .select()
      .from(sandboxInstances)
      .where(eq(sandboxInstances.id, historicalId));
    // Historical row should be preserved verbatim — reconciliation must not
    // overwrite a user-supplied stop reason.
    expect(row?.errorMessage).toBe('stopped by user');
  });

  it('is a no-op when the provider is null', async () => {
    const db = getTestDb();
    const report = await reconcileSandboxes(db as never, { provider: null });
    expect(report.providerCount).toBe(0);
    expect(report.dbCount).toBe(0);
    expect(report.adoptedCount).toBe(0);
    expect(report.terminatedCount).toBe(0);
  });

  it('handles both orphan DB rows and orphan provider sandboxes in one pass', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    // Seed: one DB-orphan + one provider-orphan.
    const dbOrphanId = 'sb-db-orphan';
    await db.insert(sandboxInstances).values({
      id: dbOrphanId,
      codespaceId: codespace.id,
      containerId: 'cnt-dead',
      status: 'running',
      image: 'srlynch1/agent-sandbox:latest',
      memoryMb: 8192,
      cpuCores: 4,
      idleTimeoutMinutes: 30,
    });

    const providerOrphanId = 'sb-provider-orphan';
    const codespace2 = await createTestProject();
    const provider = createMockProvider([
      liveInfo({ id: providerOrphanId, codespaceId: codespace2.id, containerId: 'cnt-new' }),
    ]);

    const report = await reconcileSandboxes(db as never, { provider: null }, undefined, provider);

    expect(report.terminatedCount).toBe(1);
    expect(report.adoptedCount).toBe(1);

    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(inArray(sandboxInstances.id, [dbOrphanId, providerOrphanId]));
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    expect(byId.get(dbOrphanId)?.status).toBe('stopped');
    expect(byId.get(providerOrphanId)?.status).toBe('running');
  });
});
