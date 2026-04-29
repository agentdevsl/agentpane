/**
 * F02-20 (arch29-W2-Q): SQLite api_tokens.scope_codespace_id had ON DELETE CASCADE
 * but Drizzle and PG declare ON DELETE SET NULL. Without the runtime v37 fix,
 * deleting a codespace silently revokes API tokens scoped to that codespace
 * on SQLite, while PG preserves them.
 *
 * Red→green: this test FAILS on `main` (the v19-installed FK was CASCADE, so
 * the api_tokens row gets deleted when the codespace is deleted). It PASSES
 * after the runtime v37 rebuild changes the FK to SET NULL — the api_tokens
 * row survives with `scope_codespace_id` set to NULL.
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTokens, codespaces, teams, users } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

async function createUserAndTeam() {
  const db = getTestDb();
  const userId = createId();
  const teamId = createId();
  const githubId = Math.floor(Math.random() * 1_000_000_000);
  await db.insert(users).values({
    id: userId,
    githubId,
    githubLogin: `gh-user-${userId.slice(0, 6)}`,
    name: 'Test User',
    email: `${userId.slice(0, 6)}@example.com`,
  });
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${teamId.slice(0, 6)}`,
    slug: `team-${teamId.slice(0, 6)}`,
  });
  return { userId, teamId };
}

describe('codespace.delete + api_tokens FK behavior (F02-20 / arch29-W2-Q)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await clearTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('FK on api_tokens.scope_codespace_id is ON DELETE SET NULL (not CASCADE)', () => {
    const db = getTestDb();
    // Use a private accessor to read the underlying SQLite handle. Drizzle's
    // run/all wrappers don't expose PRAGMA introspection cleanly.
    const sqliteHandle = (db as any).$client as {
      prepare: (sql: string) => { all: () => Array<{ from: string; on_delete: string }> };
    };
    const fkRows = sqliteHandle.prepare('PRAGMA foreign_key_list(api_tokens)').all();
    const scopeFk = fkRows.find((r) => r.from === 'scope_codespace_id');
    expect(scopeFk, 'scope_codespace_id FK must exist on api_tokens').toBeDefined();
    expect(
      scopeFk?.on_delete,
      'scope_codespace_id FK must be SET NULL (Drizzle + PG behavior); CASCADE silently revokes tokens'
    ).toBe('SET NULL');
  });

  it('deleting a codespace nulls scope_codespace_id on its api_tokens (does not revoke)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject({ name: 'Scope Token Codespace' });
    const { userId, teamId } = await createUserAndTeam();

    // Create an api_token scoped to the codespace.
    const tokenId = createId();
    await db.insert(apiTokens).values({
      id: tokenId,
      userId,
      teamId,
      name: 'scoped-token',
      tokenHash: `hash-${tokenId}`,
      tokenPrefix: 'apt_',
      role: 'developer',
      scopeCodespaceId: codespace.id,
      status: 'active',
    });

    // Sanity: the token exists with the scope set.
    const beforeRow = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, tokenId),
    });
    expect(beforeRow).toBeDefined();
    expect(beforeRow?.scopeCodespaceId).toBe(codespace.id);

    // Delete the codespace.
    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    // Token must SURVIVE with scope_codespace_id set to NULL (not be deleted).
    const afterRow = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, tokenId),
    });
    expect(
      afterRow,
      'api_token must SURVIVE codespace deletion (FK is SET NULL, not CASCADE)'
    ).toBeDefined();
    expect(
      afterRow?.scopeCodespaceId,
      'scope_codespace_id must be nulled after codespace deletion'
    ).toBeNull();
    // Other fields must be preserved.
    expect(afterRow?.id).toBe(tokenId);
    expect(afterRow?.tokenHash).toBe(`hash-${tokenId}`);
    expect(afterRow?.status).toBe('active');
  });

  it('deleting a codespace does not affect api_tokens scoped to other codespaces', async () => {
    const db = getTestDb();
    const codespaceA = await createTestProject({ name: 'Codespace A' });
    const codespaceB = await createTestProject({ name: 'Codespace B' });
    const { userId, teamId } = await createUserAndTeam();

    const tokenAId = createId();
    const tokenBId = createId();
    await db.insert(apiTokens).values({
      id: tokenAId,
      userId,
      teamId,
      name: 'token-a',
      tokenHash: `hash-${tokenAId}`,
      tokenPrefix: 'apt_',
      role: 'developer',
      scopeCodespaceId: codespaceA.id,
      status: 'active',
    });
    await db.insert(apiTokens).values({
      id: tokenBId,
      userId,
      teamId,
      name: 'token-b',
      tokenHash: `hash-${tokenBId}`,
      tokenPrefix: 'apt_',
      role: 'developer',
      scopeCodespaceId: codespaceB.id,
      status: 'active',
    });

    // Delete only codespace A.
    await db.delete(codespaces).where(eq(codespaces.id, codespaceA.id));

    // Token A: nulled scope, but row survives.
    const rowA = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenAId) });
    expect(rowA).toBeDefined();
    expect(rowA?.scopeCodespaceId).toBeNull();

    // Token B: untouched.
    const rowB = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenBId) });
    expect(rowB).toBeDefined();
    expect(rowB?.scopeCodespaceId).toBe(codespaceB.id);
  });
});
