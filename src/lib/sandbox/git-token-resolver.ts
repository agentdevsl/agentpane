import { execSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { githubInstallations } from '../../db/schema/index.js';
import type { GitHubTokenService } from '../../services/github-token.service.js';
import type { Database } from '../../types/database.js';
import { getAppOctokit } from '../github/client.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('GitTokenResolver');

export interface GitTokenResult {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
}

export interface GitTokenResolverDeps {
  db: Database;
  githubTokenService?: GitHubTokenService;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolves a git authentication token for cloning repos inside K8s pods.
 *
 * Resolution order:
 *  1. GitHub App installation token (preferred) — also falls through on error
 *  2. Personal Access Token fallback (tried if step 1 is unavailable or fails)
 *  3. null if neither is available
 */
export async function resolveGitToken(
  project: {
    githubOwner: string | null;
    githubRepo: string | null;
    githubInstallationId: string | null;
  },
  deps: GitTokenResolverDeps
): Promise<GitTokenResult | null> {
  const { db, githubTokenService } = deps;

  if (!project.githubOwner || !project.githubRepo) {
    return null;
  }

  const { githubOwner: owner, githubRepo: repo } = project;

  // 1. Try GitHub App installation token
  if (project.githubInstallationId) {
    try {
      const installation = await db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.id, project.githubInstallationId),
      });

      if (installation) {
        const numericId = Number(installation.installationId);
        if (Number.isNaN(numericId)) {
          // Invalid installation ID format — fall through to PAT fallback
        } else {
          const appOctokit = getAppOctokit();
          const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
            installation_id: numericId,
          });
          return { token: data.token, owner, repo };
        }
      } else {
        // No installation record found — fall through to PAT fallback
      }
    } catch (error) {
      const message = formatError(error);
      if (message.includes('not configured')) {
        // GitHub App not configured — fall through to PAT fallback
      } else {
        log.debug('GitHub App token creation failed', { error: message });
      }
    }
  }

  // 2. Fall back to Personal Access Token
  if (githubTokenService) {
    try {
      const token = await githubTokenService.getDecryptedToken();
      if (token) {
        return { token, owner, repo };
      }
    } catch (error) {
      log.debug('Failed to get GitHub PAT token', { error });
    }
  }
  return null;
}

/**
 * Parse owner/repo from a git remote URL.
 * Supports HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 * Returns null if the URL cannot be parsed.
 */
export function parseGitRemoteUrl(url: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.\s]+)/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.\s]+)/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}

/**
 * Derive GitHub owner/repo from a project's local git remote.
 * Runs `git remote get-url origin` on the host filesystem.
 * Returns null if the path is not a git repo or has no GitHub remote.
 */
export function deriveGitHubFromPath(projectPath: string): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return parseGitRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}
