import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubTokens } from '../../src/db/schema';
import { encryptToken } from '../../src/lib/crypto/server-encryption';
import { GitHubTokenService } from '../../src/services/github-token.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const octokitMocks = vi.hoisted(() => ({
  getAuthenticated: vi.fn(),
  getRepo: vi.fn(),
  listBranches: vi.fn(),
  listForAuthenticatedUser: vi.fn(),
  listForOrg: vi.fn(),
  listOrgs: vi.fn(),
  createUsingTemplate: vi.fn(),
}));

vi.mock('octokit', () => {
  class MockOctokit {
    rest = {
      users: { getAuthenticated: octokitMocks.getAuthenticated },
      repos: {
        get: octokitMocks.getRepo,
        listBranches: octokitMocks.listBranches,
        listForAuthenticatedUser: octokitMocks.listForAuthenticatedUser,
        listForOrg: octokitMocks.listForOrg,
        createUsingTemplate: octokitMocks.createUsingTemplate,
      },
      orgs: { listForAuthenticatedUser: octokitMocks.listOrgs },
    };
  }

  return { Octokit: MockOctokit };
});

function repo(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    name: 'agentpane',
    full_name: 'openai/agentpane',
    private: false,
    owner: { login: 'openai', avatar_url: 'https://example.test/openai.png' },
    default_branch: 'main',
    description: 'AgentPane test repo',
    clone_url: 'https://github.com/openai/agentpane.git',
    updated_at: '2026-05-08T00:00:00Z',
    stargazers_count: 42,
    is_template: false,
    ...overrides,
  };
}

async function insertToken(
  db: ReturnType<typeof getTestDb>,
  token = `ghp_${'x'.repeat(20)}fixture`
) {
  const [saved] = await db
    .insert(githubTokens)
    .values({
      encryptedToken: encryptToken(token),
      tokenType: 'pat',
      githubLogin: 'testuser',
      githubId: '12345',
      isValid: true,
    })
    .returning();

  if (!saved) throw new Error('Failed to insert GitHub token fixture');
  return saved;
}

describe('GitHubTokenService Octokit integration', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: GitHubTokenService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await clearTestDatabase();
    service = new GitHubTokenService(db as any);

    octokitMocks.getAuthenticated.mockResolvedValue({
      data: { login: 'testuser', id: 12345, avatar_url: 'https://example.test/user.png' },
    });
    octokitMocks.getRepo.mockResolvedValue({ data: repo() });
    octokitMocks.listBranches.mockResolvedValue({
      data: [
        { name: 'main', protected: true },
        { name: 'feature/integration', protected: false },
      ],
    });
    octokitMocks.listForAuthenticatedUser.mockResolvedValue({
      data: [repo({ id: 201, name: 'user-repo', full_name: 'testuser/user-repo' })],
    });
    octokitMocks.listForOrg.mockResolvedValue({
      data: [repo({ id: 301, name: 'org-repo', full_name: 'openai/org-repo' })],
    });
    octokitMocks.listOrgs.mockResolvedValue({
      data: [{ login: 'openai', avatar_url: 'https://example.test/openai.png' }],
    });
    octokitMocks.createUsingTemplate.mockResolvedValue({
      data: {
        clone_url: 'https://github.com/testuser/from-template.git',
        full_name: 'testuser/from-template',
      },
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await clearTestDatabase();
  });

  it('returns NOT_FOUND for repository APIs when no token is configured', async () => {
    const result = await service.getRepository('openai', 'agentpane');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
    expect(octokitMocks.getRepo).not.toHaveBeenCalled();
  });

  it('maps repository, branch, user repository, organization, and owner repository responses', async () => {
    await insertToken(db);

    const repository = await service.getRepository('openai', 'agentpane');
    const branches = await service.listBranches('openai', 'agentpane');
    const userRepos = await service.listUserRepos();
    const orgs = await service.listUserOrgs();
    const ownRepos = await service.listReposForOwner('testuser');
    const orgRepos = await service.listReposForOwner('openai');

    expect(repository.ok && repository.value.full_name).toBe('openai/agentpane');
    expect(branches.ok && branches.value).toEqual([
      { name: 'main', protected: true },
      { name: 'feature/integration', protected: false },
    ]);
    expect(userRepos.ok && userRepos.value[0]?.full_name).toBe('testuser/user-repo');
    expect(orgs.ok && orgs.value.map((org) => org.login)).toEqual(['testuser', 'openai']);
    expect(ownRepos.ok && ownRepos.value[0]?.full_name).toBe('testuser/user-repo');
    expect(orgRepos.ok && orgRepos.value[0]?.full_name).toBe('openai/org-repo');
    expect(octokitMocks.listForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ org: 'openai' })
    );
  });

  it('creates repositories from templates and maps duplicate-name validation errors', async () => {
    await insertToken(db);

    const created = await service.createRepoFromTemplate({
      templateOwner: 'openai',
      templateRepo: 'template',
      name: 'from-template',
      owner: 'testuser',
      description: 'Created from template',
      isPrivate: true,
    });

    expect(created.ok && created.value).toEqual({
      cloneUrl: 'https://github.com/testuser/from-template.git',
      fullName: 'testuser/from-template',
    });
    expect(octokitMocks.createUsingTemplate).toHaveBeenCalledWith({
      template_owner: 'openai',
      template_repo: 'template',
      name: 'from-template',
      owner: 'testuser',
      description: 'Created from template',
      private: true,
      include_all_branches: false,
    });

    const duplicate = new Error('already exists') as Error & { status: number };
    duplicate.status = 422;
    octokitMocks.createUsingTemplate.mockRejectedValueOnce(duplicate);

    const duplicateResult = await service.createRepoFromTemplate({
      templateOwner: 'openai',
      templateRepo: 'template',
      name: 'from-template',
    });

    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) {
      expect(duplicateResult.error.code).toBe('VALIDATION_FAILED');
      expect(duplicateResult.error.message).toContain('already exists');
    }
  });

  it('marks only the failing token invalid when GitHub returns 401', async () => {
    const token = await insertToken(db);
    const unauthorized = new Error('Bad credentials') as Error & { status: number };
    unauthorized.status = 401;
    octokitMocks.getRepo.mockRejectedValueOnce(unauthorized);

    const result = await service.getRepository('openai', 'agentpane');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(result.error.message).toContain('no longer valid');
    }
    const updated = await db.query.githubTokens.findFirst();
    expect(updated?.id).toBe(token.id);
    expect(updated?.isValid).toBe(false);
  });
});
