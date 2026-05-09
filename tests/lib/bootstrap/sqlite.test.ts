import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock better-sqlite3 before any imports using vi.hoisted
const betterSqlite3Mocks = vi.hoisted(() => {
  const mockPragma = vi.fn();
  const mockPrepare = vi.fn(() => ({
    get: vi.fn(() => ({ test: 1 })),
  }));
  const mockClose = vi.fn();

  // Store the mock instance for access in tests
  let mockDatabaseInstance: {
    pragma: typeof mockPragma;
    prepare: typeof mockPrepare;
    close: typeof mockClose;
  };

  // Create a proper class-like constructor function
  function MockDatabaseClass(this: unknown, _path: string) {
    mockDatabaseInstance = {
      pragma: mockPragma,
      prepare: mockPrepare,
      close: mockClose,
    };
    Object.assign(this as object, mockDatabaseInstance);
    return this;
  }

  // Make it look like a constructor
  const MockDatabaseFn = vi.fn(MockDatabaseClass);

  return {
    MockDatabaseFn,
    getMockInstance: () => mockDatabaseInstance,
    mockPragma,
    mockPrepare,
    mockClose,
    resetMocks: () => {
      mockPragma.mockReset();
      mockPrepare.mockReset();
      mockPrepare.mockReturnValue({
        get: vi.fn(() => ({ test: 1 })),
      });
      mockClose.mockReset();
      MockDatabaseFn.mockReset();
      MockDatabaseFn.mockImplementation(MockDatabaseClass);
    },
  };
});

vi.mock('better-sqlite3', () => ({
  default: betterSqlite3Mocks.MockDatabaseFn,
}));

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

// Mock the env module
vi.mock('@/lib/env', () => ({
  getRuntimeEnv: vi.fn(() => ({ e2eSeed: false })),
}));

