/**
 * F02-01: SQLite ↔ PostgreSQL migration parity.
 *
 * This test invokes the `scripts/check-migration-parity.ts` guard script
 * and asserts it exits zero. The guard verifies that every SQLite
 * drizzle-kit migration file has a matching PostgreSQL migration
 * (either a per-change file on disk or is covered by the pre-catchup
 * allowlist consolidated into 0004_schema_catchup.sql).
 *
 * CI runs this test to catch the "forgot to port to PG" mistake before
 * merge.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/check-migration-parity.ts');

describe('Migration parity SQLite ↔ PostgreSQL (F02-01)', () => {
  it('every SQLite migration has a matching PostgreSQL migration', () => {
    const result = spawnSync('bun', ['run', SCRIPT], {
      encoding: 'utf-8',
      env: process.env,
    });
    if (result.status !== 0) {
      // Surface the captured script output so a failure is actionable.
      console.error('--- migration-parity STDOUT ---\n', result.stdout);
      console.error('--- migration-parity STDERR ---\n', result.stderr);
    }
    expect(result.status, `check-migration-parity exited with code ${result.status}`).toBe(0);
    expect(result.stdout).toContain('PASS: every SQLite migration has a matching PG migration');
  });
});
