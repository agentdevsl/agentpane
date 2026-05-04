import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../../db/schema/index.js', () => ({
  githubInstallations: { id: 'mock_id_column' },
}));

vi.mock('../../github/client.js', () => ({
  getAppOctokit: vi.fn(),
}));

// drizzle-orm eq() is used for query building; provide a pass-through mock
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ _col, _val: val })),
}));

import { getAppOctokit } from '../../github/client.js';
import type { GitTokenResolverDeps } from '../git-token-resolver.js';
import { resolveGitToken } from '../git-token-resolver.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a minimal mock Database whose `query.githubInstallations.findFirst` is controllable. */
function createMockDb(findFirstResult: unknown = undefined) {
  return {
    query: {
      githubInstallations: {
        findFirst: vi.fn().mockResolvedValue(findFirstResult),
      },
    },
  } as unknown as GitTokenResolverDeps['db'];
}

/** Build a mock GitHubTokenService with controllable `getDecryptedToken`
 * and `resolveGitHubTokenForCodespace`. The team-scoped resolver is exercised
 * when callers pass a `codespaceId` through `resolveGitToken`. */
function createMockTokenService(
  getDecryptedTokenImpl?: () => Promise<string | null>,
  resolveForCodespaceImpl?: (codespaceId: string) => Promise<string | null>
) {
  return {
    getDecryptedToken: vi.fn(getDecryptedTokenImpl ?? (async () => null)),
    resolveGitHubTokenForCodespace: vi.fn(resolveForCodespaceImpl ?? (async () => null)),
  } as unknown as NonNullable<GitTokenResolverDeps['githubTokenService']>;
}

// ── Test suite ───────────────────────────────────────────────────────

