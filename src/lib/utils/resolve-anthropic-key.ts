import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApiKeyService } from '../../services/api-key.service.js';
import type { OAuthCredentials } from '../../types/credentials.js';

/**
 * Path to the Claude credentials file (~/.claude/.credentials.json)
 */
function getCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Read the OAuth credentials file from disk.
 * Supports both the CLI format ({ claudeAiOauth: { accessToken, ... } })
 * and the flat format ({ accessToken, ... }).
 * Returns the parsed credentials or null if the file doesn't exist,
 * is malformed, or the token is expired.
 */
export async function readCredentialsFile(): Promise<OAuthCredentials | null> {
  const credPath = getCredentialsPath();

  try {
    const content = await fs.promises.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(content) as OAuthCredentials | { claudeAiOauth?: OAuthCredentials };

    // Support CLI format: { claudeAiOauth: { accessToken, ... } }
    const credentials =
      'claudeAiOauth' in parsed && parsed.claudeAiOauth
        ? parsed.claudeAiOauth
        : (parsed as OAuthCredentials);

    if (!credentials.accessToken) {
      return null;
    }

    // Check if credentials are expired
    if (credentials.expiresAt && Date.now() > credentials.expiresAt) {
      return null;
    }

    return credentials;
  } catch (error) {
    // Only suppress ENOENT (file not found); log other errors
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    return null;
  }
}

/**
 * Resolve an Anthropic API key from available sources:
 * 1. Database (Settings UI key) via ApiKeyService
 * 2. Credentials file (~/.claude/.credentials.json)
 *
 * Returns the API key string or null if no key is available.
 */
export async function resolveAnthropicApiKey(
  apiKeyService?: ApiKeyService
): Promise<string | null> {
  // 1. Try database key first
  if (apiKeyService) {
    try {
      const dbKey = await apiKeyService.getDecryptedKey('anthropic');
      if (dbKey) return dbKey;
    } catch (dbError) {
      const _msg = dbError instanceof Error ? dbError.message : String(dbError);
    }
  }

  // 2. Try credentials file
  const credentials = await readCredentialsFile();
  if (credentials?.accessToken) {
    return credentials.accessToken;
  }

  return null;
}
