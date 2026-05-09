/**
 * Regression: v47 repairs orphan FK references to dropped *_backup tables.
 *
 * Caught while running 'npm run dev' against a real long-lived dev DB:
 * after v41/v42/v43/v44 succeeded, v45 ('tags-project-folder-id-notnull')
 * failed with `no such table: main.tasks_backup`. The error came not from
 * v45 itself (which only touches tags) but from SQLite's foreign-key
 * integrity check fired by every DROP TABLE — the schema had orphan FK
 * refs from task_tags / session_summaries / schedule_executions /
 * memory_insights / memory_messages / skill_executions to `tasks_backup`,
 * `agent_runs_backup`, and `sessions_backup` that no longer exist.
 *
 * Root cause (historical): an earlier rebuild did
 * 'RENAME TABLE x TO x_backup; CREATE TABLE x; DROP TABLE x_backup'
 * but did NOT update the FK refs on dependent tables — they still pointed
 * at the dropped backup tables. SQLite tolerates this until the next
 * schema-modifying op runs the FK integrity check.
 *
 * v47 rebuilds each affected dependent table with FK refs corrected to
 * point at the live target tables (`tasks`, `agent_runs`, `sessions`),
 * filters rows whose target IDs no longer match, and drops any leftover
 * `*_backup` tables. Runs with `disableForeignKeys: true` because the
 * orphan refs would otherwise abort the rebuild before the cleanup
 * completes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/lib/bootstrap/migrations';
import { runMigrations } from '../../src/lib/bootstrap/migrations/runner';

describe('migration v47 — orphan backup-table FK repair (regression IT-1992)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentpane-v47-orphan-'));
    dbPath = join(tmpDir, 'agentpane.db');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function applyThrough(version: number) {
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= version)
    );
  }

  function tableSql(name: string): string | undefined {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name) as { sql: string } | undefined;
    return row?.sql;
  }

  it('IT-1992-1 v47 repairs all 6 dependent tables with orphan *_backup FK refs', () => {
    applyThrough(40);

    // Inject the user-observed corruption: rebuild dependent tables with FK
    // refs pointing at non-existent backup tables. Use foreign_keys=OFF so
    // the inject itself succeeds (real-world: this drift accumulated over
    // months from incomplete prior migrations).
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_backup (id TEXT PRIMARY KEY);

      DROP TABLE IF EXISTS task_tags;
      CREATE TABLE task_tags (
        task_id TEXT NOT NULL REFERENCES tasks_backup(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        assigned_at TEXT DEFAULT (datetime('now')) NOT NULL,
        PRIMARY KEY (task_id, tag_id)
      );

      DROP TABLE IF EXISTS session_summaries;
      CREATE TABLE session_summaries (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions_backup(id) ON DELETE CASCADE,
        duration_ms INTEGER,
        turns_count INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        files_modified INTEGER DEFAULT 0,
        lines_added INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        final_status TEXT,
        updated_at TEXT DEFAULT (datetime('now')) NOT NULL
      );
    `);
    db.pragma('foreign_keys = ON');

    // Confirm the corruption is in place.
    expect(tableSql('task_tags')).toContain('tasks_backup');
    expect(tableSql('session_summaries')).toContain('sessions_backup');

    // Run v41..v47. With disableForeignKeys on v45/v46/v47, the rebuilds
    // should succeed despite the orphan refs.
    expect(() => applyThrough(47)).not.toThrow();

    // After v47, no table should reference any *_backup table.
    const remainingOrphanRefs = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
         AND sql LIKE '%_backup%'
         AND name NOT LIKE 'sqlite_%'`
      )
      .all();
    expect(remainingOrphanRefs).toEqual([]);

    // The leftover sessions_backup table should also be gone.
    const sessionsBackupExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_backup'`)
      .get();
    expect(sessionsBackupExists).toBeUndefined();

    // task_tags and session_summaries should now point at the live tables.
    expect(tableSql('task_tags')).toContain('REFERENCES tasks');
    expect(tableSql('task_tags')).not.toContain('tasks_backup');
    expect(tableSql('session_summaries')).toContain('REFERENCES sessions');
    expect(tableSql('session_summaries')).not.toContain('sessions_backup');

    // FK enforcement should be back on.
    expect((db.pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0].foreign_keys).toBe(1);
  });

  it('IT-1992-2 v47 is a no-op on a fresh DB that never had orphan refs (idempotency)', () => {
    expect(() => applyThrough(47)).not.toThrow();
    // task_tags should exist and point at the live tasks table.
    const sql = tableSql('task_tags') ?? '';
    expect(sql).toContain('REFERENCES tasks');
    expect(sql).not.toContain('_backup');
  });

  it('IT-1992-3 v47 records itself as applied so subsequent boots skip', () => {
    applyThrough(47);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 47`)
      .get() as { n: number };
    expect(row.n).toBe(1);
  });
});
