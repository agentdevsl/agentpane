/**
 * Regression: SQLite data directory resolution
 *
 * Caught by user (2026-05-09) running `npm run dev` from a git worktree at
 * `.worktrees/coverage-F/`. The bootstrap silently created a fresh empty
 * database at `<worktree>/data/agentpane.db` instead of the developer's
 * actual ~9MB database at `<repo>/data/agentpane.db`. The setup wizard
 * appeared as if no data existed.
 *
 * Root cause: `src/lib/bootstrap/phases/sqlite.ts` resolves `dataDir` from
 * `process.env.SQLITE_DATA_DIR ?? './data'`. When the dev server runs from
 * any CWD other than the original repo root (worktree, monorepo subdir,
 * release tarball), the relative `./data` resolves to a different location
 * and a fresh database is created. The bootstrap log printed the resolved
 * `dbPath` but only as a debug-level breadcrumb; the user did not notice.
 *
 * These tests prove the contract that future refactors must preserve:
 *
 *   1. When `SQLITE_DATA_DIR` is set, the database file MUST be created
 *      at `<SQLITE_DATA_DIR>/agentpane.db` — never at `./data`.
 *   2. When `SQLITE_DATA_DIR` is unset, the bootstrap MUST resolve to a
 *      `./data` directory relative to CWD (existing default behaviour).
 *   3. Mirror invariant for `getServerEncryptionKeyDir()`
 *      (`src/lib/crypto/server-encryption.ts`) — the encryption key is
 *      stored alongside the database; if these two diverge, the encrypted
 *      tokens become unreadable.
 *
 * If you are refactoring `initializeSQLite()` and one of these tests fails,
 * the fix is almost certainly to read `process.env.SQLITE_DATA_DIR` again,
 * not to update the test to match.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSQLite } from '../../src/lib/bootstrap/phases/sqlite';

describe('initializeSQLite — data directory resolution (regression IT-1990)', () => {
  let tmpDataDir: string;
  let originalCwd: string;
  let cwdScratch: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'agentpane-sqlite-data-'));
    cwdScratch = mkdtempSync(join(tmpdir(), 'agentpane-cwd-'));
    originalCwd = process.cwd();
    // Move CWD somewhere predictable so the "default ./data" branch
    // resolves to a temp location and we can assert it independently
    // of the test runner's CWD.
    process.chdir(cwdScratch);
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDataDir, { recursive: true, force: true });
    rmSync(cwdScratch, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('IT-1990-1 honors SQLITE_DATA_DIR and creates agentpane.db there, not in ./data', async () => {
    vi.stubEnv('SQLITE_DATA_DIR', tmpDataDir);

    const result = await initializeSQLite();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedAbs = resolvePath(tmpDataDir, 'agentpane.db');
    const wrongCwdRelative = resolvePath(cwdScratch, 'data', 'agentpane.db');

    expect(existsSync(expectedAbs)).toBe(true);
    expect(existsSync(wrongCwdRelative)).toBe(false);
    expect(existsSync(resolvePath(cwdScratch, 'data'))).toBe(false);

    // Sanity: connection works against the env-pointed file.
    const probe = result.value.prepare('SELECT 1 AS one').get() as { one: number };
    expect(probe.one).toBe(1);
    result.value.close();
  });

  it('IT-1990-2 falls back to ./data (CWD-relative) when SQLITE_DATA_DIR is unset', async () => {
    // Explicitly clear the env var: parent shells may have leaked it.
    vi.stubEnv('SQLITE_DATA_DIR', '');

    const result = await initializeSQLite();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedDefault = resolvePath(cwdScratch, 'data', 'agentpane.db');
    expect(existsSync(expectedDefault)).toBe(true);
    expect(existsSync(resolvePath(tmpDataDir, 'agentpane.db'))).toBe(false);

    result.value.close();
  });

  it('IT-1990-3 creates the data directory if it does not exist (mkdir recursive)', async () => {
    const nestedDir = join(tmpDataDir, 'nested', 'deeper', 'data');
    expect(existsSync(nestedDir)).toBe(false);

    vi.stubEnv('SQLITE_DATA_DIR', nestedDir);

    const result = await initializeSQLite();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(nestedDir, 'agentpane.db'))).toBe(true);
    result.value.close();
  });

  it('IT-1990-4 server-encryption module reads the same SQLITE_DATA_DIR (must not diverge)', async () => {
    // Encryption key is colocated with the DB by design — if these helpers
    // diverge, encrypted tokens become unreadable on a fresh dev server in
    // a worktree. The module exposes only encrypt/decrypt; we verify the
    // dir-resolution invariant through the source contract instead of a
    // private helper.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(resolvePath(originalCwd, 'src/lib/crypto/server-encryption.ts'), 'utf8')
    );
    expect(src).toContain('process.env.SQLITE_DATA_DIR');
    expect(src).toContain("'./data'");
  });
});
