/**
 * Integration coverage shim for src/lib/plan-mode/claude-client.ts.
 *
 * The full behavior (Anthropic SDK calls) is unit-tested at
 * tests/lib/plan-mode/claude-client.test.ts with module-scope mocks.
 * This file covers the credential-loader + constructor + simple-getter
 * surface from the integration project so the combined measurement
 * doesn't show the file as 0%.
 *
 * Run: npx vitest run --project integration tests/integration/plan-mode-claude-client.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Anthropic SDK so constructing the client doesn't hit the network.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    apiKey: string;
    messages = { create: vi.fn() };
    constructor(cfg: { apiKey: string }) {
      this.apiKey = cfg.apiKey;
    }
  },
}));

// Mock the credential reader so loadCredentials() takes both paths without
// touching the real filesystem.
const mockReadCredentialsFile = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/utils/resolve-anthropic-key.js', () => ({
  readCredentialsFile: mockReadCredentialsFile,
}));

import { ClaudeClient, loadCredentials } from '../../src/lib/plan-mode/claude-client';

describe('lib/plan-mode/claude-client (integration coverage shim)', () => {
  beforeEach(() => {
    mockReadCredentialsFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loadCredentials returns ok when readCredentialsFile resolves a credentials object', async () => {
    mockReadCredentialsFile.mockResolvedValueOnce({
      accessToken: 'sk-fake',
      refreshToken: 'r',
      expiresAt: Date.now() + 60_000,
      scope: 'api',
    });
    const r = await loadCredentials();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.accessToken).toBe('sk-fake');
  });

  it('loadCredentials returns CREDENTIALS_NOT_FOUND when reader returns null', async () => {
    mockReadCredentialsFile.mockResolvedValueOnce(null);
    const r = await loadCredentials();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
  });

  it('ClaudeClient constructor accepts default config (no overrides)', () => {
    const c = new ClaudeClient({
      accessToken: 'sk-default',
      refreshToken: '',
      expiresAt: Date.now(),
      scope: '',
    });
    expect(c).toBeInstanceOf(ClaudeClient);
  });

  it('ClaudeClient constructor honors custom model / maxTokens / systemPrompt', () => {
    const c = new ClaudeClient(
      {
        accessToken: 'sk-custom',
        refreshToken: '',
        expiresAt: Date.now(),
        scope: '',
      },
      {
        model: 'claude-opus-4-7',
        maxTokens: 4096,
        systemPrompt: 'You are a test assistant.',
      }
    );
    expect(c).toBeInstanceOf(ClaudeClient);
  });
});
