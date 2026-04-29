import { describe, expect, it } from 'vitest';
import { deepMerge } from '../../utils/deep-merge.js';
import { loadCodespaceConfig, loadCodespaceConfigFrom } from '../config-service.js';
import { DEFAULT_CODESPACE_CONFIG } from '../types.js';
import { containsSecrets } from '../validate-secrets.js';

const sampleConfig = {
  worktreeRoot: '.worktrees',
  defaultBranch: 'main',
  allowedTools: ['Read'],
  maxTurns: 25,
};

describe('config system', () => {
  it('defaults are defined', () => {
    expect(DEFAULT_CODESPACE_CONFIG.maxTurns).toBe(50);
  });

  it('deep merges config layers', () => {
    const merged = deepMerge(DEFAULT_CODESPACE_CONFIG, sampleConfig);

    expect(merged.maxTurns).toBe(25);
    expect(merged.allowedTools).toEqual(['Read']);
  });

  it('loads project config from defaults when missing', async () => {
    const result = await loadCodespaceConfigFrom({ codespacePath: '/tmp/missing' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxTurns).toBe(50);
    }
  });

  it('loadProjectConfig uses environment overrides', async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.AGENTPANE_MAX_TURNS = '12';

    const result = await loadCodespaceConfig({ codespacePath: '/tmp/missing' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.codespace.maxTurns).toBe(12);
    }

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENTPANE_MAX_TURNS;

    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('loadProjectConfig succeeds without API key (CB-013: deferred to execution time)', async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const result = await loadCodespaceConfig({ codespacePath: '/tmp/missing' });

    expect(result.ok).toBe(true);

    if (previousKey) {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it('detects secrets in config keys', () => {
    const secrets = containsSecrets({ SECRET_KEY: 'oops', PASSWORD: 'bad' });

    expect(secrets).toEqual(['SECRET_KEY', 'PASSWORD']);
  });
});
