/**
 * SL-013: Shared GitHub auth resolution utility.
 *
 * Extracts the duplicated pattern from template.service.ts and marketplace.service.ts
 * into a single reusable function. Tries GitHub App installation first, then falls
 * back to a PAT from the github_tokens table.
 */
import { eq } from 'drizzle-orm';
import { githubInstallations, githubTokens } from '../../db/schema';
import type { Database } from '../../types/database.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { createOctokitFromToken, getInstallationOctokit } from './client.js';

export interface ResolveOctokitError {
  code: string;
  message: string;
}

/**
 * Resolve an authenticated Octokit client for GitHub API access.
 *
 * Strategy:
 * 1. Try to find an active GitHub App installation and create an installation-scoped client.
 * 2. If no installation, fall back to a valid PAT from the github_tokens table.
 * 3. If PAT decryption fails, mark the token as invalid and return an error.
 *
 * @returns An authenticated Octokit instance or an error result.
 */
export async function resolveOctokit(
  db: Database
): Promise<Result<Awaited<ReturnType<typeof getInstallationOctokit>>, ResolveOctokitError>> {
  // Try GitHub App installation first
  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.status, 'active'),
  });

  if (installation) {
    const octokit = await getInstallationOctokit(Number(installation.installationId));
    return ok(octokit);
  }

  // Fall back to PAT
  const tokenRecord = await db.query.githubTokens.findFirst({
    where: eq(githubTokens.isValid, true),
  });

  if (!tokenRecord) {
    return err({
      code: 'NO_AUTH',
      message: 'No GitHub authentication found (need App installation or PAT)',
    });
  }

  // Dynamic import to avoid bundling node:path for browser
  const { decryptToken } = await import('../crypto/server-encryption.js');
  let token: string;
  try {
    token = await decryptToken(tokenRecord.encryptedToken);
  } catch (decryptError) {
    console.error(
      '[resolveOctokit] Failed to decrypt GitHub token, marking as invalid:',
      decryptError
    );
    await db
      .update(githubTokens)
      .set({ isValid: false })
      .where(eq(githubTokens.id, tokenRecord.id));
    return err({
      code: 'DECRYPT_FAILED',
      message:
        'GitHub token could not be decrypted. The encryption key may have changed. Please re-add your GitHub token in Settings.',
    });
  }

  return ok(createOctokitFromToken(token));
}