describe('SQLite Bootstrap Phase', () => {
  const { MockDatabaseFn, mockPragma, mockPrepare, resetMocks } = betterSqlite3Mocks;

  beforeEach(() => {
    vi.resetModules();
    resetMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.mkdirSync).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // =============================================================================
  // E2E Seed Mode - In-Memory Database (Lines 18-28)
  // =============================================================================

  describe('E2E Seed Mode - In-Memory Database', () => {
    it('creates in-memory database when e2eSeed is true', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: true });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(true);
      expect(MockDatabaseFn).toHaveBeenCalledWith(':memory:');
    });

    it('enables foreign keys for in-memory database', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: true });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(mockPragma).toHaveBeenCalledWith('foreign_keys = ON');
    });

    it('verifies in-memory database connection with SELECT 1', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: true });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(mockPrepare).toHaveBeenCalledWith('SELECT 1 as test');
    });

    it('returns error when in-memory verification query fails', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: true });

      // Mock verification failure - return wrong value
      mockPrepare.mockReturnValue({
        get: vi.fn(() => ({ test: 0 })),
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.message).toBe('SQLite verification query failed');
        expect(result.error.status).toBe(500);
      }
    });

    it('returns error when in-memory verification returns null', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: true });

      // Mock verification failure - return null
      mockPrepare.mockReturnValue({
        get: vi.fn(() => null),
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.message).toBe('SQLite verification query failed');
      }
    });

    it('returns SQLite database instance on successful E2E initialization', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: true });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value.pragma).toBeDefined();
        expect(result.value.prepare).toBeDefined();
      }
    });
  });

  // =============================================================================
  // Production Mode - File-Based Database (Lines 31-51)
  // =============================================================================

  describe('Production Mode - File-Based Database', () => {
    it('creates file-based database with default path', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(MockDatabaseFn).toHaveBeenCalledWith('./data/agentpane.db');
    });

    it('uses custom data directory from environment variable', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });
      vi.stubEnv('SQLITE_DATA_DIR', '/custom/data/path');

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(MockDatabaseFn).toHaveBeenCalledWith('/custom/data/path/agentpane.db');
    });

    it('creates data directory if it does not exist', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(fs.mkdirSync).toHaveBeenCalledWith('./data', { recursive: true });
    });

    it('does not create data directory if it already exists', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('enables WAL mode for file-based database', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL');
    });

    it('enables foreign keys for file-based database', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(mockPragma).toHaveBeenCalledWith('foreign_keys = ON');
    });

    it('verifies file-based database connection with SELECT 1', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      await initializeSQLite();

      expect(mockPrepare).toHaveBeenCalledWith('SELECT 1 as test');
    });

    it('returns error when file-based verification query fails', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      // Mock verification failure - return wrong value
      mockPrepare.mockReturnValue({
        get: vi.fn(() => ({ test: 99 })),
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.message).toBe('SQLite verification query failed');
        expect(result.error.status).toBe(500);
      }
    });
  });

  // =============================================================================
  // Error Handling (Lines 52-58)
  // =============================================================================

  describe('Error Handling', () => {
    it('catches and returns error when Database constructor throws', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const dbError = new Error('Failed to open database file');
      MockDatabaseFn.mockImplementation(function (this: unknown) {
        throw dbError;
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.message).toBe('Failed to initialize SQLite');
        expect(result.error.status).toBe(500);
        expect(result.error.details?.error).toContain('Failed to open database file');
      }
    });

    it('catches and returns error when pragma throws', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const pragmaError = new Error('Pragma execution failed');
      mockPragma.mockImplementation(() => {
        throw pragmaError;
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.details?.error).toContain('Pragma execution failed');
      }
    });

    it('catches and returns error when prepare throws', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      const prepareError = new Error('SQL prepare statement failed');
      mockPrepare.mockImplementation(() => {
        throw prepareError;
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.details?.error).toContain('SQL prepare statement failed');
      }
    });

    it('handles non-Error objects being thrown', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });

      MockDatabaseFn.mockImplementation(function (this: unknown) {
        throw 'string error';
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.details?.error).toBe('string error');
      }
    });

    it('handles directory creation failure', async () => {
      const { getRuntimeEnv } = await import('@/lib/env');
      vi.mocked(getRuntimeEnv).mockReturnValue({ e2eSeed: false });
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const { initializeSQLite } = await import('@/lib/bootstrap/phases/sqlite');
      const result = await initializeSQLite();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BOOTSTRAP_SQLITE_INIT_FAILED');
        expect(result.error.details?.error).toContain('Permission denied');
      }
    });
  });

  // =============================================================================
  // applySQLiteToContext Function (Line 61-62)
  // =============================================================================

  describe('applySQLiteToContext', () => {
    it('sets db property on context', async () => {
      const { applySQLiteToContext } = await import('@/lib/bootstrap/phases/sqlite');
      const mockDb = { pragma: vi.fn(), prepare: vi.fn() } as unknown as Parameters<
        typeof applySQLiteToContext
      >[1];
      const ctx = {} as Parameters<typeof applySQLiteToContext>[0];

      applySQLiteToContext(ctx, mockDb);

      expect(ctx.db).toBe(mockDb);
    });

    it('overwrites existing db property on context', async () => {
      const { applySQLiteToContext } = await import('@/lib/bootstrap/phases/sqlite');
      const oldDb = { pragma: vi.fn() } as unknown as Parameters<typeof applySQLiteToContext>[1];
      const newDb = { pragma: vi.fn(), prepare: vi.fn() } as unknown as Parameters<
        typeof applySQLiteToContext
      >[1];
      const ctx = { db: oldDb } as Parameters<typeof applySQLiteToContext>[0];

      applySQLiteToContext(ctx, newDb);

      expect(ctx.db).toBe(newDb);
      expect(ctx.db).not.toBe(oldDb);
    });
  });

  // =============================================================================
  // Type Exports
  // =============================================================================

  describe('Type Exports', () => {
    it('exports SQLiteDatabase type', async () => {
      // This test verifies the type export exists by importing the module
      // The type itself cannot be tested at runtime, but we verify the module loads
      const sqliteModule = await import('@/lib/bootstrap/phases/sqlite');

      expect(sqliteModule).toBeDefined();
      expect(sqliteModule.initializeSQLite).toBeDefined();
      expect(sqliteModule.applySQLiteToContext).toBeDefined();
    });
  });
});
