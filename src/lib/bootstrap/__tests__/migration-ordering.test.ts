import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations/index.js';
import { runMigrations } from '../migrations/runner.js';
import { MIGRATION_SQL, seedDefaultTeamForExistingTokens } from '../phases/schema.js';

/**
 * Regression test for migration ordering.
 *
 * Uses the consolidated migration runner to apply the exact same migration
 * sequence used in production (api.ts and bootstrap schema phase).
 *
 * Bug context: RBAC_MIGRATION_SQL previously included
 *   CREATE INDEX idx_github_tokens_team ON github_tokens(team_id)
 * but team_id was only added by RBAC_GITHUB_TOKEN_MIGRATION_SQL which
 * ran later, causing "no such column: team_id" on startup.
 */
describe('Migration ordering', () => {
  it('applies all migrations to a fresh database without errors', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run all migrations via the consolidated runner
    runMigrations(db, MIGRATIONS);
    seedDefaultTeamForExistingTokens(db);

    // Verify all critical columns exist
    const githubTokensCols = db.prepare("PRAGMA table_info('github_tokens')").all() as {
      name: string;
    }[];
    const colNames = githubTokensCols.map((c) => c.name);
    expect(colNames).toContain('team_id');

    // Verify the index was created
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='github_tokens'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_github_tokens_team');

    // Verify event_sources table exists with team_id
    const eventSourcesCols = db.prepare("PRAGMA table_info('event_sources')").all() as {
      name: string;
    }[];
    expect(eventSourcesCols.map((c) => c.name)).toContain('team_id');

    // Verify schema_migrations tracking table was created and populated
    const appliedMigrations = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string }[];
    expect(appliedMigrations.length).toBe(MIGRATIONS.length);
    expect(appliedMigrations[0]!.version).toBe(1);
    expect(appliedMigrations[appliedMigrations.length - 1]!.version).toBe(
      MIGRATIONS[MIGRATIONS.length - 1]!.version
    );

    db.close();
  });

  it('applies all migrations idempotently (double-run)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run the full migration sequence twice to verify idempotency
    for (let run = 0; run < 2; run++) {
      runMigrations(db, MIGRATIONS);
      seedDefaultTeamForExistingTokens(db);
    }

    // Should still work after two runs
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('event_sources');
    expect(tables.map((t) => t.name)).toContain('github_tokens');
    expect(tables.map((t) => t.name)).toContain('teams');

    // Verify migrations were only applied once (not duplicated)
    const appliedMigrations = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    expect(appliedMigrations.length).toBe(MIGRATIONS.length);

    db.close();
  });

  it('fails if github_tokens index is created before team_id column', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Create base schema (github_tokens without team_id)
    db.exec(MIGRATION_SQL);

    // Attempting to create an index on a nonexistent column must throw
    expect(() => {
      db.exec('CREATE INDEX idx_github_tokens_team ON github_tokens(team_id)');
    }).toThrow(/no such column/);

    db.close();
  });

  it('adds skill_id and skill_name columns to tasks table', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    runMigrations(db, MIGRATIONS);

    const tasksCols = db.prepare("PRAGMA table_info('tasks')").all() as {
      name: string;
    }[];
    const colNames = tasksCols.map((c) => c.name);
    expect(colNames).toContain('skill_id');
    expect(colNames).toContain('skill_name');

    // Verify we can insert a task with skill columns through the current
    // codespace-era write shape.
    db.prepare(
      `INSERT OR IGNORE INTO project_folders (id, name, slug)
       VALUES ('default-folder', 'Default', 'default')`
    ).run();
    db.prepare(
      `INSERT INTO codespaces (id, project_folder_id, name, path)
       VALUES ('p1', 'default-folder', 'Test', '/test')`
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, codespace_id, title, skill_id, skill_name)
       VALUES ('t1', 'p1', 'Skill Task', 'terraform-stacks', 'Terraform Stacks')`
    ).run();

    const task = db.prepare(`SELECT skill_id, skill_name FROM tasks WHERE id = 't1'`).get() as {
      skill_id: string;
      skill_name: string;
    };
    expect(task.skill_id).toBe('terraform-stacks');
    expect(task.skill_name).toBe('Terraform Stacks');

    db.close();
  });

  it('supports current codespace-era writes without legacy project_id columns', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    runMigrations(db, MIGRATIONS);
    seedDefaultTeamForExistingTokens(db);

    db.prepare(
      `INSERT OR IGNORE INTO project_folders (id, name, slug)
       VALUES ('default-folder', 'Default', 'default')`
    ).run();
    db.prepare(
      `INSERT INTO codespaces (id, project_folder_id, name, path)
       VALUES ('cs1', 'default-folder', 'Codespace', '/codespace')`
    ).run();
    db.prepare(
      `INSERT INTO agents (id, codespace_id, name, type, status)
       VALUES ('agent1', 'cs1', 'Agent', 'task', 'idle')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, codespace_id, task_id, status, url)
       VALUES ('session1', 'cs1', NULL, 'idle', '/codespaces/cs1/sessions/session1')`
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, codespace_id, title, "column", position, approval_mode)
       VALUES ('task1', 'cs1', 'Task', 'backlog', 0, 'agent')`
    ).run();
    db.prepare(
      `INSERT INTO worktrees (id, codespace_id, task_id, branch, path, status)
       VALUES ('wt1', 'cs1', 'task1', 'agent/task1', '/tmp/wt1', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO agent_runs (id, agent_id, task_id, codespace_id, session_id, status)
       VALUES ('run1', 'agent1', 'task1', 'cs1', 'session1', 'running')`
    ).run();
    db.prepare(`INSERT INTO teams (id, name, slug) VALUES ('team1', 'Team', 'team')`).run();
    db.prepare(
      `INSERT INTO event_sources (id, team_id, name, type, slug)
       VALUES ('source1', 'team1', 'Source', 'cron', 'source')`
    ).run();
    db.prepare(
      `INSERT INTO event_subscriptions (
        id, name, event_source_id, target_codespace_id, prompt_template
      ) VALUES ('sub1', 'Sub', 'source1', 'cs1', 'Handle this')`
    ).run();

    const task = db
      .prepare(`SELECT codespace_id, approval_mode FROM tasks WHERE id = 'task1'`)
      .get() as { codespace_id: string; approval_mode: string } | undefined;
    expect(task).toEqual({ codespace_id: 'cs1', approval_mode: 'agent' });

    db.close();
  });

  it('only applies pending migrations on existing database', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Apply only the first 5 migrations
    runMigrations(db, MIGRATIONS.slice(0, 5));

    const afterFirst = db
      .prepare('SELECT MAX(version) as max_version FROM schema_migrations')
      .get() as { max_version: number };
    expect(afterFirst.max_version).toBe(5);

    // Apply the full set — should only apply 6+
    runMigrations(db, MIGRATIONS);

    const afterAll = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(afterAll.length).toBe(MIGRATIONS.length);

    db.close();
  });

  it('adds current plan_sessions columns to a legacy v19 stub', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, name) VALUES (39, 'api-tokens-cascade-fix');
      CREATE TABLE plan_sessions (
        id TEXT PRIMARY KEY,
        codespace_id TEXT,
        project_id TEXT,
        task_id TEXT,
        session_id TEXT,
        status TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 40)
    );

    const columns = db.prepare("PRAGMA table_info('plan_sessions')").all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual(
      expect.arrayContaining(['turns', 'github_issue_url', 'github_issue_number', 'completed_at'])
    );
    expect(columns.find((c) => c.name === 'turns')?.dflt_value).toBe("'[]'");

    db.close();
  });
});
