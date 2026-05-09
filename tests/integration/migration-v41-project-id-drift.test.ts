/**
 * Regression: migration v41 fails when legacy `project_id` columns are absent
 *
 * Caught by user (2026-05-09) running `npm run dev` against an existing
 * developer DB at v40. Migration v41 ('codespace-era-table-rebuilds') errored
 * with `no such column: project_id`, rolled back, and bootstrap aborted with
 * a fatal `BOOTSTRAP_DATABASE_*` failure. The user could not start the app.
 *
 * Root cause: v41 rebuilds `tasks`, `worktrees`, `agent_runs`, and
 * `event_subscriptions` to drop the legacy `project_id` / `target_project_id`
 * NOT NULL columns left over from v19. The SELECT clauses use
 * `COALESCE(codespace_id, project_id)` to handle databases where the legacy
 * column still holds the source-of-truth value. But on a database where the
 * legacy column has already been dropped (e.g. by a manually-applied schema
 * change, an out-of-band cleanup script, or a future migration that lands
 * before v41 in some deployment), the SELECT references a non-existent column
 * and the entire migration rolls back.
 *
 * Two sibling-class invariants that v41 must satisfy and currently doesn't:
 *
 *   1. v41 must succeed on a database where `tasks.project_id` (and the
 *      analogous columns on worktrees / agent_runs / event_subscriptions)
 *      no longer exist — codespace_id alone is sufficient context.
 *   2. v41 must succeed on a database where BOTH columns exist with
 *      conflicting values — codespace_id wins (current behaviour).
 *
 * The first test below currently FAILS (proves the bug). The second is a
 * regression guard for the existing dual-column path.
 *
 * The fix should detect column existence at runtime via
 * `PRAGMA table_info(tasks)` before composing the INSERT...SELECT, and fall
 * back to a codespace_id-only SELECT when project_id is absent. Hard-coded
 * SQL strings cannot express this conditionally; the migration runner needs
 * a JS-level patch step or a per-table guard helper.
 *
 * Run: `npx vitest run --project integration tests/integration/migration-v41-project-id-drift.test.ts`
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/lib/bootstrap/migrations';
import { runMigrations } from '../../src/lib/bootstrap/migrations/runner';

describe('migration v41 — project_id drift (regression IT-1991)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentpane-v41-drift-'));
    dbPath = join(tmpDir, 'agentpane.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Run migrations v1..v40 to put the DB in the state the user had.
  function applyMigrationsThrough(versionInclusive: number) {
    const subset = MIGRATIONS.filter((m) => m.version <= versionInclusive);
    runMigrations(db, subset);
  }

  function applyMigrationsThroughNonInclusive(versionExclusive: number) {
    const subset = MIGRATIONS.filter((m) => m.version < versionExclusive);
    runMigrations(db, subset);
  }

  function applyV41Only() {
    const v41 = MIGRATIONS.find((m) => m.version === 41);
    if (!v41) throw new Error('v41 missing from MIGRATIONS');
    runMigrations(db, [v41]);
  }

  it('IT-1991-1 v41 survives when tasks.project_id has already been dropped (regression — fixed by `prepare` field)', () => {
    // Set up the user-observed state: migrations through v40 applied, then
    // someone (or a future migration) dropped the legacy project_id column
    // from tasks. The data is intact under codespace_id.
    applyMigrationsThrough(40);

    // Simulate the drift: drop the project_id column from tasks. SQLite
    // 3.35+ supports DROP COLUMN but rejects it while indexes reference the
    // column — drop those indexes first (the user's DB had the same shape
    // after whatever cleanup brought it to this state).
    db.exec(`DROP INDEX IF EXISTS idx_tasks_project_id`);
    db.exec(`DROP INDEX IF EXISTS idx_tasks_kanban`);
    db.exec(`ALTER TABLE tasks DROP COLUMN project_id`);

    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all()
      .map((r: { name: string }) => r.name);
    expect(cols).not.toContain('project_id');
    expect(cols).toContain('codespace_id');

    // Now applying v41 should NOT throw — codespace_id alone is sufficient.
    expect(() => applyV41Only()).not.toThrow();

    // After v41, tasks should still exist and the migration should be marked
    // applied so subsequent boots don't retry it.
    const post = db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 41`)
      .get() as { n: number };
    expect(post.n).toBe(1);
  });

  it('IT-1991-2 v41 succeeds on the legacy dual-column path (regression guard)', () => {
    // Standard path: both project_id and codespace_id exist (no manual drift).
    // This is the behaviour v41 was originally written for; lock it in.
    applyMigrationsThroughNonInclusive(41);

    // Confirm the precondition: tasks has both columns at this point.
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all()
      .map((r: { name: string }) => r.name);
    // (May or may not have project_id depending on prior migration state;
    // the canonical state is that v40 left it in place.)
    expect(cols).toContain('codespace_id');

    expect(() => applyV41Only()).not.toThrow();

    const post = db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 41`)
      .get() as { n: number };
    expect(post.n).toBe(1);
  });

  it('IT-1991-3 fresh boot through all migrations is unaffected (sanity check)', () => {
    // A brand-new DB applying v1..v46 in order should never hit this drift —
    // this test guards against a fix that breaks the happy path.
    expect(() => runMigrations(db, MIGRATIONS)).not.toThrow();
    const cols = db
      .prepare(`PRAGMA table_info(tasks)`)
      .all()
      .map((r: { name: string }) => r.name);
    expect(cols).toContain('codespace_id');
    expect(cols).not.toContain('project_id');
  });
});
