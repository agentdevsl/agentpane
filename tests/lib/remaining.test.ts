import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// 1. TEMPLATE MERGE TESTS (~10 tests)
// =============================================================================
describe('Template Merge', () => {
  // Import the module fresh for each test
  beforeEach(() => {
    vi.resetModules();
  });

  describe('mergeTemplates', () => {
    it('merges org templates correctly', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'org-template-1',
          name: 'Org Template 1',
          cachedSkills: [{ id: 'skill-1', name: 'Skill 1', content: 'content' }],
          cachedCommands: [{ name: 'cmd-1', content: 'content' }],
          cachedAgents: [{ name: 'agent-1', content: 'content' }],
        },
      ] as any[];

      const result = mergeTemplates(orgTemplates, [], undefined);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].sourceType).toBe('org');
      expect(result.skills[0].sourceId).toBe('org-template-1');
      expect(result.skills[0].sourceName).toBe('Org Template 1');

      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].sourceType).toBe('org');

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].sourceType).toBe('org');
    });

    it('project templates override org templates', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'org-1',
          name: 'Org',
          cachedSkills: [{ id: 'skill-1', name: 'Org Skill', content: 'org content' }],
          cachedCommands: [{ name: 'shared-cmd', description: 'org description', content: 'org' }],
          cachedAgents: [],
        },
      ] as any[];

      const projectTemplates = [
        {
          id: 'project-1',
          name: 'Project',
          cachedSkills: [{ id: 'skill-1', name: 'Project Skill', content: 'project content' }],
          cachedCommands: [
            { name: 'shared-cmd', description: 'project description', content: 'project' },
          ],
          cachedAgents: [],
        },
      ] as any[];

      const result = mergeTemplates(orgTemplates, projectTemplates, undefined);

      // Project skill should override org skill (same id)
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('Project Skill');
      expect(result.skills[0].sourceType).toBe('project');

      // Project command should override org command (same name)
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].description).toBe('project description');
      expect(result.commands[0].sourceType).toBe('project');
    });

    it('local config overrides both org and project templates', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'org-1',
          name: 'Org',
          cachedSkills: [{ id: 'skill-1', name: 'Org Skill', content: 'org' }],
          cachedCommands: [],
          cachedAgents: [],
        },
      ] as any[];

      const projectTemplates = [
        {
          id: 'project-1',
          name: 'Project',
          cachedSkills: [{ id: 'skill-1', name: 'Project Skill', content: 'project' }],
          cachedCommands: [],
          cachedAgents: [],
        },
      ] as any[];

      const localConfig = {
        skills: [{ id: 'skill-1', name: 'Local Skill', content: 'local' }],
        commands: [],
        agents: [],
      };

      const result = mergeTemplates(orgTemplates, projectTemplates, localConfig);

      // Local should override both org and project
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('Local Skill');
      expect(result.skills[0].sourceType).toBe('local');
      expect(result.skills[0].sourceId).toBeUndefined();
    });

    it('handles templates without cached content', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'empty-template',
          name: 'Empty Template',
          cachedSkills: null,
          cachedCommands: null,
          cachedAgents: null,
        },
      ] as any[];

      const result = mergeTemplates(orgTemplates, [], undefined);

      expect(result.skills).toHaveLength(0);
      expect(result.commands).toHaveLength(0);
      expect(result.agents).toHaveLength(0);
    });

    it('handles empty template arrays', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const result = mergeTemplates([], [], undefined);

      expect(result.skills).toHaveLength(0);
      expect(result.commands).toHaveLength(0);
      expect(result.agents).toHaveLength(0);
    });

    it('preserves unique items from all sources', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'org-1',
          name: 'Org',
          cachedSkills: [{ id: 'org-skill', name: 'Org Only', content: 'org' }],
          cachedCommands: [{ name: 'org-cmd', content: 'org' }],
          cachedAgents: [],
        },
      ] as any[];

      const projectTemplates = [
        {
          id: 'project-1',
          name: 'Project',
          cachedSkills: [{ id: 'project-skill', name: 'Project Only', content: 'project' }],
          cachedCommands: [{ name: 'project-cmd', content: 'project' }],
          cachedAgents: [],
        },
      ] as any[];

      const localConfig = {
        skills: [{ id: 'local-skill', name: 'Local Only', content: 'local' }],
        commands: [{ name: 'local-cmd', content: 'local' }],
        agents: [],
      };

      const result = mergeTemplates(orgTemplates, projectTemplates, localConfig);

      // All unique skills should be present
      expect(result.skills).toHaveLength(3);
      expect(result.skills.find((s) => s.id === 'org-skill')).toBeDefined();
      expect(result.skills.find((s) => s.id === 'project-skill')).toBeDefined();
      expect(result.skills.find((s) => s.id === 'local-skill')).toBeDefined();

      // All unique commands should be present
      expect(result.commands).toHaveLength(3);
    });

    it('handles multiple templates from same source', async () => {
      const { mergeTemplates } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'org-1',
          name: 'Org 1',
          cachedSkills: [{ id: 'skill-a', name: 'Skill A', content: 'a' }],
          cachedCommands: [],
          cachedAgents: [],
        },
        {
          id: 'org-2',
          name: 'Org 2',
          cachedSkills: [{ id: 'skill-b', name: 'Skill B', content: 'b' }],
          cachedCommands: [],
          cachedAgents: [],
        },
      ] as any[];

      const result = mergeTemplates(orgTemplates, [], undefined);

      expect(result.skills).toHaveLength(2);
      expect(result.skills.find((s) => s.id === 'skill-a')).toBeDefined();
      expect(result.skills.find((s) => s.id === 'skill-b')).toBeDefined();
    });
  });

  describe('getSourceCounts', () => {
    it('counts items by source type correctly', async () => {
      const { mergeTemplates, getSourceCounts } = await import('@/lib/config/template-merge');

      const orgTemplates = [
        {
          id: 'org-1',
          name: 'Org',
          cachedSkills: [
            { id: 'org-skill-1', name: 'OS1', content: '' },
            { id: 'org-skill-2', name: 'OS2', content: '' },
          ],
          cachedCommands: [{ name: 'org-cmd', content: '' }],
          cachedAgents: [],
        },
      ] as any[];

      const projectTemplates = [
        {
          id: 'project-1',
          name: 'Project',
          cachedSkills: [{ id: 'project-skill', name: 'PS', content: '' }],
          cachedCommands: [],
          cachedAgents: [{ name: 'project-agent', content: '' }],
        },
      ] as any[];

      const localConfig = {
        skills: [],
        commands: [
          { name: 'local-cmd-1', content: '' },
          { name: 'local-cmd-2', content: '' },
        ],
        agents: [],
      };

      const merged = mergeTemplates(orgTemplates, projectTemplates, localConfig);
      const counts = getSourceCounts(merged);

      expect(counts.org.skills).toBe(2);
      expect(counts.org.commands).toBe(1);
      expect(counts.org.agents).toBe(0);

      expect(counts.project.skills).toBe(1);
      expect(counts.project.commands).toBe(0);
      expect(counts.project.agents).toBe(1);

      expect(counts.local.skills).toBe(0);
      expect(counts.local.commands).toBe(2);
      expect(counts.local.agents).toBe(0);

      expect(counts.total.skills).toBe(3);
      expect(counts.total.commands).toBe(3);
      expect(counts.total.agents).toBe(1);
    });

    it('returns zeros for empty config', async () => {
      const { getSourceCounts } = await import('@/lib/config/template-merge');

      const emptyConfig = {
        skills: [],
        commands: [],
        agents: [],
      };

      const counts = getSourceCounts(emptyConfig as any);

      expect(counts.org.skills).toBe(0);
      expect(counts.project.skills).toBe(0);
      expect(counts.local.skills).toBe(0);
      expect(counts.total.skills).toBe(0);
    });
  });
});

