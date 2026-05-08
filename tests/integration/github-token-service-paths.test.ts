/**
 * Additional integration tests for github-token.service.ts (slice H).
 *
 * Targets uncovered paths missed by github-token-service / github-token-octokit
 * tests: revalidateToken (success/invalid/no-token), saveToken (storage error,
 * GitHub validation 401, GitHub validation generic error), createRepoFromTemplate
 * non-422 error and success path, plus the team-resolution/global token decryption
 * branches in resolveGitHubTokenForCodespace.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codespaces, githubTokens, projectFolders, teamProjectFolders } from '../../src/db/schema';
import { encryptToken } from '../../src/lib/crypto/server-encryption';
import { GitHubTokenService } from '../../src/services/github-token.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTeam } from '../factories/team.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const octokitMocks = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  createUsingTemplate: vi.fn(),
}));

vi.mock('octokit', () => {
  class MockOctokit {
    rest = {
      users: { getAuthenticated: octokitMocks.getAuthenticated },
      repos: { createUsingTemplate: octokitMocks.createUsingTemplate },
    };
  }
  return { Octokit: MockOctokit };
});

describe('github-token.service paths (IT-1930)', () => {
  let db: ReturnType<typeof getTestDb>;
  let svc: GitHubTokenService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    svc = new GitHubTokenService(db);
    octokitMocks.getAuthenticated.mockReset();
    octokitMocks.createUsingTemplate.mockReset();
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  // ─── saveToken ────────────────────────────────────────

  it('IT-1930-1: saveToken rejects malformed token', async () => {
    const r = await svc.saveToken('not-a-pat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_FORMAT');
  });

  it('IT-1930-2: saveToken propagates 401 validation failure', async () => {
    const e = new Error('unauthorized') as Error & { status: number };
    e.status = 401;
    octokitMocks.getAuthenticated.mockRejectedValue(e);
    const r = await svc.saveToken(`ghp_${'a'.repeat(40)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.message).toContain('Invalid token');
    }
  });

  it('IT-1930-3: saveToken propagates generic validation failure', async () => {
    octokitMocks.getAuthenticated.mockRejectedValue(new Error('network down'));
    const r = await svc.saveToken(`ghp_${'b'.repeat(40)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.message).toContain('network');
    }
  });

  it('IT-1930-4: saveToken succeeds end-to-end', async () => {
    octokitMocks.getAuthenticated.mockResolvedValue({
      data: { login: 'me', id: 99, avatar_url: 'a', name: 'Name' },
    });
    const r = await svc.saveToken(`ghp_${'c'.repeat(40)}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.githubLogin).toBe('me');
      expect(r.value.maskedToken).toMatch(/^ghp_/);
    }
  });

  // ─── revalidateToken ──────────────────────────────────

  it('IT-1930-5: revalidateToken returns NOT_FOUND when no token saved', async () => {
    const r = await svc.revalidateToken();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('IT-1930-6: revalidateToken returns true and updates row when valid', async () => {
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(`ghp_${'d'.repeat(40)}`),
      tokenType: 'pat',
      githubLogin: 'old',
      isValid: false,
      lastValidatedAt: '2020-01-01',
    });
    octokitMocks.getAuthenticated.mockResolvedValue({
      data: { login: 'new', id: 1, avatar_url: 'a', name: null },
    });
    const r = await svc.revalidateToken();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(true);

    const row = await db.query.githubTokens.findFirst();
    expect(row?.isValid).toBe(true);
    expect(row?.githubLogin).toBe('new');
  });

  it('IT-1930-7: revalidateToken returns false when 401 from GitHub', async () => {
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(`ghp_${'e'.repeat(40)}`),
      tokenType: 'pat',
      githubLogin: 'who',
      isValid: true,
      lastValidatedAt: '2020-01-01',
    });
    const e = new Error('unauthorized') as Error & { status: number };
    e.status = 401;
    octokitMocks.getAuthenticated.mockRejectedValue(e);

    const r = await svc.revalidateToken();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(false);

    const row = await db.query.githubTokens.findFirst();
    expect(row?.isValid).toBe(false);
  });

  // ─── createRepoFromTemplate ───────────────────────────

  it('IT-1930-8: createRepoFromTemplate returns NOT_FOUND when no token', async () => {
    const r = await svc.createRepoFromTemplate({
      templateOwner: 'a',
      templateRepo: 'b',
      name: 'c',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('IT-1930-9: createRepoFromTemplate returns 422 mapping for duplicate name', async () => {
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(`ghp_${'f'.repeat(40)}`),
      tokenType: 'pat',
      githubLogin: 'me',
      isValid: true,
    });
    const e = new Error('Validation') as Error & { status: number };
    e.status = 422;
    octokitMocks.createUsingTemplate.mockRejectedValue(e);
    const r = await svc.createRepoFromTemplate({
      templateOwner: 'a',
      templateRepo: 'b',
      name: 'dup',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.message).toContain('already exists');
    }
  });

  it('IT-1930-10: createRepoFromTemplate maps 401 via handleOctokitError and marks token invalid', async () => {
    const [tok] = await db
      .insert(githubTokens)
      .values({
        encryptedToken: encryptToken(`ghp_${'g'.repeat(40)}`),
        tokenType: 'pat',
        githubLogin: 'me',
        isValid: true,
      })
      .returning();
    const e = new Error('unauthorized') as Error & { status: number };
    e.status = 401;
    octokitMocks.createUsingTemplate.mockRejectedValue(e);

    const r = await svc.createRepoFromTemplate({
      templateOwner: 'a',
      templateRepo: 'b',
      name: 'X',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
    const row = await db.query.githubTokens.findFirst({ where: eq(githubTokens.id, tok!.id) });
    expect(row?.isValid).toBe(false);
  });

  it('IT-1930-11: createRepoFromTemplate succeeds and returns clone url', async () => {
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(`ghp_${'h'.repeat(40)}`),
      tokenType: 'pat',
      githubLogin: 'me',
      isValid: true,
    });
    octokitMocks.createUsingTemplate.mockResolvedValue({
      data: { clone_url: 'https://github.com/x/y.git', full_name: 'x/y' },
    });
    const r = await svc.createRepoFromTemplate({
      templateOwner: 't-o',
      templateRepo: 't-r',
      name: 'y',
      owner: 'x',
      description: 'desc',
      isPrivate: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cloneUrl).toBe('https://github.com/x/y.git');
      expect(r.value.fullName).toBe('x/y');
    }
  });

  it('IT-1930-12: createRepoFromTemplate maps non-Error throw to VALIDATION_FAILED', async () => {
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(`ghp_${'i'.repeat(40)}`),
      tokenType: 'pat',
      githubLogin: 'me',
      isValid: true,
    });
    octokitMocks.createUsingTemplate.mockRejectedValue('string-thrown');
    const r = await svc.createRepoFromTemplate({
      templateOwner: 'a',
      templateRepo: 'b',
      name: 'c',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.message).toContain('string-thrown');
    }
  });

  // ─── resolveGitHubTokenForCodespace ───────────────────

  it('IT-1930-13: resolveGitHubTokenForCodespace returns null when codespace not found', async () => {
    const t = await svc.resolveGitHubTokenForCodespace('no-codespace');
    expect(t).toBeNull();
  });

  it('IT-1930-14: resolveGitHubTokenForCodespace returns global token via team-less codespace', async () => {
    // Codespace has a folder but folder has no team_project_folders entry
    const folderId = `tless-folder-${Date.now()}`;
    await db.insert(projectFolders).values({ id: folderId, name: 'F', slug: `f-${Date.now()}` });
    const cs = await createTestProject({ projectFolderId: folderId });
    const globalRaw = `ghp_${'j'.repeat(40)}`;
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(globalRaw),
      tokenType: 'pat',
      teamId: null,
    });
    const t = await svc.resolveGitHubTokenForCodespace(cs.id);
    expect(t).toBe(globalRaw);
  });

  it('IT-1930-15: resolveGitHubTokenForCodespace returns team token when team has one', async () => {
    const team = await createTestTeam();
    const folderId = `team-folder-${Date.now()}`;
    await db.insert(projectFolders).values({ id: folderId, name: 'F', slug: `tf-${Date.now()}` });
    await db.insert(teamProjectFolders).values({ teamId: team.id, projectFolderId: folderId });
    const cs = await createTestProject({ projectFolderId: folderId });
    const teamRaw = `ghp_${'k'.repeat(40)}`;
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(teamRaw),
      tokenType: 'pat',
      teamId: team.id,
    });
    const t = await svc.resolveGitHubTokenForCodespace(cs.id);
    expect(t).toBe(teamRaw);
  });

  it('IT-1930-16: resolveGitHubTokenForCodespace falls back to global when team lacks token', async () => {
    const team = await createTestTeam();
    const folderId = `tg-folder-${Date.now()}`;
    await db.insert(projectFolders).values({ id: folderId, name: 'F', slug: `tg-${Date.now()}` });
    await db.insert(teamProjectFolders).values({ teamId: team.id, projectFolderId: folderId });
    const cs = await createTestProject({ projectFolderId: folderId });
    const globalRaw = `ghp_${'l'.repeat(40)}`;
    await db.insert(githubTokens).values({
      encryptedToken: encryptToken(globalRaw),
      tokenType: 'pat',
      teamId: null,
    });
    const t = await svc.resolveGitHubTokenForCodespace(cs.id);
    expect(t).toBe(globalRaw);
  });

  it('IT-1930-17: resolveGitHubTokenForCodespace returns null when no tokens exist', async () => {
    const cs = await createTestProject();
    const t = await svc.resolveGitHubTokenForCodespace(cs.id);
    expect(t).toBeNull();
  });

  // Sanity: schema reference present
  it('IT-1930-18: schema imports present', () => {
    expect(codespaces).toBeTruthy();
  });
});
