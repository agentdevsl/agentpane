import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapContext } from '@/lib/bootstrap/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSeededDb() {
  const Database = (await import('better-sqlite3')).default;
  const { MIGRATION_SQL, RBAC_MIGRATION_SQL } = await import('@/lib/bootstrap/phases/schema');
  const { PROJECT_FOLDERS_MIGRATION_SQL, PROJECT_FOLDERS_ALTER_STATEMENTS } = await import(
    '@/lib/bootstrap/migrations/v19-project-folders'
  );
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);
  db.exec(RBAC_MIGRATION_SQL);
  // Run v19 migration so codespaces table exists
  db.exec(PROJECT_FOLDERS_MIGRATION_SQL);
  for (const stmt of PROJECT_FOLDERS_ALTER_STATEMENTS) {
    try {
      db.exec(stmt);
    } catch {
      // Idempotent — column may already exist
    }
  }
  return db;
}

function makeContext(db: ReturnType<Awaited<ReturnType<typeof createSeededDb>>>): BootstrapContext {
  return { db } as BootstrapContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Seeding phase', () => {
  let seedDefaults: typeof import('@/lib/bootstrap/phases/seeding').seedDefaults;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@/lib/bootstrap/phases/seeding');
    seedDefaults = mod.seedDefaults;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Default data insertion
  // =========================================================================

  describe('Default data insertion', () => {
    it('creates a default codespace when database is empty', async () => {
      const db = await createSeededDb();
      const result = await seedDefaults(makeContext(db));

      expect(result.ok).toBe(true);

      const codespaces = db.prepare('SELECT * FROM codespaces').all() as any[];
      expect(codespaces).toHaveLength(1);
      db.close();
    });

    it('creates a default agent in the default codespace', async () => {
      const db = await createSeededDb();
      await seedDefaults(makeContext(db));

      const agents = db.prepare('SELECT * FROM agents').all() as any[];
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Default Agent');
      expect(agents[0].type).toBe('task');
      expect(agents[0].status).toBe('idle');

      const config = JSON.parse(agents[0].config);
      expect(config.allowedTools).toContain('Read');
      expect(config.maxTurns).toBe(50);
      db.close();
    });

    it('seeds a K8s sandbox config', async () => {
      const db = await createSeededDb();
      await seedDefaults(makeContext(db));

      const configs = db
        .prepare("SELECT * FROM sandbox_configs WHERE type = 'kubernetes'")
        .all() as any[];
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('Kubernetes Standard');
      db.close();
    });
  });

  // =========================================================================
  // Idempotent seeding
  // =========================================================================

  describe('Idempotent seeding', () => {
    it('does not insert duplicate codespaces on second run', async () => {
      const db = await createSeededDb();
      await seedDefaults(makeContext(db));
      await seedDefaults(makeContext(db));

      const codespaces = db.prepare('SELECT * FROM codespaces').all();
      expect(codespaces).toHaveLength(1);
      db.close();
    });

    it('does not insert duplicate K8s sandbox config on second run', async () => {
      const db = await createSeededDb();
      await seedDefaults(makeContext(db));
      await seedDefaults(makeContext(db));

      const configs = db.prepare("SELECT * FROM sandbox_configs WHERE type = 'kubernetes'").all();
      expect(configs).toHaveLength(1);
      db.close();
    });

    it('skips codespace seeding when a codespace already exists', async () => {
      const db = await createSeededDb();
      db.prepare(
        "INSERT INTO codespaces (id, project_folder_id, name, path, created_at, updated_at) VALUES ('existing', 'default-folder', 'Existing', '/path', datetime('now'), datetime('now'))"
      ).run();

      await seedDefaults(makeContext(db));

      const codespaces = db.prepare('SELECT * FROM codespaces').all();
      expect(codespaces).toHaveLength(1);
      expect((codespaces[0] as any).name).toBe('Existing');
      db.close();
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('Error handling', () => {
    it('returns error when ctx.db is undefined', async () => {
      const result = await seedDefaults({} as BootstrapContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_NO_DATABASE');
      }
    });

    it('returns error when database write fails', async () => {
      const fakeDb = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => {
            throw new Error('readonly database');
          }),
        })),
      };
      const result = await seedDefaults({ db: fakeDb } as unknown as BootstrapContext);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SEED_FAILED');
      }
    });
  });
});
