/**
 * Integration tests for `git-token-resolver.ts`.
 *
 * Mirrors the existing unit tests at the integration project level so the
 * lines count toward combined integration+functional coverage. Mocks DB
 * (duck-type), Octokit, and node:child_process.execSync for the path-derive
 * helper.
 *
 * IT-IDs: IT-1880 to IT-1899
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/github/client', () => ({
  getAppOctokit: vi.fn(),
}));

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

import { getAppOctokit } from '../../src/lib/github/client';
import {
  deriveGitHubFromPath,
  type GitTokenResolverDeps,
  parseGitRemoteUrl,
  resolveGitToken,
} from '../../src/lib/sandbox/git-token-resolver';

function createMockDb(findFirstResult: unknown = undefined) {
  return {
    query: {
      githubInstallations: {
        findFirst: vi.fn().mockResolvedValue(findFirstResult),
      },
    },
  } as unknown as GitTokenResolverDeps['db'];
}

function createMockTokenService(opts?: {
  globalToken?: string | null;
  codespaceToken?: string | null;
  globalThrows?: Error;
  codespaceThrows?: Error;
}) {
  return {
    getDecryptedToken: vi.fn(async () => {
      if (opts?.globalThrows) throw opts.globalThrows;
      return opts?.globalToken ?? null;
    }),
    resolveGitHubTokenForCodespace: vi.fn(async () => {
      if (opts?.codespaceThrows) throw opts.codespaceThrows;
      return opts?.codespaceToken ?? null;
    }),
  } as unknown as NonNullable<GitTokenResolverDeps['githubTokenService']>;
}

describe('resolveGitToken (integration)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    execSyncMock.mockReset();
  });

  it('IT-1880: returns null when githubOwner is missing', async () => {
    const db = createMockDb();
    const result = await resolveGitToken(
      { githubOwner: null, githubRepo: 'r', githubInstallationId: null },
      { db }
    );
    expect(result).toBeNull();
  });

  it('IT-1881: returns null when githubRepo is missing', async () => {
    const db = createMockDb();
    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: null, githubInstallationId: null },
      { db }
    );
    expect(result).toBeNull();
  });

  it('IT-1882: returns App installation token when DB and Octokit succeed', async () => {
    const db = createMockDb({ id: 'inst-1', installationId: '12345' });
    const createToken = vi.fn().mockResolvedValue({ data: { token: 'ghs_app' } });
    vi.mocked(getAppOctokit).mockReturnValue({
      rest: { apps: { createInstallationAccessToken: createToken } },
    } as never);

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: 'inst-1' },
      { db }
    );
    expect(result).toEqual({ token: 'ghs_app', owner: 'o', repo: 'r', type: 'app' });
    expect(createToken).toHaveBeenCalledWith({ installation_id: 12345 });
  });

  it('IT-1883: falls through to PAT when installation not in DB', async () => {
    const db = createMockDb(undefined);
    const tokenSvc = createMockTokenService({ globalToken: 'pat-1' });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: 'inst-missing' },
      { db, githubTokenService: tokenSvc }
    );
    expect(result).toEqual({ token: 'pat-1', owner: 'o', repo: 'r', type: 'pat' });
  });

  it('IT-1884: falls through to PAT when installation ID is non-numeric', async () => {
    const db = createMockDb({ id: 'inst-1', installationId: 'abc-not-numeric' });
    const tokenSvc = createMockTokenService({ globalToken: 'pat-2' });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: 'inst-1' },
      { db, githubTokenService: tokenSvc }
    );
    expect(result?.type).toBe('pat');
  });

  it('IT-1885: falls through to PAT when GitHub App is not configured', async () => {
    const db = createMockDb({ id: 'inst-1', installationId: '12345' });
    vi.mocked(getAppOctokit).mockImplementation(() => {
      throw new Error('GitHub App not configured');
    });
    const tokenSvc = createMockTokenService({ globalToken: 'pat-3' });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: 'inst-1' },
      { db, githubTokenService: tokenSvc }
    );
    expect(result?.type).toBe('pat');
  });

  it('IT-1886: logs and falls through when createInstallationAccessToken throws', async () => {
    const db = createMockDb({ id: 'inst-1', installationId: '12345' });
    vi.mocked(getAppOctokit).mockReturnValue({
      rest: {
        apps: {
          createInstallationAccessToken: vi.fn().mockRejectedValue(new Error('rate limit')),
        },
      },
    } as never);
    const tokenSvc = createMockTokenService({ globalToken: 'pat-4' });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: 'inst-1' },
      { db, githubTokenService: tokenSvc }
    );
    expect(result?.type).toBe('pat');
  });

  it('IT-1887: uses team-scoped resolver when codespaceId provided', async () => {
    const db = createMockDb();
    const tokenSvc = createMockTokenService({ codespaceToken: 'team-pat' });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: null, codespaceId: 'cs-1' },
      { db, githubTokenService: tokenSvc }
    );
    expect(result?.token).toBe('team-pat');
    expect(tokenSvc.resolveGitHubTokenForCodespace).toHaveBeenCalledWith('cs-1');
    expect(tokenSvc.getDecryptedToken).not.toHaveBeenCalled();
  });

  it('IT-1888: returns null when token service returns null', async () => {
    const db = createMockDb();
    const tokenSvc = createMockTokenService({ globalToken: null });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: null },
      { db, githubTokenService: tokenSvc }
    );
    expect(result).toBeNull();
  });

  it('IT-1889: returns null when token service throws (logged)', async () => {
    const db = createMockDb();
    const tokenSvc = createMockTokenService({ globalThrows: new Error('crypto error') });

    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: null },
      { db, githubTokenService: tokenSvc }
    );
    expect(result).toBeNull();
  });

  it('IT-1890: returns null when no service is provided and App fails', async () => {
    const db = createMockDb();
    const result = await resolveGitToken(
      { githubOwner: 'o', githubRepo: 'r', githubInstallationId: null },
      { db }
    );
    expect(result).toBeNull();
  });
});

describe('parseGitRemoteUrl', () => {
  it('IT-1893: parses HTTPS URL with .git suffix', () => {
    expect(parseGitRemoteUrl('https://github.com/foo/bar.git')).toEqual({
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('IT-1894: parses HTTPS URL without .git suffix', () => {
    expect(parseGitRemoteUrl('https://github.com/foo/bar')).toEqual({
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('IT-1895: parses SSH URL', () => {
    expect(parseGitRemoteUrl('git@github.com:foo/bar.git')).toEqual({
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('IT-1896: returns null for non-GitHub URLs', () => {
    expect(parseGitRemoteUrl('https://gitlab.com/foo/bar.git')).toBeNull();
  });

  it('IT-1897: returns null for malformed URLs', () => {
    expect(parseGitRemoteUrl('not a url at all')).toBeNull();
  });
});

describe('deriveGitHubFromPath', () => {
  it('IT-1898: returns owner/repo when execSync succeeds', () => {
    execSyncMock.mockReturnValueOnce('https://github.com/foo/bar.git\n');
    expect(deriveGitHubFromPath('/some/path')).toEqual({ owner: 'foo', repo: 'bar' });
    expect(execSyncMock).toHaveBeenCalled();
  });

  it('IT-1899: returns null when execSync throws (not a git repo)', () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    expect(deriveGitHubFromPath('/no-repo')).toBeNull();
  });

  it('IT-1900: returns null when remote URL not parsable as GitHub', () => {
    execSyncMock.mockReturnValueOnce('https://gitlab.com/foo/bar.git\n');
    expect(deriveGitHubFromPath('/some/path')).toBeNull();
  });
});
