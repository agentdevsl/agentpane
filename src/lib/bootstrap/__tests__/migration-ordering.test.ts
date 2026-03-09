import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  CLI_SESSIONS_MIGRATION_SQL,
  CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL,
  EVENT_SYSTEM_MIGRATION_SQL,
  MIGRATION_SQL,
  PERFORMANCE_INDEXES_MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
  RBAC_SCHEMA_ADDITIONS,
  SANDBOX_CONTAINER_ID_MIGRATION_SQL,
  SANDBOX_MIGRATION_SQL,
  SCHEDULE_EXECUTIONS_MIGRATION_SQL,
  seedDefaultTeamForExistingTokens,
  TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL,
  TERRAFORM_MIGRATION_SQL,
} from '../phases/schema.js';

/**
 * Regression test for migration ordering.
 *
 * This test replays the exact migration sequence from src/server/api.ts
 * against a fresh in-memory SQLite database. If any migration references
 * a column or table that hasn't been created yet, the test will fail.
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

    // 1. Base schema
    db.exec(MIGRATION_SQL);

    // 2. Sandbox migration (ALTER TABLE — may fail on re-run)
    try {
      db.exec(SANDBOX_MIGRATION_SQL);
    } catch {
      // duplicate column expected on re-run
    }

    // 3. Sandbox container ID
    try {
      db.exec(SANDBOX_CONTAINER_ID_MIGRATION_SQL);
    } catch {
      // duplicate column expected on re-run
    }

    // 4. Template sync interval
    try {
      db.exec(TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL);
    } catch {
      // duplicate column expected on re-run
    }

    // 5. Performance indexes
    db.exec(PERFORMANCE_INDEXES_MIGRATION_SQL);

    // 6. CLI sessions
    db.exec(CLI_SESSIONS_MIGRATION_SQL);
    try {
      db.exec(CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL);
    } catch {
      // duplicate column expected on re-run
    }

    // 7. Terraform
    db.exec(TERRAFORM_MIGRATION_SQL);

    // 8. RBAC tables (must NOT reference github_tokens.team_id)
    db.exec(RBAC_MIGRATION_SQL);

    // 9. RBAC schema additions
    for (const sql of RBAC_SCHEMA_ADDITIONS) {
      try {
        db.exec(sql);
      } catch {
        // duplicate column expected on re-run
      }
    }

    // 10. github_tokens team_id column (must come BEFORE any index on it)
    try {
      db.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
    } catch {
      // duplicate column expected on re-run
    }

    // 11. Index on github_tokens(team_id) — must come AFTER step 10
    db.exec('CREATE INDEX IF NOT EXISTS idx_github_tokens_team ON github_tokens(team_id)');

    // 12. Seed default team (queries github_tokens.team_id — must come after step 10)
    seedDefaultTeamForExistingTokens(db);

    // 13. Event system (references teams table from RBAC)
    db.exec(EVENT_SYSTEM_MIGRATION_SQL);

    // 14. Schedule executions (references event_sources from step 13)
    db.exec(SCHEDULE_EXECUTIONS_MIGRATION_SQL);

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

    db.close();
  });

  it('applies all migrations idempotently (double-run)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run the full migration sequence twice to verify idempotency
    for (let run = 0; run < 2; run++) {
      db.exec(MIGRATION_SQL);

      try {
        db.exec(SANDBOX_MIGRATION_SQL);
      } catch {
        /* dup col */
      }
      try {
        db.exec(SANDBOX_CONTAINER_ID_MIGRATION_SQL);
      } catch {
        /* dup col */
      }
      try {
        db.exec(TEMPLATE_SYNC_INTERVAL_MIGRATION_SQL);
      } catch {
        /* dup col */
      }

      db.exec(PERFORMANCE_INDEXES_MIGRATION_SQL);
      db.exec(CLI_SESSIONS_MIGRATION_SQL);
      try {
        db.exec(CLI_SESSIONS_PERF_METRICS_MIGRATION_SQL);
      } catch {
        /* dup col */
      }

      db.exec(TERRAFORM_MIGRATION_SQL);
      db.exec(RBAC_MIGRATION_SQL);

      for (const sql of RBAC_SCHEMA_ADDITIONS) {
        try {
          db.exec(sql);
        } catch {
          /* dup col */
        }
      }

      try {
        db.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
      } catch {
        /* dup col */
      }
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_github_tokens_team ON github_tokens(team_id)');
      } catch {
        /* already exists */
      }

      seedDefaultTeamForExistingTokens(db);

      db.exec(EVENT_SYSTEM_MIGRATION_SQL);
      db.exec(SCHEDULE_EXECUTIONS_MIGRATION_SQL);
    }

    // Should still work after two runs
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('event_sources');
    expect(tables.map((t) => t.name)).toContain('github_tokens');
    expect(tables.map((t) => t.name)).toContain('teams');

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
});
