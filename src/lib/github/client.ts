import { Octokit } from 'octokit';
import { errorMessage } from '../utils/error-message';

export interface GitHubClientOptions {
  token?: string;
  installationId?: number;
}

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

let appOctokit: Octokit | null = null;
let cachedAppId: string | null = null;

export function getAppOctokit(credentials?: GitHubAppCredentials): Octokit {
  const appId = credentials?.appId ?? process.env.GITHUB_APP_ID;
  const privateKey = credentials?.privateKey ?? process.env.GITHUB_PRIVATE_KEY;

  // Invalidate cache if credentials changed
  if (cachedAppId && cachedAppId !== appId) {
    appOctokit = null;
  }

  if (!appOctokit) {
    if (!appId || !privateKey) {
      throw new Error('GitHub App credentials not configured (GITHUB_APP_ID, GITHUB_PRIVATE_KEY)');
    }

    appOctokit = new Octokit({
      auth: { appId, privateKey },
    });
    cachedAppId = appId;
  }

  return appOctokit;
}

export function clearAppOctokitCache(): void {
  appOctokit = null;
  cachedAppId = null;
}

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const app = getAppOctokit();

  // Get installation access token
  const { data: installation } = await app.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });

  return new Octokit({
    auth: installation.token,
  });
}

export function createOctokitFromToken(token: string): Octokit {
  return new Octokit({
    auth: token,
  });
}

/**
 * Extract a meaningful error message from an Octokit/GitHub API error.
 * Octokit's RequestError includes status codes and response data that
 * the generic Error.message often omits or makes cryptic.
 */
export function formatGitHubError(error: unknown): { message: string; status?: number } {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }

  const err = error as {
    status?: number;
    message?: string;
    response?: { data?: { message?: string } };
  };
  const status = err.status;
  const apiMessage = err.response?.data?.message || err.message || String(error);

  switch (status) {
    case 401:
      return {
        message: `GitHub authentication failed: ${apiMessage}. The stored token may be expired or revoked.`,
        status,
      };
    case 403:
      return {
        message: `GitHub access denied: ${apiMessage}. The token may lack required permissions or scopes.`,
        status,
      };
    case 404:
      return {
        message: `GitHub repository not found: ${apiMessage}. Check that the repository exists and the token has access.`,
        status,
      };
    case 422:
      return { message: `GitHub validation error: ${apiMessage}`, status };
    default:
      if (status) {
        return { message: `GitHub API error (${status}): ${apiMessage}`, status };
      }
      return { message: errorMessage(error) };
  }
}

export type { Octokit };