describe('resolveGitToken', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. GitHub App path success
  // ────────────────────────────────────────────────────────────────────
  it('returns token from GitHub App installation when everything succeeds', async () => {
    const installation = {
      id: 'inst-1',
      installationId: '12345',
      accountLogin: 'my-org',
      accountType: 'Organization',
      status: 'active',
    };
    const db = createMockDb(installation);

    const mockCreateToken = vi.fn().mockResolvedValue({
      data: { token: 'ghs_installation_token_abc' },
    });
    const mockOctokit = {
      rest: { apps: { createInstallationAccessToken: mockCreateToken } },
    };
    vi.mocked(getAppOctokit).mockReturnValue(mockOctokit as any);

    const result = await resolveGitToken(
      {
        githubOwner: 'my-org',
        githubRepo: 'my-repo',
        githubInstallationId: 'inst-1',
      },
      { db }
    );

    expect(result).toEqual({
      token: 'ghs_installation_token_abc',
      owner: 'my-org',
      repo: 'my-repo',
      type: 'app',
    });
    expect(mockCreateToken).toHaveBeenCalledWith({ installation_id: 12345 });
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. Installation not found in DB → falls through to PAT
  // ────────────────────────────────────────────────────────────────────
  it('falls through to PAT when installation record is not found in DB', async () => {
    const db = createMockDb(undefined); // findFirst returns undefined
    const tokenService = createMockTokenService(async () => 'ghp_pat_fallback');

    const result = await resolveGitToken(
      {
        githubOwner: 'owner',
        githubRepo: 'repo',
        githubInstallationId: 'nonexistent-id',
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_pat_fallback',
      owner: 'owner',
      repo: 'repo',
      type: 'pat',
    });
    expect(tokenService.getDecryptedToken).toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. getAppOctokit() throws 'not configured' → falls through to PAT
  // ────────────────────────────────────────────────────────────────────
  it('falls through to PAT with config warning when getAppOctokit throws "not configured"', async () => {
    const installation = {
      id: 'inst-2',
      installationId: '999',
      accountLogin: 'org',
      accountType: 'Organization',
      status: 'active',
    };
    const db = createMockDb(installation);
    const tokenService = createMockTokenService(async () => 'ghp_pat_token');

    vi.mocked(getAppOctokit).mockImplementation(() => {
      throw new Error('GitHub App credentials not configured (GITHUB_APP_ID, GITHUB_PRIVATE_KEY)');
    });

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: 'inst-2',
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_pat_token',
      owner: 'org',
      repo: 'repo',
      type: 'pat',
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. createInstallationAccessToken API failure → falls through to PAT
  // ────────────────────────────────────────────────────────────────────
  it('falls through to PAT with API error warning when createInstallationAccessToken fails', async () => {
    const installation = {
      id: 'inst-3',
      installationId: '777',
      accountLogin: 'org',
      accountType: 'Organization',
      status: 'active',
    };
    const db = createMockDb(installation);
    const tokenService = createMockTokenService(async () => 'ghp_fallback_api_fail');

    const mockCreateToken = vi.fn().mockRejectedValue(new Error('API rate limit exceeded'));
    const mockOctokit = {
      rest: { apps: { createInstallationAccessToken: mockCreateToken } },
    };
    vi.mocked(getAppOctokit).mockReturnValue(mockOctokit as any);

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: 'inst-3',
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_fallback_api_fail',
      owner: 'org',
      repo: 'repo',
      type: 'pat',
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. NaN installationId → warns and falls through to PAT
  // ────────────────────────────────────────────────────────────────────
  it('warns and falls through to PAT when installation has non-numeric installationId', async () => {
    const installation = {
      id: 'inst-nan',
      installationId: 'not-a-number',
      accountLogin: 'org',
      accountType: 'Organization',
      status: 'active',
    };
    const db = createMockDb(installation);
    const tokenService = createMockTokenService(async () => 'ghp_nan_fallback');

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: 'inst-nan',
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_nan_fallback',
      owner: 'org',
      repo: 'repo',
      type: 'pat',
    });
    // getAppOctokit should NOT have been called since we bailed on NaN
    expect(getAppOctokit).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. PAT success (no installation ID)
  // ────────────────────────────────────────────────────────────────────
  it('returns token from PAT when no githubInstallationId is set', async () => {
    const db = createMockDb();
    const tokenService = createMockTokenService(async () => 'ghp_direct_pat');

    const result = await resolveGitToken(
      {
        githubOwner: 'user',
        githubRepo: 'project',
        githubInstallationId: null,
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_direct_pat',
      owner: 'user',
      repo: 'project',
      type: 'pat',
    });
    // DB query for installations should NOT be called
    expect(db.query.githubInstallations.findFirst).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────────
  // 7. PAT returns null → returns null
  // ────────────────────────────────────────────────────────────────────
  it('returns null when PAT getDecryptedToken returns null', async () => {
    const db = createMockDb();
    const tokenService = createMockTokenService(async () => null);

    const result = await resolveGitToken(
      {
        githubOwner: 'user',
        githubRepo: 'repo',
        githubInstallationId: null,
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // 8. PAT throws → returns null
  // ────────────────────────────────────────────────────────────────────
  it('returns null when PAT getDecryptedToken throws an error', async () => {
    const db = createMockDb();
    const tokenService = createMockTokenService(async () => {
      throw new Error('Decryption failed');
    });

    const result = await resolveGitToken(
      {
        githubOwner: 'user',
        githubRepo: 'repo',
        githubInstallationId: null,
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // 9. No GitHub owner/repo → returns null early
  // ────────────────────────────────────────────────────────────────────
  it('returns null early when githubOwner is null', async () => {
    const db = createMockDb();
    const tokenService = createMockTokenService(async () => 'ghp_should_not_reach');

    const result = await resolveGitToken(
      {
        githubOwner: null,
        githubRepo: 'repo',
        githubInstallationId: null,
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toBeNull();
    expect(tokenService.getDecryptedToken).not.toHaveBeenCalled();
  });

  it('returns null early when githubRepo is null', async () => {
    const db = createMockDb();
    const tokenService = createMockTokenService(async () => 'ghp_should_not_reach');

    const result = await resolveGitToken(
      {
        githubOwner: 'owner',
        githubRepo: null,
        githubInstallationId: null,
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toBeNull();
    expect(tokenService.getDecryptedToken).not.toHaveBeenCalled();
  });

  it('returns null early when both githubOwner and githubRepo are null', async () => {
    const db = createMockDb();

    const result = await resolveGitToken(
      {
        githubOwner: null,
        githubRepo: null,
        githubInstallationId: null,
      },
      { db }
    );

    expect(result).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // 10. Both paths fail → returns null
  // ────────────────────────────────────────────────────────────────────
  it('returns null when installation token fails AND PAT also fails', async () => {
    // Installation path: getAppOctokit throws a non-config error
    const installation = {
      id: 'inst-fail',
      installationId: '42',
      accountLogin: 'org',
      accountType: 'Organization',
      status: 'active',
    };
    const db = createMockDb(installation);

    const mockCreateToken = vi.fn().mockRejectedValue(new Error('Server error'));
    const mockOctokit = {
      rest: { apps: { createInstallationAccessToken: mockCreateToken } },
    };
    vi.mocked(getAppOctokit).mockReturnValue(mockOctokit as any);

    // PAT path: getDecryptedToken throws
    const tokenService = createMockTokenService(async () => {
      throw new Error('Token storage corrupted');
    });

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: 'inst-fail',
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toBeNull();
  });

  it('returns null when installation not found AND no githubTokenService provided', async () => {
    const db = createMockDb(undefined);

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: 'missing-inst',
      },
      { db } // no githubTokenService
    );

    expect(result).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // Team-scoped PAT resolution
  // ────────────────────────────────────────────────────────────────────
  it('uses resolveGitHubTokenForCodespace when codespaceId is provided', async () => {
    const db = createMockDb(undefined);
    const teamScoped = vi.fn().mockResolvedValue('ghp_team_specific_token');
    const global = vi.fn().mockResolvedValue('ghp_global_token');
    const tokenService = {
      getDecryptedToken: global,
      resolveGitHubTokenForCodespace: teamScoped,
    } as unknown as NonNullable<GitTokenResolverDeps['githubTokenService']>;

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: null,
        codespaceId: 'codespace-abc',
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_team_specific_token',
      owner: 'org',
      repo: 'repo',
      type: 'pat',
    });
    expect(teamScoped).toHaveBeenCalledWith('codespace-abc');
    expect(global).not.toHaveBeenCalled();
  });

  it('falls back to global getDecryptedToken when codespaceId is omitted', async () => {
    const db = createMockDb(undefined);
    const teamScoped = vi.fn().mockResolvedValue('ghp_team_specific_token');
    const global = vi.fn().mockResolvedValue('ghp_global_token');
    const tokenService = {
      getDecryptedToken: global,
      resolveGitHubTokenForCodespace: teamScoped,
    } as unknown as NonNullable<GitTokenResolverDeps['githubTokenService']>;

    const result = await resolveGitToken(
      {
        githubOwner: 'org',
        githubRepo: 'repo',
        githubInstallationId: null,
      },
      { db, githubTokenService: tokenService }
    );

    expect(result).toEqual({
      token: 'ghp_global_token',
      owner: 'org',
      repo: 'repo',
      type: 'pat',
    });
    expect(global).toHaveBeenCalled();
    expect(teamScoped).not.toHaveBeenCalled();
  });
});
