import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import { getRuntimeEnv } from '../../env.js';
import type { AppError } from '../../errors/base.js';
import { createError } from '../../errors/base.js';
import { err, ok, type Result } from '../../utils/result.js';
import type { BootstrapContext } from '../types.js';

// Re-export the Database type for external use
export type { SQLiteDatabase };

const BOOTSTRAP_ERROR_CODE = 'BOOTSTRAP_SQLITE_INIT_FAILED';

export const initializeSQLite = async (): Promise<Result<SQLiteDatabase, AppError>> => {
  const { e2eSeed } = getRuntimeEnv();

  try {
    // In E2E runs we use an in-memory DB for isolation
    if (e2eSeed) {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');

      // Verify connection works
      const result = sqlite.prepare('SELECT 1 as test').get() as { test: number };
      if (result?.test !== 1) {
        return err(createError(BOOTSTRAP_ERROR_CODE, 'SQLite verification query failed', 500));
      }

      return ok(sqlite);
    }

    // Production: Use file-based database
    const dataDir = process.env.SQLITE_DATA_DIR || './data';
    const dbPath = `${dataDir}/agentpane.db`;

    // Ensure data directory exists
    const fs = await import('node:fs');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL'); // Better concurrency
    sqlite.pragma('foreign_keys = ON'); // Enforce FK constraints
    sqlite.pragma('busy_timeout = 5000'); // Wait up to 5s for write lock (QW-1)

    // Verify connection works
    const result = sqlite.prepare('SELECT 1 as test').get() as { test: number };
    if (result?.test !== 1) {
      return err(createError(BOOTSTRAP_ERROR_CODE, 'SQLite verification query failed', 500));
    }

    return ok(sqlite);
  } catch (error) {
    return err(
      createError(BOOTSTRAP_ERROR_CODE, 'Failed to initialize SQLite', 500, {
        error: String(error),
      })
    );
  }
};

export const applySQLiteToContext = (ctx: BootstrapContext, sqlite: SQLiteDatabase): void => {
  ctx.db = sqlite;
};

// Backwards compatibility aliases
export const initializePGlite = initializeSQLite;
export const applyPGliteToContext = applySQLiteToContext;
