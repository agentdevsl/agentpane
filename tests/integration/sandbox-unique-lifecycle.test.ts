/**
 * F04-08 (arch29-W2-E): Sandbox UNIQUE constraint lifecycle fix.
 *
 * Before this fix, `sandbox_instances.codespace_id` carried a global UNIQUE
 * constraint. Once a sandbox was stopped, the row stuck around in the table
 * with `status='stopped'`. The next `SandboxService.create()` for the same
 * codespace failed with `SQLITE_CONSTRAINT_UNIQUE` even though the existing
 * row was no longer active. This test pins down the new behaviour:
 *
 *  - GREEN: stop a sandbox, then create a new one for the same codespace.
 *           Both rows must coexist (one stopped, one running).
 *  - GREEN: only one *active* sandbox per codespace can exist at any time.
 *           The partial unique index still rejects two simultaneously
 *           running rows for the same codespace.
 *  - RED before fix: the first scenario fails with SQLITE_CONSTRAINT_UNIQUE
 *           on the second create (regression for F04-08).
 *
 * The test exercises the schema directly (raw inserts) so it isolates the
 * constraint from any service-layer logic that might mask it.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxInstances } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Recreate the schema shape this PR ships, mirroring the bootstrap migration
 * v33 ("sandbox-unique-partial-index"). The harness now creates
 * `sandbox_instances` (F09-21 / arch29-W2-Q), but each test in this file
 * needs deterministic state, so we recreate the table per-test in the
 * post-fix shape.
 */