// =============================================================================
// 2. HOT RELOAD TESTS (~5 tests)
// =============================================================================
describe('Hot Reload', () => {
  const originalWatch = fs.watch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error
    fs.watch = originalWatch;
  });

  it('creates watcher for settings.json file', async () => {
    const mockWatcher = {
      close: vi.fn(),
    };

    // @ts-expect-error
    fs.watch = vi.fn().mockReturnValue(mockWatcher);

    const { watchConfig } = await import('@/lib/config/hot-reload');

    const callback = vi.fn();
    watchConfig('/test/project', callback);

    expect(fs.watch).toHaveBeenCalledWith(
      '/test/project/.claude/settings.json',
      expect.any(Function)
    );
  });

  it('returns cleanup function that closes watcher', async () => {
    const mockWatcher = {
      close: vi.fn(),
    };

    // @ts-expect-error
    fs.watch = vi.fn().mockReturnValue(mockWatcher);

    const { watchConfig } = await import('@/lib/config/hot-reload');

    const callback = vi.fn();
    const cleanup = watchConfig('/test/project', callback);

    cleanup();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('calls callback with parsed config on change event', async () => {
    let watchCallback: ((eventType: string) => void) | null = null;

    const mockWatcher = {
      close: vi.fn(),
    };

    // @ts-expect-error
    fs.watch = vi.fn().mockImplementation((_path, cb) => {
      watchCallback = cb;
      return mockWatcher;
    });

    // Mock fs.promises.readFile
    const mockConfig = {
      worktreeRoot: '.trees',
      maxTurns: 100,
      defaultBranch: 'main',
      maxConcurrentAgents: 3,
      allowedTools: ['Read'],
    };

    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(JSON.stringify(mockConfig));

    const { watchConfig } = await import('@/lib/config/hot-reload');

    const callback = vi.fn();
    watchConfig('/test/project', callback);

    // Trigger the change event
    watchCallback?.('change');

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ worktreeRoot: '.trees' }));
  });

  it('does not call callback for non-change events', async () => {
    let watchCallback: ((eventType: string) => void) | null = null;

    const mockWatcher = {
      close: vi.fn(),
    };

    // @ts-expect-error
    fs.watch = vi.fn().mockImplementation((_path, cb) => {
      watchCallback = cb;
      return mockWatcher;
    });

    const { watchConfig } = await import('@/lib/config/hot-reload');

    const callback = vi.fn();
    watchConfig('/test/project', callback);

    // Trigger a rename event (not change)
    watchCallback?.('rename');

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callback).not.toHaveBeenCalled();
  });

  it('handles read errors gracefully', async () => {
    let watchCallback: ((eventType: string) => void) | null = null;

    const mockWatcher = {
      close: vi.fn(),
    };

    // @ts-expect-error
    fs.watch = vi.fn().mockImplementation((_path, cb) => {
      watchCallback = cb;
      return mockWatcher;
    });

    vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('File read failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { watchConfig } = await import('@/lib/config/hot-reload');

    const callback = vi.fn();
    watchConfig('/test/project', callback);

    watchCallback?.('change');

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callback).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Config reload failed:', expect.any(Error));

    consoleSpy.mockRestore();
  });
});

