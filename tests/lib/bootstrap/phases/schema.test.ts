import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapContext } from '@/lib/bootstrap/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal in-memory SQLite database via better-sqlite3
 * for testing the schema migration functions.
 */
async function createTestDb() {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function makeContext(db: ReturnType<Awaited<ReturnType<typeof createTestDb>>>): BootstrapContext {
  return { db } as BootstrapContext;
}

function tableExists(db: any, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
  return !!row;
}

function columnExists(db: any, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return cols.some((c) => c.name === columnName);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Schema validation phase', () => {
  let validateSchema: typeof import('@/lib/bootstrap/phases/schema').validateSchema;
  let _MIGRATION_SQL: string;
  let _RBAC_MIGRATION_SQL: string;
  let seedDefaultTeamForExistingTokens: typeof import('@/lib/bootstrap/phases/schema').seedDefaultTeamForExistingTokens;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@/lib/bootstrap/phases/schema');
    validateSchema = mod.validateSchema;
    _MIGRATION_SQL = mod.MIGRATION_SQL;
    _RBAC_MIGRATION_SQL = mod.RBAC_MIGRATION_SQL;
    seedDefaultTeamForExistingTokens = mod.seedDefaultTeamForExistingTokens;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Core table creation
  // =========================================================================

  describe('Core table creation', () => {
    it('creates the projects table', async () => {
      const db = await createTestDb();
      const result = await validateSchema(makeContext(db));
      expect(result.ok).toBe(true);
      expect(tableExists(db, 'projects')).toBe(true);
      db.close();
    });

    it('creates the agents table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(tableExists(db, 'agents')).toBe(true);
      db.close();
    });

    it('creates the tasks table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(tableExists(db, 'tasks')).toBe(true);
      db.close();
    });

    it('creates the sessions table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(tableExists(db, 'sessions')).toBe(true);
      db.close();
    });

    it('creates the worktrees table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(tableExists(db, 'worktrees')).toBe(true);
      db.close();
    });

    it('creates the settings table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(tableExists(db, 'settings')).toBe(true);
      db.close();
    });

    it('creates the session_events table with indexes', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(tableExists(db, 'session_events')).toBe(true);
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_events'")
        .all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('session_events_session_idx');
      // DB-008: session_events_offset_idx was removed (redundant with session_events_unique_offset)
      expect(indexNames).toContain('session_events_unique_offset');
      expect(indexNames).not.toContain('session_events_offset_idx');
      db.close();
    });
  });

  // =========================================================================
  // RBAC tables
  // =========================================================================

  describe('RBAC table creation', () => {
    it('creates all 11 RBAC tables', async () => {
      const db = await createTestDb();
      const result = await validateSchema(makeContext(db));
      expect(result.ok).toBe(true);

      const rbacTables = [
        'users',
        'user_sessions',
        'teams',
        'team_members',
        'team_projects',
        'project_members',
        'tags',
        'project_tags',
        'task_tags',
        'api_tokens',
        'team_invitations',
      ];

      for (const table of rbacTables) {
        expect(tableExists(db, table)).toBe(true);
      }
      db.close();
    });

    it('adds github_email column to users table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(columnExists(db, 'users', 'github_email')).toBe(true);
      db.close();
    });

    it('adds team_id column to github_tokens table', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      expect(columnExists(db, 'github_tokens', 'team_id')).toBe(true);
      db.close();
    });
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  describe('Idempotency', () => {
    it('succeeds when run twice on the same database', async () => {
      const db = await createTestDb();
      const result1 = await validateSchema(makeContext(db));
      const result2 = await validateSchema(makeContext(db));
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      db.close();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('Error handling', () => {
    it('returns error when ctx.db is undefined', async () => {
      const result = await validateSchema({} as BootstrapContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_NO_DATABASE');
      }
    });

    it('returns error when db.exec throws', async () => {
      const fakeDb = {
        exec: vi.fn(() => {
          throw new Error('disk I/O error');
        }),
      };
      const result = await validateSchema({ db: fakeDb } as unknown as BootstrapContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SCHEMA_VALIDATION_FAILED');
      }
    });
  });

  // =========================================================================
  // Marketplace seeding
  // =========================================================================

  describe('Marketplace seeding', () => {
    it('seeds official marketplace row via MIGRATION_SQL', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));
      const row = db
        .prepare("SELECT * FROM marketplaces WHERE id = 'anthropic-official-marketplace'")
        .get() as any;
      expect(row).toBeDefined();
      expect(row.name).toBe('Claude Plugins Official');
      expect(row.is_default).toBe(1);
      db.close();
    });
  });

  // =========================================================================
  // seedDefaultTeamForExistingTokens
  // =========================================================================

  describe('seedDefaultTeamForExistingTokens', () => {
    it('creates a default team when orphaned tokens exist', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));

      // Insert an orphaned github_token
      db.prepare(
        "INSERT INTO github_tokens (id, encrypted_token, token_type) VALUES ('tok1', 'enc', 'pat')"
      ).run();

      seedDefaultTeamForExistingTokens(db);

      const teams = db.prepare('SELECT * FROM teams').all() as any[];
      expect(teams).toHaveLength(1);
      expect(teams[0].slug).toBe('default');

      // Token should now have team_id set
      const token = db.prepare("SELECT team_id FROM github_tokens WHERE id = 'tok1'").get() as any;
      expect(token.team_id).toBe(teams[0].id);

      db.close();
    });

    it('does not create team when no orphaned tokens exist', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));

      seedDefaultTeamForExistingTokens(db);

      const teams = db.prepare('SELECT * FROM teams').all();
      expect(teams).toHaveLength(0);
      db.close();
    });

    it('does not create team when teams already exist', async () => {
      const db = await createTestDb();
      await validateSchema(makeContext(db));

      db.prepare(
        "INSERT INTO teams (id, name, slug) VALUES ('existing', 'Existing Team', 'existing')"
      ).run();
      db.prepare(
        "INSERT INTO github_tokens (id, encrypted_token, token_type) VALUES ('tok1', 'enc', 'pat')"
      ).run();

      seedDefaultTeamForExistingTokens(db);

      const teams = db.prepare('SELECT * FROM teams').all();
      expect(teams).toHaveLength(1);
      expect((teams[0] as any).slug).toBe('existing');
      db.close();
    });
  });
});