function ensureSandboxInstancesTableWithPartialIndex(): void {
  // Drop any prior table so each test starts from a known state. The DROP
  // also wipes any in-memory cached SQL plans referencing the legacy
  // UNIQUE constraint, which matters because tests in other files create
  // the legacy shape.
  try {
    execRawSql('DROP TABLE IF EXISTS sandbox_instances');
  } catch {
    // ignore — table may already be absent
  }
  execRawSql(`
    CREATE TABLE sandbox_instances (
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
  execRawSql(`
    CREATE UNIQUE INDEX IF NOT EXISTS sandbox_instances_codespace_active_unique
      ON sandbox_instances(codespace_id)
      WHERE status IN ('creating', 'running', 'idle', 'stopping');
  `);
}

/**
 * Recreate the *legacy* shape (column-level UNIQUE on codespace_id). Used
 * to assert the regression itself: the bug exists when this shape is in
 * play, and disappears after the partial-index migration.
 */
function ensureSandboxInstancesTableWithGlobalUnique(): void {
  try {
    execRawSql('DROP TABLE IF EXISTS sandbox_instances');
  } catch {
    // ignore — table may already be absent
  }
  execRawSql(`
    CREATE TABLE sandbox_instances (
      id TEXT PRIMARY KEY NOT NULL,
      codespace_id TEXT NOT NULL UNIQUE,
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

describe('F04-08: sandbox_instances UNIQUE lifecycle fix (arch29-W2-E)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    try {
      execRawSql('DELETE FROM sandbox_instances');
    } catch {
      // table may have been dropped between tests; safe to ignore
    }
    await clearTestDatabase();
  });

  it('regression baseline (pre-fix): legacy global UNIQUE blocks stop -> create', async () => {
    // Set up the OLD schema shape so we can prove the regression exists.
    // This test is a control: it documents the bug we're fixing.
    ensureSandboxInstancesTableWithGlobalUnique();
    const project = await createTestProject();

    // First sandbox row (active).
    execRawSql(`
      INSERT INTO sandbox_instances (
        id, codespace_id, container_id, status, image, memory_mb, cpu_cores,
        idle_timeout_minutes
      ) VALUES (
        'sb-old-1', '${project.id}', 'cont-1', 'running', 'test-image:1.0',
        2048, 2, 30
      );
    `);

    // Stop it.
    execRawSql(`
      UPDATE sandbox_instances
      SET status = 'stopped', stopped_at = datetime('now')
      WHERE id = 'sb-old-1';
    `);

    // Try to create a new sandbox for the same codespace. With the legacy
    // global UNIQUE, this MUST throw.
    let threwExpected = false;
    try {
      execRawSql(`
        INSERT INTO sandbox_instances (
          id, codespace_id, container_id, status, image, memory_mb, cpu_cores,
          idle_timeout_minutes
        ) VALUES (
          'sb-old-2', '${project.id}', 'cont-2', 'running', 'test-image:1.0',
          2048, 2, 30
        );
      `);
    } catch (err) {
      threwExpected = err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
    }
    expect(threwExpected).toBe(true);
  });

  it('post-fix: stop then create succeeds for the same codespace (partial unique index)', async () => {
    ensureSandboxInstancesTableWithPartialIndex();
    const project = await createTestProject();
    const db = getTestDb();

    // First sandbox: created and running.
    await db.insert(sandboxInstances).values({
      id: 'sb-new-1',
      codespaceId: project.id,
      containerId: 'cont-1',
      status: 'running',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    // Stop it.
    await db
      .update(sandboxInstances)
      .set({ status: 'stopped', stoppedAt: new Date().toISOString() })
      .where(eq(sandboxInstances.id, 'sb-new-1'));

    // Second sandbox for the SAME codespace. With the partial unique index,
    // this must succeed because the first row is no longer active.
    await db.insert(sandboxInstances).values({
      id: 'sb-new-2',
      codespaceId: project.id,
      containerId: 'cont-2',
      status: 'running',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    // Both rows coexist; one stopped, one running.
    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(eq(sandboxInstances.codespaceId, project.id));
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('sb-new-1')?.status).toBe('stopped');
    expect(byId.get('sb-new-2')?.status).toBe('running');
  });

  it('post-fix: two simultaneously active sandboxes for same codespace still rejected', async () => {
    ensureSandboxInstancesTableWithPartialIndex();
    const project = await createTestProject();
    const db = getTestDb();

    // First active sandbox.
    await db.insert(sandboxInstances).values({
      id: 'sb-active-1',
      codespaceId: project.id,
      containerId: 'cont-1',
      status: 'running',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    // Second sandbox in *running* status for the same codespace MUST be
    // rejected by the partial unique index (the index fires for both
    // 'running' rows).
    let threwExpected = false;
    try {
      await db.insert(sandboxInstances).values({
        id: 'sb-active-2',
        codespaceId: project.id,
        containerId: 'cont-2',
        status: 'running',
        image: 'test-image:1.0',
        memoryMb: 2048,
        cpuCores: 2,
        idleTimeoutMinutes: 30,
      });
    } catch (err) {
      threwExpected = err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
    }
    expect(threwExpected).toBe(true);

    // Only one row visible.
    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(eq(sandboxInstances.codespaceId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('sb-active-1');
  });

  it('post-fix: multiple stopped/error sandboxes for same codespace coexist freely', async () => {
    ensureSandboxInstancesTableWithPartialIndex();
    const project = await createTestProject();
    const db = getTestDb();

    // Insert three terminal-state sandbox rows for the same codespace. The
    // partial unique index does NOT fire for any of these statuses, so all
    // three should land.
    await db.insert(sandboxInstances).values({
      id: 'sb-terminal-1',
      codespaceId: project.id,
      containerId: 'cont-1',
      status: 'stopped',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      stoppedAt: new Date().toISOString(),
    });
    await db.insert(sandboxInstances).values({
      id: 'sb-terminal-2',
      codespaceId: project.id,
      containerId: 'cont-2',
      status: 'error',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      errorMessage: 'simulated failure',
    });
    await db.insert(sandboxInstances).values({
      id: 'sb-terminal-3',
      codespaceId: project.id,
      containerId: 'cont-3',
      status: 'stopped',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
      stoppedAt: new Date().toISOString(),
    });

    // And one fresh active sandbox — should also succeed because none of
    // the terminal rows are active.
    await db.insert(sandboxInstances).values({
      id: 'sb-active-fresh',
      codespaceId: project.id,
      containerId: 'cont-active',
      status: 'running',
      image: 'test-image:1.0',
      memoryMb: 2048,
      cpuCores: 2,
      idleTimeoutMinutes: 30,
    });

    const rows = await db
      .select()
      .from(sandboxInstances)
      .where(eq(sandboxInstances.codespaceId, project.id));
    expect(rows).toHaveLength(4);
    const activeRows = rows.filter((r) => r.status === 'running');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe('sb-active-fresh');
  });
});