// =============================================================================
// 3. CRYPTO TESTS (~8 tests)
// =============================================================================
describe('Crypto Module', () => {
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalMkdirSync = fs.mkdirSync;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // @ts-expect-error
    fs.existsSync = originalExistsSync;
    // @ts-expect-error
    fs.readFileSync = originalReadFileSync;
    // @ts-expect-error
    fs.writeFileSync = originalWriteFileSync;
    // @ts-expect-error
    fs.mkdirSync = originalMkdirSync;
  });

  // Note: encryptToken/decryptToken tests require full Web Crypto API support
  // which works differently in jsdom vs Bun. Skip in CI (Node.js/jsdom).
  // The tests run correctly in Bun runtime locally.
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  describe.skipIf(isCI)('encryptToken and decryptToken', () => {
    it('encrypts and decrypts token correctly', async () => {
      // Mock key file exists
      const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
      // @ts-expect-error
      fs.existsSync = vi.fn().mockReturnValue(true);
      // @ts-expect-error
      fs.readFileSync = vi.fn().mockReturnValue(Buffer.from(keyMaterial).toString('base64'));

      const { encryptToken, decryptToken } = await import('@/server/crypto');

      const originalToken = 'ghp_test_token_12345';
      const encrypted = await encryptToken(originalToken);
      const decrypted = await decryptToken(encrypted);

      expect(encrypted).not.toBe(originalToken);
      expect(decrypted).toBe(originalToken);
    });

    it('produces different ciphertexts for same plaintext (due to random IV)', async () => {
      const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
      // @ts-expect-error
      fs.existsSync = vi.fn().mockReturnValue(true);
      // @ts-expect-error
      fs.readFileSync = vi.fn().mockReturnValue(Buffer.from(keyMaterial).toString('base64'));

      const { encryptToken } = await import('@/server/crypto');

      const token = 'ghp_same_token';
      const encrypted1 = await encryptToken(token);
      const encrypted2 = await encryptToken(token);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('creates key file if it does not exist', async () => {
      // @ts-expect-error
      fs.existsSync = vi.fn().mockReturnValue(false);
      // @ts-expect-error
      fs.mkdirSync = vi.fn();
      // @ts-expect-error
      fs.writeFileSync = vi.fn();

      const { encryptToken } = await import('@/server/crypto');

      await encryptToken('test-token');

      expect(fs.mkdirSync).toHaveBeenCalledWith('./data', { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith('./data/.keyfile', expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
    });

    it('handles long tokens', async () => {
      const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
      // @ts-expect-error
      fs.existsSync = vi.fn().mockReturnValue(true);
      // @ts-expect-error
      fs.readFileSync = vi.fn().mockReturnValue(Buffer.from(keyMaterial).toString('base64'));

      const { encryptToken, decryptToken } = await import('@/server/crypto');

      const longToken = `github_pat_${'a'.repeat(200)}_${'b'.repeat(200)}_${'c'.repeat(200)}`;
      const encrypted = await encryptToken(longToken);
      const decrypted = await decryptToken(encrypted);

      expect(decrypted).toBe(longToken);
    });

    it('handles unicode characters in token', async () => {
      const keyMaterial = crypto.getRandomValues(new Uint8Array(32));
      // @ts-expect-error
      fs.existsSync = vi.fn().mockReturnValue(true);
      // @ts-expect-error
      fs.readFileSync = vi.fn().mockReturnValue(Buffer.from(keyMaterial).toString('base64'));

      const { encryptToken, decryptToken } = await import('@/server/crypto');

      const unicodeToken = 'token_with_unicode_\u{1F600}_\u{1F389}';
      const encrypted = await encryptToken(unicodeToken);
      const decrypted = await decryptToken(encrypted);

      expect(decrypted).toBe(unicodeToken);
    });
  });

  describe('maskToken', () => {
    it('masks middle of token correctly', async () => {
      const { maskToken } = await import('@/server/crypto');

      const token = 'ghp_1234567890abcdef';
      const masked = maskToken(token);

      expect(masked).toBe(`ghp_${'\u2022'.repeat(8)}cdef`);
      expect(masked.length).toBe(16); // 4 + 8 + 4
    });

    it('returns fully masked string for short tokens', async () => {
      const { maskToken } = await import('@/server/crypto');

      const shortToken = 'short';
      const masked = maskToken(shortToken);

      expect(masked).toBe('\u2022'.repeat(8));
    });

    it('handles tokens exactly 12 characters', async () => {
      const { maskToken } = await import('@/server/crypto');

      const token = '123456789012';
      const masked = maskToken(token);

      expect(masked).toBe('\u2022'.repeat(8));
    });
  });

  describe('isValidPATFormat', () => {
    it('validates classic PAT format (ghp_)', async () => {
      const { isValidPATFormat } = await import('@/server/crypto');

      expect(isValidPATFormat('ghp_abcdef123456')).toBe(true);
      expect(isValidPATFormat('ghp_')).toBe(true);
    });

    it('validates fine-grained PAT format (github_pat_)', async () => {
      const { isValidPATFormat } = await import('@/server/crypto');

      expect(isValidPATFormat('github_pat_abcdef123456')).toBe(true);
      expect(isValidPATFormat('github_pat_')).toBe(true);
    });

    it('rejects invalid PAT formats', async () => {
      const { isValidPATFormat } = await import('@/server/crypto');

      expect(isValidPATFormat('invalid_token')).toBe(false);
      expect(isValidPATFormat('gho_oauth_token')).toBe(false);
      expect(isValidPATFormat('')).toBe(false);
      expect(isValidPATFormat('ghp')).toBe(false);
    });
  });
});

// =============================================================================
// 4. RATE LIMIT TESTS (~5 tests)
// =============================================================================
describe('Rate Limit Module', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('getRateLimitStatus', () => {
    it('fetches and parses rate limit status correctly', async () => {
      const { getRateLimitStatus } = await import('@/lib/github/rate-limit');

      const mockOctokit = {
        rest: {
          rateLimit: {
            get: vi.fn().mockResolvedValue({
              data: {
                rate: {
                  limit: 5000,
                  remaining: 4500,
                  reset: 1700000000,
                  used: 500,
                },
                resources: {
                  search: {
                    limit: 30,
                    remaining: 25,
                    reset: 1700000100,
                    used: 5,
                  },
                  graphql: {
                    limit: 5000,
                    remaining: 4900,
                    reset: 1700000200,
                    used: 100,
                  },
                },
              },
            }),
          },
        },
      };

      const result = await getRateLimitStatus(mockOctokit as any);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.core.limit).toBe(5000);
        expect(result.value.core.remaining).toBe(4500);
        expect(result.value.core.used).toBe(500);
        expect(result.value.core.reset).toBeInstanceOf(Date);

        expect(result.value.search.limit).toBe(30);
        expect(result.value.graphql.limit).toBe(5000);
      }
    });

    it('handles missing graphql resource gracefully', async () => {
      const { getRateLimitStatus } = await import('@/lib/github/rate-limit');

      const mockOctokit = {
        rest: {
          rateLimit: {
            get: vi.fn().mockResolvedValue({
              data: {
                rate: {
                  limit: 5000,
                  remaining: 4500,
                  reset: 1700000000,
                  used: 500,
                },
                resources: {
                  search: {
                    limit: 30,
                    remaining: 25,
                    reset: 1700000100,
                    used: 5,
                  },
                  // No graphql resource
                },
              },
            }),
          },
        },
      };

      const result = await getRateLimitStatus(mockOctokit as any);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.graphql.limit).toBe(0);
        expect(result.value.graphql.remaining).toBe(0);
      }
    });

    it('returns error when API call fails', async () => {
      const { getRateLimitStatus } = await import('@/lib/github/rate-limit');

      const mockOctokit = {
        rest: {
          rateLimit: {
            get: vi.fn().mockRejectedValue(new Error('Network error')),
          },
        },
      };

      const result = await getRateLimitStatus(mockOctokit as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Network error');
      }
    });
  });

  describe('checkRateLimit', () => {
    it('returns ok when remaining requests above threshold', async () => {
      const { checkRateLimit } = await import('@/lib/github/rate-limit');

      const status = {
        core: { limit: 5000, remaining: 100, reset: new Date(), used: 4900 },
        search: { limit: 30, remaining: 25, reset: new Date(), used: 5 },
        graphql: { limit: 5000, remaining: 4900, reset: new Date(), used: 100 },
      };

      const result = checkRateLimit(status);

      expect(result.ok).toBe(true);
    });

    it('returns rate limit error when remaining below threshold', async () => {
      const { checkRateLimit } = await import('@/lib/github/rate-limit');

      const resetTime = new Date(Date.now() + 3600000);
      const status = {
        core: { limit: 5000, remaining: 5, reset: resetTime, used: 4995 },
        search: { limit: 30, remaining: 25, reset: new Date(), used: 5 },
        graphql: { limit: 5000, remaining: 4900, reset: new Date(), used: 100 },
      };

      const result = checkRateLimit(status);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_RATE_LIMITED');
      }
    });
  });

  describe('withRateLimitRetry', () => {
    it('returns result immediately when no rate limit error', async () => {
      const { withRateLimitRetry } = await import('@/lib/github/rate-limit');

      const fn = vi.fn().mockResolvedValue('success');

      const result = await withRateLimitRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 429 status and succeeds', async () => {
      const { withRateLimitRetry } = await import('@/lib/github/rate-limit');

      const resetTime = Math.floor(Date.now() / 1000) + 1; // 1 second from now

      const fn = vi
        .fn()
        .mockRejectedValueOnce({
          status: 429,
          response: { headers: { 'x-ratelimit-reset': String(resetTime) } },
        })
        .mockResolvedValueOnce('success');

      const result = await withRateLimitRetry(fn, { maxRetries: 3 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('calls onRateLimited callback when rate limited', async () => {
      const { withRateLimitRetry } = await import('@/lib/github/rate-limit');

      const resetTime = Math.floor(Date.now() / 1000) + 1;
      const onRateLimited = vi.fn();

      const fn = vi
        .fn()
        .mockRejectedValueOnce({
          status: 429,
          response: { headers: { 'x-ratelimit-reset': String(resetTime) } },
        })
        .mockResolvedValueOnce('success');

      await withRateLimitRetry(fn, { maxRetries: 3, onRateLimited });

      expect(onRateLimited).toHaveBeenCalledWith(expect.any(Date));
    });

    it('throws error after max retries exhausted', async () => {
      const { withRateLimitRetry } = await import('@/lib/github/rate-limit');

      const fn = vi.fn().mockRejectedValue(new Error('Persistent error'));

      await expect(withRateLimitRetry(fn, { maxRetries: 2 })).rejects.toThrow('Persistent error');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});

// =============================================================================
// 5. MARKETPLACE SYNC TESTS (~15 tests)
// =============================================================================
describe('Marketplace Sync Module', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('syncMarketplaceFromGitHub', () => {
    it('fetches plugins from repository successfully', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'commit-sha-123' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [
                  { path: 'plugins/plugin-1', type: 'tree' },
                  { path: 'plugins/plugin-1/SKILL.md', type: 'blob' },
                  { path: 'plugins/plugin-1/README.md', type: 'blob' },
                ],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockResolvedValueOnce({
                data: {
                  content: Buffer.from(
                    '---\nname: Plugin 1\ndescription: A test plugin\nauthor: test\nversion: 1.0.0\ncategory: tools\n---\nContent'
                  ).toString('base64'),
                },
              })
              .mockResolvedValueOnce({
                data: {
                  content: Buffer.from('# Plugin 1\n\nThis is the readme content.').toString(
                    'base64'
                  ),
                },
              }),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sha).toBe('commit-sha-123');
        expect(result.value.plugins).toHaveLength(1);
        expect(result.value.plugins[0].id).toBe('plugin-1');
        expect(result.value.plugins[0].name).toBe('Plugin 1');
        expect(result.value.plugins[0].description).toBe('A test plugin');
        expect(result.value.plugins[0].tags).toContain('official');
      }
    });

    it('handles multiple plugin paths with different tags', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'multi-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [
                  { path: 'plugins/official-plugin', type: 'tree' },
                  { path: 'community/external-plugin', type: 'tree' },
                ],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockResolvedValueOnce({
                data: { content: Buffer.from('---\nname: Official\n---').toString('base64') },
              })
              .mockRejectedValueOnce({ status: 404 }) // No README
              .mockResolvedValueOnce({
                data: { content: Buffer.from('---\nname: External\n---').toString('base64') },
              })
              .mockRejectedValueOnce({ status: 404 }), // No README
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
        additionalPaths: [{ path: 'community', tag: 'external' }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.plugins).toHaveLength(2);

        const official = result.value.plugins.find((p) => p.id === 'official-plugin');
        expect(official?.tags).toContain('official');

        const external = result.value.plugins.find((p) => p.id === 'external-plugin');
        expect(external?.tags).toContain('external');
      }
    });

    it('handles missing SKILL.md by using plugin ID as name', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'no-skill-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [{ path: 'plugins/my-plugin', type: 'tree' }],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockRejectedValueOnce({ status: 404 }) // No SKILL.md
              .mockRejectedValueOnce({ status: 404 }), // No README
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.plugins).toHaveLength(1);
        expect(result.value.plugins[0].id).toBe('my-plugin');
        expect(result.value.plugins[0].name).toBe('my-plugin');
      }
    });

    it('extracts description from README if not in SKILL.md', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'readme-desc-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [{ path: 'plugins/plugin-x', type: 'tree' }],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockResolvedValueOnce({
                data: { content: Buffer.from('---\nname: Plugin X\n---').toString('base64') },
              })
              .mockResolvedValueOnce({
                data: {
                  content: Buffer.from(
                    '# Plugin X\n\nThis is the description from README.'
                  ).toString('base64'),
                },
              }),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.plugins[0].description).toBe('This is the description from README.');
      }
    });

    it('handles empty plugins directory', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'empty-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: { tree: [] },
            }),
          },
          repos: {
            getContent: vi.fn(),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.plugins).toHaveLength(0);
      }
    });

    it('uses custom ref when provided', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'develop-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: { tree: [] },
            }),
          },
          repos: {
            getContent: vi.fn(),
          },
        },
      };

      await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
        ref: 'develop',
      });

      expect(mockOctokit.rest.git.getRef).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'marketplace',
        ref: 'heads/develop',
      });
    });

    it('returns error when getRef fails', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockRejectedValue(new Error('Branch not found')),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to sync marketplace');
        expect(result.error.message).toContain('Branch not found');
      }
    });

    it('handles non-404 errors when fetching SKILL.md', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'error-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [{ path: 'plugins/error-plugin', type: 'tree' }],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockRejectedValueOnce({ status: 500, message: 'Server error' })
              .mockRejectedValueOnce({ status: 404 }),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch SKILL.md'),
        expect.anything()
      );

      consoleSpy.mockRestore();
    });

    it('parses SKILL.md frontmatter with quoted values', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const skillContent = `---
name: "Quoted Plugin"
description: 'Single quoted description'
author: "Test Author"
version: "2.0.0"
category: 'testing'
---
Content`;

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'quoted-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [{ path: 'plugins/quoted-plugin', type: 'tree' }],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockResolvedValueOnce({
                data: { content: Buffer.from(skillContent).toString('base64') },
              })
              .mockRejectedValueOnce({ status: 404 }),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.plugins[0].name).toBe('Quoted Plugin');
        expect(result.value.plugins[0].description).toBe('Single quoted description');
        expect(result.value.plugins[0].author).toBe('Test Author');
        expect(result.value.plugins[0].version).toBe('2.0.0');
        expect(result.value.plugins[0].category).toBe('testing');
      }
    });

    it('handles SKILL.md without frontmatter', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const skillContent = 'Just content without frontmatter';

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'no-fm-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [{ path: 'plugins/no-frontmatter', type: 'tree' }],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockResolvedValueOnce({
                data: { content: Buffer.from(skillContent).toString('base64') },
              })
              .mockRejectedValueOnce({ status: 404 }),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Falls back to plugin ID as name
        expect(result.value.plugins[0].name).toBe('no-frontmatter');
      }
    });

    it('handles unclosed frontmatter', async () => {
      const { syncMarketplaceFromGitHub } = await import('@/lib/github/marketplace-sync');

      const skillContent = `---
name: Unclosed
description: This frontmatter is not closed
Content continues`;

      const mockOctokit = {
        rest: {
          git: {
            getRef: vi.fn().mockResolvedValue({
              data: { object: { sha: 'unclosed-sha' } },
            }),
            getTree: vi.fn().mockResolvedValue({
              data: {
                tree: [{ path: 'plugins/unclosed', type: 'tree' }],
              },
            }),
          },
          repos: {
            getContent: vi
              .fn()
              .mockResolvedValueOnce({
                data: { content: Buffer.from(skillContent).toString('base64') },
              })
              .mockRejectedValueOnce({ status: 404 }),
          },
        },
      };

      const result = await syncMarketplaceFromGitHub({
        octokit: mockOctokit as any,
        owner: 'test-org',
        repo: 'marketplace',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Falls back to plugin ID
        expect(result.value.plugins[0].name).toBe('unclosed');
      }
    });
  });

  describe('parseGitHubMarketplaceUrl', () => {
    it('parses HTTPS GitHub URL', async () => {
      const { parseGitHubMarketplaceUrl } = await import('@/lib/github/marketplace-sync');

      const result = parseGitHubMarketplaceUrl('https://github.com/owner/repo');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('owner');
        expect(result.value.repo).toBe('repo');
      }
    });

    it('parses HTTPS GitHub URL with .git suffix', async () => {
      const { parseGitHubMarketplaceUrl } = await import('@/lib/github/marketplace-sync');

      const result = parseGitHubMarketplaceUrl('https://github.com/owner/repo.git');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('owner');
        expect(result.value.repo).toBe('repo');
      }
    });

    it('parses SSH GitHub URL', async () => {
      const { parseGitHubMarketplaceUrl } = await import('@/lib/github/marketplace-sync');

      const result = parseGitHubMarketplaceUrl('git@github.com:owner/repo.git');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('owner');
        expect(result.value.repo).toBe('repo');
      }
    });

    it('parses simple owner/repo format', async () => {
      const { parseGitHubMarketplaceUrl } = await import('@/lib/github/marketplace-sync');

      const result = parseGitHubMarketplaceUrl('anthropic/marketplace');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('anthropic');
        expect(result.value.repo).toBe('marketplace');
      }
    });

    it('returns error for invalid URL format', async () => {
      const { parseGitHubMarketplaceUrl } = await import('@/lib/github/marketplace-sync');

      const result = parseGitHubMarketplaceUrl('not-a-valid-url');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Invalid GitHub URL format');
      }
    });

    it('returns error for empty string', async () => {
      const { parseGitHubMarketplaceUrl } = await import('@/lib/github/marketplace-sync');

      const result = parseGitHubMarketplaceUrl('');

      expect(result.ok).toBe(false);
    });
  });
});

