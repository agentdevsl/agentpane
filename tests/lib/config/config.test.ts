import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepMerge } from '@/lib/utils/deep-merge';

// Mock fs module for file loading tests
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
  },
}));

const mockedFs = vi.mocked(fs);

describe('Configuration Module', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset environment variables before each test
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENTPANE_MAX_TURNS;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('Configuration Loading', () => {
    it('loads configuration from file when settings.json exists', async () => {
      const fileConfig = {
        worktreeRoot: '.custom-worktrees',
        maxTurns: 100,
        defaultBranch: 'develop',
        allowedTools: ['Read', 'Edit'],
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(fileConfig));

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const result = await loadProjectConfigFrom({ projectPath: '/test/project' });

      expect(mockedFs.readFile).toHaveBeenCalledWith(
        path.join('/test/project', '.claude', 'settings.json'),
        'utf-8'
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.worktreeRoot).toBe('.custom-worktrees');
        expect(result.value.maxTurns).toBe(100);
        expect(result.value.defaultBranch).toBe('develop');
      }
    });

    it('loads configuration from environment variables when set', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';
      process.env.AGENTPANE_MAX_TURNS = '200';

      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.project.maxTurns).toBe(200);
      }
    });

    it('loads default configuration when file is missing', async () => {
      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const { DEFAULT_PROJECT_CONFIG } = await import('@/lib/config/types');

      const result = await loadProjectConfigFrom({ projectPath: '/nonexistent/path' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(DEFAULT_PROJECT_CONFIG);
        expect(result.value.maxTurns).toBe(50);
        expect(result.value.defaultBranch).toBe('main');
        expect(result.value.worktreeRoot).toBe('.worktrees');
      }
    });

    it('merges file configuration with defaults correctly', async () => {
      const partialConfig = {
        maxTurns: 75,
        // Note: no defaultBranch or worktreeRoot specified
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(partialConfig));

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const result = await loadProjectConfigFrom({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Merged value from file
        expect(result.value.maxTurns).toBe(75);
        // Default values preserved
        expect(result.value.defaultBranch).toBe('main');
        expect(result.value.worktreeRoot).toBe('.worktrees');
        expect(result.value.allowedTools).toEqual(['Read', 'Edit', 'Bash', 'Glob', 'Grep']);
      }
    });

    it('validates configuration against schema and rejects invalid values', async () => {
      const invalidConfig = {
        maxTurns: -1, // Invalid: must be >= 1
        maxConcurrentAgents: 999, // Invalid: must be <= 10
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(invalidConfig));

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const result = await loadProjectConfigFrom({ projectPath: '/test/project' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_CONFIG_INVALID');
      }
    });
  });

  describe('Configuration Parsing', () => {
    it('parses valid JSON configuration correctly', async () => {
      const jsonConfig = JSON.stringify({
        worktreeRoot: '.trees',
        maxTurns: 30,
        defaultBranch: 'main',
        allowedTools: ['Read'],
        model: 'claude-3-opus',
        temperature: 0.7,
      });

      mockedFs.readFile.mockResolvedValue(jsonConfig);

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const result = await loadProjectConfigFrom({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.model).toBe('claude-3-opus');
        expect(result.value.temperature).toBe(0.7);
      }
    });

    it('handles malformed JSON configuration gracefully', async () => {
      mockedFs.readFile.mockResolvedValue('{ invalid json }');

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const result = await loadProjectConfigFrom({ projectPath: '/test/project' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_CONFIG_INVALID');
      }
    });

    it('coerces numeric string types correctly via environment variables', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.AGENTPANE_MAX_TURNS = '150';

      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.project.maxTurns).toBe('number');
        expect(result.value.project.maxTurns).toBe(150);
      }
    });

    it('falls back to default when environment variable is invalid number', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.AGENTPANE_MAX_TURNS = 'not-a-number';

      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should fall back to default of 50
        expect(result.value.project.maxTurns).toBe(50);
      }
    });

    it('handles empty configuration file by using defaults', async () => {
      mockedFs.readFile.mockResolvedValue('{}');

      const { loadProjectConfigFrom } = await import('@/lib/config/config-service');
      const result = await loadProjectConfigFrom({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.maxTurns).toBe(50);
        expect(result.value.defaultBranch).toBe('main');
      }
    });
  });

  describe('Environment Handling', () => {
    it('resolves environment variables for configuration', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
      process.env.AGENTPANE_MAX_TURNS = '75';

      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.project.maxTurns).toBe(75);
      }
    });

    it('environment variables override file configuration values', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.AGENTPANE_MAX_TURNS = '300';

      const fileConfig = {
        maxTurns: 50, // File says 50
        defaultBranch: 'develop',
      };

      mockedFs.readFile.mockResolvedValue(JSON.stringify(fileConfig));

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Environment variable takes precedence
        expect(result.value.project.maxTurns).toBe(300);
        // File value preserved for other keys
        expect(result.value.project.defaultBranch).toBe('develop');
      }
    });

    it('uses default value when environment variable is not set', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      // AGENTPANE_MAX_TURNS not set

      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.project.maxTurns).toBe(50); // Default value
      }
    });

    it('succeeds without ANTHROPIC_API_KEY (CB-013: deferred to execution time)', async () => {
      // Ensure API key is not set
      delete process.env.ANTHROPIC_API_KEY;

      mockedFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      const { loadProjectConfig } = await import('@/lib/config/config-service');
      const result = await loadProjectConfig({ projectPath: '/test/project' });

      expect(result.ok).toBe(true);
    });

    it('detects and rejects secrets in configuration keys', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const { containsSecrets } = await import('@/lib/config/validate-secrets');

      // These should be flagged as secrets
      const violations = containsSecrets({
        MY_SECRET: 'value',
        DB_PASSWORD: 'value',
        PRIVATE_KEY: 'value',
        CUSTOM_TOKEN: 'value',
        SOME_API_KEY: 'value',
      });

      expect(violations).toContain('MY_SECRET');
      expect(violations).toContain('DB_PASSWORD');
      expect(violations).toContain('PRIVATE_KEY');
      expect(violations).toContain('CUSTOM_TOKEN');
      expect(violations).toContain('SOME_API_KEY');
    });
  });

  describe('Deep Merge Utility', () => {
    it('merges nested objects correctly', () => {
      const target = {
        level1: {
          level2: {
            value: 'original',
            preserved: true,
          },
        },
      };

      const source = {
        level1: {
          level2: {
            value: 'updated',
          },
        },
      };

      const result = deepMerge(target, source);

      expect(result.level1.level2.value).toBe('updated');
      expect(result.level1.level2.preserved).toBe(true);
    });

    it('replaces arrays entirely rather than merging', () => {
      const target = {
        tools: ['Read', 'Edit', 'Bash'],
      };

      const source = {
        tools: ['Read'],
      };

      const result = deepMerge(target, source);

      expect(result.tools).toEqual(['Read']);
    });

    it('handles undefined source gracefully', () => {
      const target = { key: 'value' };

      const result = deepMerge(target, undefined as unknown as Record<string, unknown>);

      expect(result).toEqual(target);
    });
  });

  describe('Schema Validation', () => {
    it('validates maxTurns within range 1-500', async () => {
      const { codespaceConfigSchema } = await import('@/lib/config/schemas');

      // Valid values
      expect(() => codespaceConfigSchema.parse({ maxTurns: 1 })).not.toThrow();
      expect(() => codespaceConfigSchema.parse({ maxTurns: 500 })).not.toThrow();
      expect(() => codespaceConfigSchema.parse({ maxTurns: 250 })).not.toThrow();

      // Invalid values
      expect(() => codespaceConfigSchema.parse({ maxTurns: 0 })).toThrow();
      expect(() => codespaceConfigSchema.parse({ maxTurns: 501 })).toThrow();
      expect(() => codespaceConfigSchema.parse({ maxTurns: -1 })).toThrow();
    });

    it('validates maxConcurrentAgents within range 1-10', async () => {
      const { codespaceConfigSchema } = await import('@/lib/config/schemas');

      // Valid values
      expect(() => codespaceConfigSchema.parse({ maxConcurrentAgents: 1 })).not.toThrow();
      expect(() => codespaceConfigSchema.parse({ maxConcurrentAgents: 10 })).not.toThrow();
      expect(() => codespaceConfigSchema.parse({ maxConcurrentAgents: 5 })).not.toThrow();

      // Invalid values
      expect(() => codespaceConfigSchema.parse({ maxConcurrentAgents: 0 })).toThrow();
      expect(() => codespaceConfigSchema.parse({ maxConcurrentAgents: 11 })).toThrow();
    });

    it('validates temperature within range 0-1', async () => {
      const { codespaceConfigSchema } = await import('@/lib/config/schemas');

      // Valid values
      expect(() => codespaceConfigSchema.parse({ temperature: 0 })).not.toThrow();
      expect(() => codespaceConfigSchema.parse({ temperature: 1 })).not.toThrow();
      expect(() => codespaceConfigSchema.parse({ temperature: 0.5 })).not.toThrow();

      // Invalid values
      expect(() => codespaceConfigSchema.parse({ temperature: -0.1 })).toThrow();
      expect(() => codespaceConfigSchema.parse({ temperature: 1.1 })).toThrow();
    });
  });

  describe('Secrets Validation', () => {
    it('allows ANTHROPIC_API_KEY and GITHUB_TOKEN as exceptions', async () => {
      const { containsSecrets } = await import('@/lib/config/validate-secrets');

      const violations = containsSecrets({
        ANTHROPIC_API_KEY: 'sk-ant-123',
        GITHUB_TOKEN: 'ghp_123',
      });

      expect(violations).toHaveLength(0);
    });

    it('flags various secret patterns', async () => {
      const { containsSecrets } = await import('@/lib/config/validate-secrets');

      const testCases = [
        { key: 'SECRET_VALUE', shouldFlag: true },
        { key: 'MY_PASSWORD', shouldFlag: true },
        { key: 'PRIVATE_KEY', shouldFlag: true },
        { key: 'AUTH_TOKEN', shouldFlag: true },
        { key: 'DB_API_KEY', shouldFlag: true },
        { key: 'NORMAL_CONFIG', shouldFlag: false },
        { key: 'MAX_TURNS', shouldFlag: false },
      ];

      for (const { key, shouldFlag } of testCases) {
        const violations = containsSecrets({ [key]: 'value' });
        if (shouldFlag) {
          expect(violations).toContain(key);
        } else {
          expect(violations).not.toContain(key);
        }
      }
    });
  });
});
