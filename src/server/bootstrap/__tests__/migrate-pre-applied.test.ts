/**
 * F11-17 — `MIGRATIONS_PRE_APPLIED=true` gate.
 *
 * When the Helm pre-upgrade Job has applied migrations out-of-band, the app
 * MUST NOT call the in-process migrator. Otherwise N replicas race the
 * Drizzle advisory lock and one pod may interleave ahead of another. The
 * `migrate-check-only.ts` script (invoked by start.sh and the K8s init
 * container) verifies the schema is current before the app boots.
 *
 * This test exercises the SQLite path of `initializeDatabase()` with the
 * underlying `bun:sqlite` and migration runner mocked, so we can observe
 * call counts without booting a real DB:
 *
 *   - When `MIGRATIONS_PRE_APPLIED!=='true'`, `runMigrations` is called.
 *   - When `MIGRATIONS_PRE_APPLIED==='true'`, `runMigrations` is skipped.
 *
 * Pre-fix (April 29 review HEAD): the gate did not exist; `runMigrations`
 * was always called. This test fails on `main` (call count 1 in both
 * branches) and passes after the F11-17 wiring lands (call count 0 when
 * pre-applied).
 */

import { describe, expect, it, vi } from 'vitest';

// `bun:sqlite` is not resolvable in node-environment unit tests, so mock it
// with a stub object that satisfies the few methods initializeSqlite calls.
vi.mock('bun:sqlite', () => {
  class FakeBunSQLite {
    exec = vi.fn();
    prepare = vi.fn(() => ({ get: () => undefined, all: () => [], run: () => undefined }));
    close = vi.fn();
  }
  return { Database: FakeBunSQLite };
});

// Drizzle's `bun-sqlite` adapter walks the underlying handle on construction;
// stub it out to avoid touching `bun:sqlite` internals.
vi.mock('drizzle-orm/bun-sqlite', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('../../../lib/bootstrap/migrations/runner.js', () => ({
  runMigrations: vi.fn(),
}));
vi.mock('../../../lib/bootstrap/phases/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/bootstrap/phases/schema.js')>();
  return {
    ...actual,
    seedDefaultTeamForExistingTokens: vi.fn(),
  };
});

import { runMigrations } from '../../../lib/bootstrap/migrations/runner.js';
import { initializeDatabase } from '../phases/database.js';
import type { ServerConfig } from '../types.js';

describe('F11-17: MIGRATIONS_PRE_APPLIED gate (SQLite)', () => {
  const baseConfig = {
    dbMode: 'sqlite' as const,
    dbPath: '/tmp/agentpane-test-stub.db',
  } as unknown as ServerConfig;

  it('runs migrations when MIGRATIONS_PRE_APPLIED is unset', async () => {
    const original = process.env.MIGRATIONS_PRE_APPLIED;
    delete process.env.MIGRATIONS_PRE_APPLIED;
    try {
      vi.mocked(runMigrations).mockClear();
      await initializeDatabase(baseConfig);
      expect(runMigrations).toHaveBeenCalledTimes(1);
    } finally {
      if (original !== undefined) process.env.MIGRATIONS_PRE_APPLIED = original;
    }
  });

  it('runs migrations when MIGRATIONS_PRE_APPLIED is "false"', async () => {
    const original = process.env.MIGRATIONS_PRE_APPLIED;
    process.env.MIGRATIONS_PRE_APPLIED = 'false';
    try {
      vi.mocked(runMigrations).mockClear();
      await initializeDatabase(baseConfig);
      expect(runMigrations).toHaveBeenCalledTimes(1);
    } finally {
      if (original !== undefined) {
        process.env.MIGRATIONS_PRE_APPLIED = original;
      } else {
        delete process.env.MIGRATIONS_PRE_APPLIED;
      }
    }
  });

  it('skips migrations when MIGRATIONS_PRE_APPLIED="true"', async () => {
    const original = process.env.MIGRATIONS_PRE_APPLIED;
    process.env.MIGRATIONS_PRE_APPLIED = 'true';
    try {
      vi.mocked(runMigrations).mockClear();
      await initializeDatabase(baseConfig);
      expect(runMigrations).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) {
        process.env.MIGRATIONS_PRE_APPLIED = original;
      } else {
        delete process.env.MIGRATIONS_PRE_APPLIED;
      }
    }
  });
});