// =============================================================================
// 6. DATE UTILS TESTS (~5 tests)
// =============================================================================
describe('Date Utils Module', () => {
  describe('toSqliteDate', () => {
    it('converts Date to ISO string', async () => {
      const { toSqliteDate } = await import('@/lib/utils/date');

      const date = new Date('2024-01-15T10:30:00Z');
      const result = toSqliteDate(date);

      expect(result).toBe('2024-01-15T10:30:00.000Z');
    });

    it('returns null for null input', async () => {
      const { toSqliteDate } = await import('@/lib/utils/date');

      expect(toSqliteDate(null)).toBeNull();
    });

    it('returns null for undefined input', async () => {
      const { toSqliteDate } = await import('@/lib/utils/date');

      expect(toSqliteDate(undefined)).toBeNull();
    });
  });

  describe('nowSqlite', () => {
    it('returns current time in ISO format', async () => {
      const { nowSqlite } = await import('@/lib/utils/date');

      const before = new Date().toISOString();
      const result = nowSqlite();
      const after = new Date().toISOString();

      // Result should be a valid ISO string between before and after
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(result >= before).toBe(true);
      expect(result <= after).toBe(true);
    });
  });

  describe('fromSqliteDate', () => {
    it('parses SQLite date string to Date object', async () => {
      const { fromSqliteDate } = await import('@/lib/utils/date');

      const dateStr = '2024-01-15T10:30:00.000Z';
      const result = fromSqliteDate(dateStr);

      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe(dateStr);
    });

    it('returns null for null input', async () => {
      const { fromSqliteDate } = await import('@/lib/utils/date');

      expect(fromSqliteDate(null)).toBeNull();
    });

    it('returns null for undefined input', async () => {
      const { fromSqliteDate } = await import('@/lib/utils/date');

      expect(fromSqliteDate(undefined)).toBeNull();
    });

    it('handles various date string formats', async () => {
      const { fromSqliteDate } = await import('@/lib/utils/date');

      // SQLite datetime format
      const result1 = fromSqliteDate('2024-01-15 10:30:00');
      expect(result1).toBeInstanceOf(Date);

      // ISO format
      const result2 = fromSqliteDate('2024-01-15T10:30:00Z');
      expect(result2).toBeInstanceOf(Date);
    });
  });

  describe('roundtrip conversion', () => {
    it('preserves date through toSqliteDate -> fromSqliteDate', async () => {
      const { toSqliteDate, fromSqliteDate } = await import('@/lib/utils/date');

      const originalDate = new Date('2024-06-15T14:45:30.123Z');
      const sqliteDate = toSqliteDate(originalDate);
      const roundtrip = fromSqliteDate(sqliteDate);

      expect(roundtrip?.getTime()).toBe(originalDate.getTime());
    });
  });
});
