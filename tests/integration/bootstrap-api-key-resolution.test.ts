/**
 * Integration coverage for bootstrap/phases/api-key-resolution.
 *
 * Targets the resolveApiKey BootstrapPhaseResult contract:
 * - missing key + non-production → ok=false, fatal=false
 * - missing key + production → ok=false, fatal=true
 * - env-provided key → ok=true (no DB lookup needed)
 * - DB-provided regular API key → ok=true, sets process.env.ANTHROPIC_API_KEY
 * - DB-provided OAuth token → writeOAuthCredentials writes to a file
 * - resolver throws → bubbles into BootstrapPhaseResult fatal flag
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveAnthropicApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/utils/resolve-anthropic-key.js', () => ({
  resolveAnthropicApiKey: (...args: unknown[]) => resolveAnthropicApiKeyMock(...args),
  readCredentialsFile: vi.fn(async () => null),
}));

import { resolveApiKey } from '../../src/server/bootstrap/phases/api-key-resolution';

describe('bootstrap/phases/api-key-resolution: resolveApiKey', () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_OAUTH_TOKEN: process.env.CLAUDE_OAUTH_TOKEN,
  };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_OAUTH_TOKEN;
    resolveAnthropicApiKeyMock.mockReset();
    resolveAnthropicApiKeyMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (original.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.NODE_ENV;

    if (original.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original.ANTHROPIC_API_KEY;

    if (original.CLAUDE_OAUTH_TOKEN === undefined) delete process.env.CLAUDE_OAUTH_TOKEN;
    else process.env.CLAUDE_OAUTH_TOKEN = original.CLAUDE_OAUTH_TOKEN;
  });

  it('returns ok=false / fatal=false when no key resolved and NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    const apiKeyService = {} as never;

    const result = await resolveApiKey(apiKeyService);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(false);
      expect(result.error.message).toContain('No Anthropic API key found');
    }
  });

  it('returns ok=false / fatal=true when no key resolved and NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const apiKeyService = {} as never;

    const result = await resolveApiKey(apiKeyService);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
    }
  });

  it('returns ok=true when ANTHROPIC_API_KEY env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-from-env';
    resolveAnthropicApiKeyMock.mockResolvedValue('sk-ant-api-from-env');
    const result = await resolveApiKey({} as never);
    expect(result.ok).toBe(true);
  });

  it('returns ok=true when CLAUDE_OAUTH_TOKEN env var is set', async () => {
    process.env.CLAUDE_OAUTH_TOKEN = 'sk-ant-oat-from-env';
    resolveAnthropicApiKeyMock.mockResolvedValue('sk-ant-oat-from-env');
    const result = await resolveApiKey({} as never);
    expect(result.ok).toBe(true);
  });

  it('sets process.env.ANTHROPIC_API_KEY when DB returns a regular API key', async () => {
    resolveAnthropicApiKeyMock.mockResolvedValue('sk-ant-api-from-db');
    const result = await resolveApiKey({} as never);
    expect(result.ok).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api-from-db');
  });

  it('writes OAuth credentials file when DB returns an OAuth token', async () => {
    resolveAnthropicApiKeyMock.mockResolvedValue('sk-ant-oat-from-db');

    // Redirect HOME so the credentials file lands in a temp dir
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agentpane-credtest-'));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const result = await resolveApiKey({} as never);
      expect(result.ok).toBe(true);
      // process.env.ANTHROPIC_API_KEY MUST NOT be set for OAuth tokens
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

      const credPath = path.join(tmpHome, '.claude', '.credentials.json');
      const contents = await fs.readFile(credPath, 'utf-8');
      const parsed = JSON.parse(contents);
      expect(parsed.claudeAiOauth.accessToken).toBe('sk-ant-oat-from-db');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it('returns ok=false / fatal=production when resolveAnthropicApiKey throws', async () => {
    resolveAnthropicApiKeyMock.mockRejectedValue(new Error('DB exploded'));
    process.env.NODE_ENV = 'production';
    const result = await resolveApiKey({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
      expect(result.error.message).toContain('DB exploded');
    }
  });

  it('returns ok=false / fatal=false when resolveAnthropicApiKey throws in dev', async () => {
    resolveAnthropicApiKeyMock.mockRejectedValue(new Error('flake'));
    process.env.NODE_ENV = 'development';
    const result = await resolveApiKey({} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(false);
    }
  });
});
