import { eq, inArray, isNull } from 'drizzle-orm';
import { Octokit } from 'octokit';
import { githubTokens, teamProjects } from '../db/schema';
import {
  decryptToken,
  encryptToken,
  isValidPATFormat,
  maskToken,
} from '../lib/crypto/server-encryption.js';
import { createLogger } from '../lib/logging/logger';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

const log = createLogger('GitHubTokenService');

export type GitHubTokenError =
  | { code: 'INVALID_FORMAT'; message: string }
  | { code: 'VALIDATION_FAILED'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'STORAGE_ERROR'; message: string };

export type ValidatedUser = {
  login: string;
  id: number;
  avatarUrl: string;
  name: string | null;
};

export type TokenInfo = {
  id: string;
  maskedToken: string;
  githubLogin: string | null;
  isValid: boolean;
  lastValidatedAt: string | null;
  createdAt: string;
};

export class GitHubTokenService {
  constructor(private db: Database) {}

  /**
   * Save a new GitHub PAT (encrypted)
   * Validates the token with GitHub API before saving
   */
  async saveToken(token: string): Promise<Result<TokenInfo, GitHubTokenError>> {
    // Validate format
    if (!isValidPATFormat(token)) {
      return err({
        code: 'INVALID_FORMAT',
        message: 'Invalid token format. GitHub PATs start with "ghp_" or "github_pat_"',
      });
    }

    // Validate with GitHub API
    const validation = await this.validateWithGitHub(token);
    if (!validation.ok) {
      return validation;
    }

    try {
      // Delete any existing token (we only keep one)
      await this.db.delete(githubTokens);

      // Encrypt and store
      const encrypted = await encryptToken(token);

      const [saved] = await this.db
        .insert(githubTokens)
        .values({
          encryptedToken: encrypted,
          tokenType: 'pat',
          githubLogin: validation.value.login,
          githubId: String(validation.value.id),
          isValid: true,
          lastValidatedAt: new Date().toISOString(),
        })
        .returning();

      if (!saved) {
        return err({
          code: 'STORAGE_ERROR',
          message: 'Failed to save token',
        });
      }

      return ok({
        id: saved.id,
        maskedToken: maskToken(token),
        githubLogin: saved.githubLogin,
        isValid: saved.isValid ?? true,
        lastValidatedAt: saved.lastValidatedAt,
        createdAt: saved.createdAt,
      });
    } catch (error) {
      return err({
        code: 'STORAGE_ERROR',
        message: `Failed to save token: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Get the current saved token info (without the actual token)
   */
  async getTokenInfo(): Promise<Result<TokenInfo | null, GitHubTokenError>> {
    try {
      const token = await this.db.query.githubTokens.findFirst();

      if (!token) {
        return ok(null);
      }

      // Decrypt to get masked version
      const decrypted = await decryptToken(token.encryptedToken);

      return ok({
        id: token.id,
        maskedToken: maskToken(decrypted),
        githubLogin: token.githubLogin,
        isValid: token.isValid ?? true,
        lastValidatedAt: token.lastValidatedAt,
        createdAt: token.createdAt,
      });
    } catch (error) {
      return err({
        code: 'STORAGE_ERROR',
        message: `Failed to get token: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Get the decrypted token for API use
   * Returns null if no token is saved, throws on decryption errors
   */
  async getDecryptedToken(): Promise<string | null> {
    const token = await this.db.query.githubTokens.findFirst();

    if (!token) {
      return null;
    }

    try {
      return decryptToken(token.encryptedToken);
    } catch (error) {
      log.error('Failed to decrypt GitHub token — encryption key may have changed', {
        error,
        data: { tokenId: token.id },
      });
      throw new Error(
        'Failed to decrypt GitHub token. The encryption key may have changed or data is corrupted.'
      );
    }
  }

  /**
   * Resolve a GitHub token for a project via its team associations.
   * Resolution chain: team_projects → github_tokens by teamId → global fallback (team_id IS NULL)
   */
  async resolveGitHubTokenForProject(projectId: string): Promise<string | null> {
    // Step 1: Find all teams associated with this project
    const projectTeams = await this.db
      .select({ teamId: teamProjects.teamId })
      .from(teamProjects)
      .where(eq(teamProjects.projectId, projectId));

    // Step 2: If the project has teams, look for a team-specific token (single query)
    if (projectTeams.length > 0) {
      const teamIds = projectTeams.map((t) => t.teamId);
      const teamToken = await this.db.query.githubTokens.findFirst({
        where: inArray(githubTokens.teamId, teamIds),
      });

      if (teamToken) {
        return decryptToken(teamToken.encryptedToken);
      }
    }

    // Step 3: Fall back to global token (team_id IS NULL)
    const globalToken = await this.db.query.githubTokens.findFirst({
      where: isNull(githubTokens.teamId),
    });

    if (globalToken) {
      return decryptToken(globalToken.encryptedToken);
    }

    return null;
    // Errors (DB failures, decryption failures) propagate to callers
  }

  /**
   * Delete the saved token
   */
  async deleteToken(): Promise<Result<void, GitHubTokenError>> {
    try {
      await this.db.delete(githubTokens);
      return ok(undefined);
    } catch (error) {
      return err({
        code: 'STORAGE_ERROR',
        message: `Failed to delete token: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Re-validate the saved token
   */
  async revalidateToken(): Promise<Result<boolean, GitHubTokenError>> {
    const token = await this.getDecryptedToken();

    if (!token) {
      return err({
        code: 'NOT_FOUND',
        message: 'No token saved',
      });
    }

    const validation = await this.validateWithGitHub(token);

    // Update validation status
    const isValid = validation.ok;
    await this.db.update(githubTokens).set({
      isValid,
      lastValidatedAt: new Date().toISOString(),
      githubLogin: validation.ok ? validation.value.login : undefined,
      updatedAt: new Date().toISOString(),
    });

    return ok(isValid);
  }

  /**
   * Create an Octokit instance from a token
   */
  private createOctokit(token: string): Octokit {
    return new Octokit({ auth: token });
  }

  /**
   * Get an Octokit instance for the saved token
   */
  async getOctokit(): Promise<Octokit | null> {
    const token = await this.getDecryptedToken();
    if (!token) return null;
    return this.createOctokit(token);
  }

  /**
   * Get an Octokit instance along with the token's database ID.
   * Used internally so handleOctokitError can scope invalidation to the specific token.
   */
  private async getOctokitWithId(): Promise<{ octokit: Octokit; tokenId: string } | null> {
    const tokenRow = await this.db.query.githubTokens.findFirst();
    if (!tokenRow) return null;
    const decrypted = await decryptToken(tokenRow.encryptedToken);
    return { octokit: this.createOctokit(decrypted), tokenId: tokenRow.id };
  }

  /**
   * Validate a token with GitHub API
   */
  private async validateWithGitHub(
    token: string
  ): Promise<Result<ValidatedUser, GitHubTokenError>> {
    try {
      const octokit = this.createOctokit(token);
      const { data: user } = await octokit.rest.users.getAuthenticated();

      return ok({
        login: user.login,
        id: user.id,
        avatarUrl: user.avatar_url,
        name: user.name,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'status' in error &&
        (error as { status: number }).status === 401
      ) {
        return err({
          code: 'VALIDATION_FAILED',
          message: 'Invalid token. Please check your token and try again.',
        });
      }
      return err({
        code: 'VALIDATION_FAILED',
        message: `Failed to validate token: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Get repository info
   */
  async getRepository(owner: string, repo: string): Promise<Result<GitHubRepo, GitHubTokenError>> {
    const result = await this.getOctokitWithId();
    if (!result) {
      return err({
        code: 'NOT_FOUND',
        message: 'No GitHub token configured',
      });
    }

    try {
      const { data } = await result.octokit.rest.repos.get({ owner, repo });
      return ok({
        id: data.id,
        name: data.name,
        full_name: data.full_name,
        private: data.private,
        owner: {
          login: data.owner.login,
          avatar_url: data.owner.avatar_url,
        },
        default_branch: data.default_branch,
        description: data.description,
        clone_url: data.clone_url,
        updated_at: data.updated_at ?? '',
        stargazers_count: data.stargazers_count,
        is_template: data.is_template ?? false,
      });
    } catch (error) {
      return this.handleOctokitError(error, result.tokenId);
    }
  }

  /**
   * List repository branches
   */
  async listBranches(
    owner: string,
    repo: string
  ): Promise<Result<GitHubBranch[], GitHubTokenError>> {
    const result = await this.getOctokitWithId();
    if (!result) {
      return err({
        code: 'NOT_FOUND',
        message: 'No GitHub token configured',
      });
    }

    try {
      const { data } = await result.octokit.rest.repos.listBranches({ owner, repo });
      return ok(
        data.map((branch) => ({
          name: branch.name,
          protected: branch.protected,
        }))
      );
    } catch (error) {
      return this.handleOctokitError(error, result.tokenId);
    }
  }

  /**
   * List the authenticated user's repositories
   * Sorted by most recently updated, limited to 50 repos
   */
  async listUserRepos(): Promise<Result<GitHubRepo[], GitHubTokenError>> {
    const result = await this.getOctokitWithId();
    if (!result) {
      return err({
        code: 'NOT_FOUND',
        message: 'No GitHub token configured',
      });
    }

    try {
      const { data } = await result.octokit.rest.repos.listForAuthenticatedUser({
        sort: 'updated',
        per_page: 50,
      });
      return ok(
        data.map((repo) => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          owner: {
            login: repo.owner.login,
            avatar_url: repo.owner.avatar_url,
          },
          default_branch: repo.default_branch,
          description: repo.description,
          clone_url: repo.clone_url,
          updated_at: repo.updated_at ?? '',
          stargazers_count: repo.stargazers_count,
          is_template: repo.is_template ?? false,
        }))
      );
    } catch (error) {
      return this.handleOctokitError(error, result.tokenId);
    }
  }

  /**
   * List the authenticated user's organizations (plus their own account)
   */
  async listUserOrgs(): Promise<Result<GitHubOrg[], GitHubTokenError>> {
    const result = await this.getOctokitWithId();
    if (!result) {
      return err({
        code: 'NOT_FOUND',
        message: 'No GitHub token configured',
      });
    }

    try {
      // Get the authenticated user first
      const { data: user } = await result.octokit.rest.users.getAuthenticated();

      // Get user's organizations
      const { data: orgs } = await result.octokit.rest.orgs.listForAuthenticatedUser({
        per_page: 100,
      });

      // Return user account first, then orgs
      return ok([
        {
          login: user.login,
          avatar_url: user.avatar_url,
          type: 'user' as const,
        },
        ...orgs.map((org) => ({
          login: org.login,
          avatar_url: org.avatar_url,
          type: 'org' as const,
        })),
      ]);
    } catch (error) {
      return this.handleOctokitError(error, result.tokenId);
    }
  }

  /**
   * List repositories for a specific owner (user or org)
   */
  async listReposForOwner(owner: string): Promise<Result<GitHubRepo[], GitHubTokenError>> {
    const result = await this.getOctokitWithId();
    if (!result) {
      return err({
        code: 'NOT_FOUND',
        message: 'No GitHub token configured',
      });
    }

    try {
      // Check if it's the authenticated user or an org
      const { data: user } = await result.octokit.rest.users.getAuthenticated();
      const isAuthenticatedUser = user.login === owner;

      const repos = isAuthenticatedUser
        ? (
            await result.octokit.rest.repos.listForAuthenticatedUser({
              sort: 'updated',
              per_page: 100,
              affiliation: 'owner',
            })
          ).data
        : (
            await result.octokit.rest.repos.listForOrg({
              org: owner,
              sort: 'updated',
              per_page: 100,
            })
          ).data;

      return ok(
        repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          owner: {
            login: repo.owner.login,
            avatar_url: repo.owner.avatar_url,
          },
          default_branch: repo.default_branch ?? 'main',
          description: repo.description,
          clone_url: repo.clone_url ?? '',
          updated_at: repo.updated_at ?? '',
          stargazers_count: repo.stargazers_count ?? 0,
          is_template: repo.is_template ?? false,
        }))
      );
    } catch (error) {
      return this.handleOctokitError(error, result.tokenId);
    }
  }

  /**
   * Create a new repository from a template
   */
  async createRepoFromTemplate(params: {
    templateOwner: string;
    templateRepo: string;
    name: string;
    owner?: string; // If not provided, creates in authenticated user's account
    description?: string;
    isPrivate?: boolean;
  }): Promise<Result<{ cloneUrl: string; fullName: string }, GitHubTokenError>> {
    const result = await this.getOctokitWithId();
    if (!result) {
      return err({
        code: 'NOT_FOUND',
        message: 'No GitHub token configured',
      });
    }

    try {
      const { data } = await result.octokit.rest.repos.createUsingTemplate({
        template_owner: params.templateOwner,
        template_repo: params.templateRepo,
        name: params.name,
        owner: params.owner,
        description: params.description,
        private: params.isPrivate ?? false,
        include_all_branches: false,
      });

      return ok({
        cloneUrl: data.clone_url ?? '',
        fullName: data.full_name,
      });
    } catch (error) {
      if (error instanceof Error && 'status' in error) {
        const status = (error as { status: number }).status;
        if (status === 422) {
          return err({
            code: 'VALIDATION_FAILED',
            message: 'Repository name already exists or is invalid',
          });
        }
      }
      return this.handleOctokitError(error, result.tokenId);
    }
  }

  /**
   * Handle Octokit errors consistently.
   * @param tokenId Optional token ID to scope invalidation to the specific failing token
   */
  private async handleOctokitError<T>(
    error: unknown,
    tokenId?: string
  ): Promise<Result<T, GitHubTokenError>> {
    if (error instanceof Error && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 401) {
        // Mark the specific token as invalid (not all tokens)
        if (tokenId) {
          await this.db
            .update(githubTokens)
            .set({ isValid: false, updatedAt: new Date().toISOString() })
            .where(eq(githubTokens.id, tokenId));
        }
        return err({
          code: 'VALIDATION_FAILED',
          message: 'Token is no longer valid',
        });
      }
      return err({
        code: 'VALIDATION_FAILED',
        message: `GitHub API error: ${status}`,
      });
    }
    return err({
      code: 'VALIDATION_FAILED',
      message: `GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// GitHub API types
export type GitHubOrg = {
  login: string;
  avatar_url: string;
  type: 'user' | 'org';
};

export type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    avatar_url: string;
  };
  default_branch: string;
  description: string | null;
  clone_url: string;
  updated_at: string;
  stargazers_count: number;
  is_template: boolean;
};

export type GitHubBranch = {
  name: string;
  protected: boolean;
};
