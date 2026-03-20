/**
 * API Key Resolution Phase
 *
 * Resolves the Anthropic API key from all sources (DB, env vars, credentials file)
 * and injects it into the appropriate location for the Claude Agent SDK.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../../lib/logging/logger.js';
import { resolveAnthropicApiKey } from '../../../lib/utils/resolve-anthropic-key.js';
import type { ApiKeyService } from '../../../services/api-key.service.js';

const log = createLogger('ApiKeyResolution');

/**
 * Resolve and configure the Anthropic API key.
 *
 * Sources checked in order:
 * 1. process.env.ANTHROPIC_API_KEY or process.env.CLAUDE_OAUTH_TOKEN
 * 2. Database (via ApiKeyService)
 * 3. ~/.claude/.credentials.json
 *
 * For DB-sourced keys:
 * - Regular API keys (sk-ant-api*): injected into process.env.ANTHROPIC_API_KEY
 * - OAuth tokens (sk-ant-oat*): written to ~/.claude/.credentials.json
 */
export async function resolveApiKey(apiKeyService: ApiKeyService): Promise<void> {
  const hasEnvKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_OAUTH_TOKEN;
  const resolvedKey = await resolveAnthropicApiKey(apiKeyService);
  const isProduction = process.env.NODE_ENV === 'production';

  if (!resolvedKey) {
    const msg =
      'No Anthropic API key found (checked database, ANTHROPIC_API_KEY env var, and ~/.claude/.credentials.json) - agent execution will fail';
    if (isProduction) {
      log.error(msg);
      process.exit(1);
    }
    log.warn(msg);
    return;
  }

  if (hasEnvKey) {
    const source = process.env.ANTHROPIC_API_KEY ? 'env' : 'env_oauth';
    log.info('Anthropic API key resolved', { data: { source } });
    return;
  }

  const isOAuthToken = resolvedKey.startsWith('sk-ant-oat');
  if (isOAuthToken) {
    await writeOAuthCredentials(resolvedKey);
  } else {
    process.env.ANTHROPIC_API_KEY = resolvedKey;
    log.info('Anthropic API key resolved', { data: { source: 'database' } });
  }
}

/**
 * Write OAuth token to ~/.claude/.credentials.json in the format
 * the Claude CLI expects. The API rejects OAuth tokens via env var.
 */
async function writeOAuthCredentials(token: string): Promise<void> {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    await fs.mkdir(path.dirname(credPath), { recursive: true });
    await fs.writeFile(
      credPath,
      JSON.stringify(
        {
          claudeAiOauth: {
            accessToken: token,
            refreshToken: '',
            expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
            subscriptionType: 'max',
          },
        },
        null,
        2
      ),
      'utf-8'
    );
    log.info('Anthropic OAuth credentials file written', {
      data: { source: 'database', credPath },
    });
  } catch (writeErr) {
    throw new Error(
      `Failed to write OAuth credentials: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
    );
  }
}
