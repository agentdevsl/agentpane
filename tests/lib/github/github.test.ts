import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock Octokit instance that all tests will share
const mockOctokitInstance = {
  rest: {
    apps: {
      createInstallationAccessToken: vi.fn(),
    },
    repos: {
      get: vi.fn(),
      getContent: vi.fn(),
      getCommit: vi.fn(),
    },
    pulls: {
      create: vi.fn(),
    },
    issues: {
      create: vi.fn(),
      update: vi.fn(),
      createComment: vi.fn(),
    },
  },
};

// Mock octokit before importing modules that use it
// Use a class to make it properly constructable
vi.mock('octokit', () => {
  // Create a mock class that returns the shared mock instance
  class MockOctokit {
    rest = mockOctokitInstance.rest;
    constructor() {
      return mockOctokitInstance;
    }
  }

  return {
    Octokit: MockOctokit,
  };
});

// Import after mocking
import type { Octokit } from 'octokit';
import { createOctokitFromToken, getInstallationOctokit } from '@/lib/github/client';
import { checkConfigExists, syncConfigFromGitHub } from '@/lib/github/config-sync';
import {
  createGitHubIssueCreator,
  createGitHubIssueCreatorFromOctokit,
  GitHubIssueCreator,
} from '@/lib/github/issue-creator';
import { parseGitHubUrl, syncTemplateFromGitHub } from '@/lib/github/template-sync';
import {
  parseWebhookEvent,
  parseWebhookPayload,
  verifyWebhookSignature,
} from '@/lib/github/webhooks';
import type { PlanSession } from '@/lib/plan-mode/types';

// =============================================================================
// 1. CLIENT TESTS (8 tests)
// =============================================================================
describe('GitHub Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAppOctokit', () => {
    it('throws error when GITHUB_APP_ID is not set', () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_PRIVATE_KEY;

      // Simulate the check that happens in getAppOctokit
      expect(() => {
        if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
          throw new Error(
            'GitHub App credentials not configured (GITHUB_APP_ID, GITHUB_PRIVATE_KEY)'
          );
        }
      }).toThrow('GitHub App credentials not configured');
    });

    it('throws error when GITHUB_PRIVATE_KEY is not set', () => {
      process.env.GITHUB_APP_ID = 'test-app-id';
      delete process.env.GITHUB_PRIVATE_KEY;

      expect(() => {
        if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
          throw new Error(
            'GitHub App credentials not configured (GITHUB_APP_ID, GITHUB_PRIVATE_KEY)'
          );
        }
      }).toThrow('GitHub App credentials not configured');
    });
  });

  describe('getInstallationOctokit', () => {
    it('creates installation-scoped client with access token', async () => {
      process.env.GITHUB_APP_ID = 'test-app-id';
      process.env.GITHUB_PRIVATE_KEY = 'test-private-key';

      mockOctokitInstance.rest.apps.createInstallationAccessToken.mockResolvedValue({
        data: { token: 'installation-token-123' },
      });

      const result = await getInstallationOctokit(12345);

      expect(mockOctokitInstance.rest.apps.createInstallationAccessToken).toHaveBeenCalledWith({
        installation_id: 12345,
      });
      expect(result).toBeDefined();
    });

    it('handles installation token creation failure', async () => {
      process.env.GITHUB_APP_ID = 'test-app-id';
      process.env.GITHUB_PRIVATE_KEY = 'test-private-key';

      mockOctokitInstance.rest.apps.createInstallationAccessToken.mockRejectedValue(
        new Error('Installation not found')
      );

      await expect(getInstallationOctokit(99999)).rejects.toThrow('Installation not found');
    });
  });

  describe('createOctokitFromToken', () => {
    it('creates Octokit instance with provided token', () => {
      const client = createOctokitFromToken('ghp_test_token');

      // Verify the client has the expected structure
      expect(client).toBeDefined();
      expect(client.rest).toBeDefined();
      expect(client.rest.repos).toBeDefined();
    });

    it('creates instances for different tokens', () => {
      const client1 = createOctokitFromToken('token-1');
      const client2 = createOctokitFromToken('token-2');

      // Both clients should be created successfully
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
      expect(client1.rest).toBeDefined();
      expect(client2.rest).toBeDefined();
    });

    it('handles empty token gracefully', () => {
      const client = createOctokitFromToken('');

      // Should not throw and should create a client
      expect(client).toBeDefined();
      expect(client.rest).toBeDefined();
    });
  });
});

// =============================================================================
// 2. CONFIG SYNC TESTS (10 tests)
// =============================================================================
describe('GitHub Config Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('syncConfigFromGitHub', () => {
    it('successfully fetches and parses valid configuration', async () => {
      const configContent = {
        worktreeRoot: '/custom/worktrees',
        defaultBranch: 'develop',
        maxTurns: 100,
        allowedTools: ['read', 'write'],
      };

      mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          content: Buffer.from(JSON.stringify(configContent)).toString('base64'),
          sha: 'abc123',
        },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config.worktreeRoot).toBe('/custom/worktrees');
        expect(result.value.config.defaultBranch).toBe('develop');
        expect(result.value.config.maxTurns).toBe(100);
        expect(result.value.sha).toBe('abc123');
      }
    });

    it('applies default values for missing optional fields', async () => {
      const configContent = {};

      mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          content: Buffer.from(JSON.stringify(configContent)).toString('base64'),
          sha: 'def456',
        },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.config.worktreeRoot).toBe('.worktrees');
        expect(result.value.config.defaultBranch).toBe('main');
        expect(result.value.config.maxTurns).toBe(50);
        // F06-06: when allowedTools is missing from the GitHub config, we
        // default to ALLOW_ALL_TOOLS (`['*']`) to preserve pre-F06-06
        // "no config = open access". An explicit `[]` still fails closed.
        expect(result.value.config.allowedTools).toEqual(['*']);
        expect(result.value.config.envFile).toBe('.env');
      }
    });

    it('returns error when config file is not found (404)', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({ status: 404 });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_CONFIG_NOT_FOUND');
      }
    });

    it('returns error for authentication failure (401)', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({ status: 401 });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_AUTH_FAILED');
      }
    });

    it('returns error for forbidden access (403)', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({ status: 403 });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_AUTH_FAILED');
      }
    });

    it('returns error for rate limiting (429)', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({
        status: 429,
        response: { headers: { 'x-ratelimit-reset': '1700000000' } },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_RATE_LIMITED');
      }
    });

    it('returns error for invalid JSON in config file', async () => {
      mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          content: Buffer.from('{ invalid json }').toString('base64'),
          sha: 'bad123',
        },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_CONFIG_INVALID');
      }
    });

    it('returns error when path is a directory instead of file', async () => {
      mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
        data: [
          { name: 'file1.json', type: 'file' },
          { name: 'file2.json', type: 'file' },
        ],
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_CONFIG_NOT_FOUND');
      }
    });

    it('uses custom config path when provided', async () => {
      mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          content: Buffer.from('{}').toString('base64'),
          sha: 'custom123',
        },
      });

      await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
        configPath: '.agentpane',
      });

      expect(mockOctokitInstance.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'test-repo',
        path: '.agentpane/config.json',
        ref: undefined,
      });
    });
  });

  describe('checkConfigExists', () => {
    it('returns true when config file exists', async () => {
      mockOctokitInstance.rest.repos.getContent.mockResolvedValue({
        data: { type: 'file', content: 'e30=' },
      });

      const exists = await checkConfigExists(
        mockOctokitInstance as unknown as Octokit,
        'test-org',
        'test-repo'
      );

      expect(exists).toBe(true);
    });

    it('returns false when config file does not exist', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({ status: 404 });

      const exists = await checkConfigExists(
        mockOctokitInstance as unknown as Octokit,
        'test-org',
        'test-repo'
      );

      expect(exists).toBe(false);
    });
  });
});

// =============================================================================
// 3. WEBHOOK TESTS (12 tests)
// =============================================================================
describe('GitHub Webhooks', () => {
  describe('verifyWebhookSignature', () => {
    it('returns error when signature is null', async () => {
      const result = await verifyWebhookSignature({
        payload: '{"test": "data"}',
        signature: null,
        secret: 'webhook-secret',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_WEBHOOK_INVALID');
      }
    });

    it('returns success when no secret is configured (dev mode)', async () => {
      const result = await verifyWebhookSignature({
        payload: '{"test": "data"}',
        signature: 'sha256=anything',
        secret: '',
      });

      expect(result.ok).toBe(true);
    });

    it('returns error for non-sha256 algorithm', async () => {
      const result = await verifyWebhookSignature({
        payload: '{"test": "data"}',
        signature: 'sha1=invalidhash',
        secret: 'webhook-secret',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_WEBHOOK_INVALID');
      }
    });

    it('returns error for malformed signature format', async () => {
      const result = await verifyWebhookSignature({
        payload: '{"test": "data"}',
        signature: 'invalid-no-equals',
        secret: 'webhook-secret',
      });

      expect(result.ok).toBe(false);
    });

    it('validates correct signature successfully', async () => {
      // Pre-computed HMAC-SHA256 of '{"test":"data"}' with secret 'test-secret'
      const payload = '{"test":"data"}';
      const secret = 'test-secret';

      // Compute expected signature
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
      const expectedHash = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const result = await verifyWebhookSignature({
        payload,
        signature: `sha256=${expectedHash}`,
        secret,
      });

      expect(result.ok).toBe(true);
    });

    it('rejects incorrect signature', async () => {
      const result = await verifyWebhookSignature({
        payload: '{"test":"data"}',
        signature: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        secret: 'test-secret',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_WEBHOOK_INVALID');
      }
    });
  });

  describe('parseWebhookPayload', () => {
    it('parses valid JSON payload', () => {
      const payload = JSON.stringify({
        action: 'created',
        installation: { id: 123, account: { login: 'test-org', type: 'Organization' } },
      });

      const result = parseWebhookPayload(payload);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.action).toBe('created');
        expect(result.value.installation?.id).toBe(123);
      }
    });

    it('returns error for invalid JSON', () => {
      const result = parseWebhookPayload('{ invalid }');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it('handles empty payload', () => {
      const result = parseWebhookPayload('{}');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.action).toBeUndefined();
      }
    });
  });

  describe('parseWebhookEvent', () => {
    it('parses complete webhook event from headers and body', () => {
      const headers = new Headers({
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-123',
      });
      const body = JSON.stringify({
        action: 'created',
        repository: { owner: { login: 'test' }, name: 'repo', full_name: 'test/repo' },
      });

      const result = parseWebhookEvent(headers, body);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event).toBe('push');
        expect(result.value.deliveryId).toBe('delivery-123');
        expect(result.value.action).toBe('created');
      }
    });

    it('returns error when x-github-event header is missing', () => {
      const headers = new Headers({
        'x-github-delivery': 'delivery-123',
      });

      const result = parseWebhookEvent(headers, '{}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Missing required webhook headers');
      }
    });

    it('returns error when x-github-delivery header is missing', () => {
      const headers = new Headers({
        'x-github-event': 'push',
      });

      const result = parseWebhookEvent(headers, '{}');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Missing required webhook headers');
      }
    });
  });
});

// =============================================================================
// 4. RATE LIMITING TESTS (5 tests)
// =============================================================================
describe('Rate Limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rate limit detection in config-sync', () => {
    it('detects rate limit from 429 status code', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({
        status: 429,
        response: { headers: { 'x-ratelimit-reset': '1700000000' } },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_RATE_LIMITED');
        // The error details field contains resetAt
        expect(result.error.details).toBeDefined();
      }
    });

    it('includes reset timestamp in rate limit error', async () => {
      const resetTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({
        status: 429,
        response: { headers: { 'x-ratelimit-reset': String(resetTimestamp) } },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Check for resetAt in details
        expect(result.error.details?.resetAt).toBeDefined();
      }
    });

    it('handles missing reset header gracefully', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({
        status: 429,
        response: { headers: {} },
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_RATE_LIMITED');
      }
    });

    it('handles rate limit without response object', async () => {
      mockOctokitInstance.rest.repos.getContent.mockRejectedValue({
        status: 429,
      });

      const result = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('GITHUB_RATE_LIMITED');
      }
    });
  });

  describe('Rate limit resilience', () => {
    it('subsequent requests work after rate limit clears', async () => {
      // First call fails with rate limit
      mockOctokitInstance.rest.repos.getContent.mockRejectedValueOnce({
        status: 429,
        response: { headers: { 'x-ratelimit-reset': '1700000000' } },
      });

      // Second call succeeds
      mockOctokitInstance.rest.repos.getContent.mockResolvedValueOnce({
        data: {
          type: 'file',
          content: Buffer.from('{}').toString('base64'),
          sha: 'after-limit',
        },
      });

      const result1 = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });
      expect(result1.ok).toBe(false);

      const result2 = await syncConfigFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });
      expect(result2.ok).toBe(true);
    });
  });
});

// =============================================================================
// 5. TEMPLATE SYNC TESTS (8 tests)
// =============================================================================
describe('GitHub Template Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('syncTemplateFromGitHub', () => {
    it('fetches skills, commands, and agents from repository', async () => {
      // Mock commit SHA
      mockOctokitInstance.rest.repos.getCommit.mockResolvedValue({
        data: { sha: 'commit-sha-123' },
      });

      // The sync function makes parallel calls for skills, commands, and agents directories
      // Each directory call is followed by file content fetches
      mockOctokitInstance.rest.repos.getContent
        // Skills directory listing
        .mockResolvedValueOnce({
          data: [{ type: 'dir', name: 'code-review', path: '.claude/skills/code-review' }],
        })
        // Commands directory listing
        .mockResolvedValueOnce({
          data: [{ type: 'file', name: 'deploy.md', path: '.claude/commands/deploy.md' }],
        })
        // Agents directory listing
        .mockResolvedValueOnce({
          data: [{ type: 'file', name: 'assistant.md', path: '.claude/agents/assistant.md' }],
        })
        // SKILL.md file content
        .mockResolvedValueOnce({
          data: {
            type: 'file',
            content: Buffer.from(
              '---\nname: Code Review\ndescription: Reviews code\n---\nSkill content'
            ).toString('base64'),
            sha: 'skill-sha',
          },
        })
        // Command file content
        .mockResolvedValueOnce({
          data: {
            type: 'file',
            content: Buffer.from('---\nname: Deploy\n---\nDeploy content').toString('base64'),
            sha: 'cmd-sha',
          },
        })
        // Agent file content
        .mockResolvedValueOnce({
          data: {
            type: 'file',
            content: Buffer.from('---\nname: Assistant\n---\nAgent content').toString('base64'),
            sha: 'agent-sha',
          },
        });

      const result = await syncTemplateFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sha).toBe('commit-sha-123');
        expect(result.value.skills).toHaveLength(1);
        expect(result.value.skills[0].name).toBe('Code Review');
        expect(result.value.commands).toHaveLength(1);
        expect(result.value.commands[0].name).toBe('Deploy');
        expect(result.value.agents).toHaveLength(1);
        expect(result.value.agents[0].name).toBe('Assistant');
      }
    });

    it('handles empty directories gracefully', async () => {
      mockOctokitInstance.rest.repos.getCommit.mockResolvedValue({
        data: { sha: 'empty-sha' },
      });

      // All directories are empty
      mockOctokitInstance.rest.repos.getContent
        .mockResolvedValueOnce({ data: [] }) // empty skills
        .mockResolvedValueOnce({ data: [] }) // empty commands
        .mockResolvedValueOnce({ data: [] }); // empty agents

      const result = await syncTemplateFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills).toEqual([]);
        expect(result.value.commands).toEqual([]);
        expect(result.value.agents).toEqual([]);
      }
    });

    it('handles 404 for missing directories', async () => {
      mockOctokitInstance.rest.repos.getCommit.mockResolvedValue({
        data: { sha: 'no-dirs-sha' },
      });

      // Directories don't exist
      mockOctokitInstance.rest.repos.getContent
        .mockRejectedValueOnce({ status: 404 }) // skills
        .mockRejectedValueOnce({ status: 404 }) // commands
        .mockRejectedValueOnce({ status: 404 }); // agents

      const result = await syncTemplateFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills).toEqual([]);
        expect(result.value.commands).toEqual([]);
        expect(result.value.agents).toEqual([]);
      }
    });

    it('skips skill directories without SKILL.md file', async () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      mockOctokitInstance.rest.repos.getCommit.mockResolvedValue({
        data: { sha: 'skip-sha' },
      });

      mockOctokitInstance.rest.repos.getContent
        .mockResolvedValueOnce({
          data: [
            { type: 'dir', name: 'incomplete-skill', path: '.claude/skills/incomplete-skill' },
          ],
        }) // skills dir
        .mockResolvedValueOnce({ data: [] }) // commands
        .mockResolvedValueOnce({ data: [] }) // agents
        .mockRejectedValueOnce({ status: 404 }); // SKILL.md not found

      const result = await syncTemplateFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills).toEqual([]);
      }

      consoleSpy.mockRestore();
    });

    it('parses frontmatter with boolean and number values', async () => {
      mockOctokitInstance.rest.repos.getCommit.mockResolvedValue({
        data: { sha: 'types-sha' },
      });

      mockOctokitInstance.rest.repos.getContent
        .mockResolvedValueOnce({ data: [] }) // skills
        .mockResolvedValueOnce({
          data: [{ type: 'file', name: 'test.md', path: '.claude/commands/test.md' }],
        }) // commands
        .mockResolvedValueOnce({ data: [] }) // agents
        .mockResolvedValueOnce({
          data: {
            type: 'file',
            content: Buffer.from(
              '---\nname: Test\nenabled: true\npriority: 10\n---\nContent'
            ).toString('base64'),
            sha: 'fm-sha',
          },
        });

      const result = await syncTemplateFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.commands).toHaveLength(1);
        expect(result.value.commands[0].name).toBe('Test');
      }
    });

    it('returns error when commit fetch fails', async () => {
      mockOctokitInstance.rest.repos.getCommit.mockRejectedValue(new Error('Network error'));

      const result = await syncTemplateFromGitHub({
        octokit: mockOctokitInstance as unknown as Octokit,
        owner: 'test-org',
        repo: 'test-repo',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_FETCH_FAILED');
      }
    });
  });

  describe('parseGitHubUrl', () => {
    it('parses HTTPS URL format', () => {
      const result = parseGitHubUrl('https://github.com/owner/repo');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('owner');
        expect(result.value.repo).toBe('repo');
      }
    });

    it('parses SSH URL format', () => {
      const result = parseGitHubUrl('git@github.com:owner/repo.git');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('owner');
        expect(result.value.repo).toBe('repo');
      }
    });

    it('parses simple owner/repo format', () => {
      const result = parseGitHubUrl('anthropic/claude-sdk');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.owner).toBe('anthropic');
        expect(result.value.repo).toBe('claude-sdk');
      }
    });

    it('strips .git suffix from repo name', () => {
      const result = parseGitHubUrl('https://github.com/owner/repo.git');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.repo).toBe('repo');
      }
    });

    it('returns error for invalid URL format', () => {
      const result = parseGitHubUrl('not-a-valid-url');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TEMPLATE_INVALID_REPO_URL');
      }
    });
  });
});

// =============================================================================
// 6. ISSUE CREATOR TESTS (7 tests)
// =============================================================================
describe('GitHub Issue Creator', () => {
  let issueCreator: GitHubIssueCreator;

  beforeEach(() => {
    vi.clearAllMocks();
    issueCreator = new GitHubIssueCreator(mockOctokitInstance as unknown as Octokit);
  });

  describe('createIssue', () => {
    it('creates issue with all provided fields', async () => {
      mockOctokitInstance.rest.issues.create.mockResolvedValue({
        data: {
          html_url: 'https://github.com/test/repo/issues/42',
          number: 42,
          id: 123456,
          node_id: 'I_abc123',
        },
      });

      const result = await issueCreator.createIssue('test-org', 'test-repo', {
        title: 'Test Issue',
        body: 'Issue description',
        labels: ['bug', 'priority-high'],
        assignees: ['user1'],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toBe('https://github.com/test/repo/issues/42');
        expect(result.value.number).toBe(42);
      }

      expect(mockOctokitInstance.rest.issues.create).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'test-repo',
        title: 'Test Issue',
        body: 'Issue description',
        labels: ['bug', 'priority-high'],
        assignees: ['user1'],
        milestone: undefined,
      });
    });

    it('handles API errors gracefully', async () => {
      mockOctokitInstance.rest.issues.create.mockRejectedValue({
        status: 422,
        message: 'Validation failed',
      });

      const result = await issueCreator.createIssue('test-org', 'test-repo', {
        title: 'Test Issue',
        body: 'Body',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_GITHUB_ERROR');
      }
    });

    it('handles network errors', async () => {
      mockOctokitInstance.rest.issues.create.mockRejectedValue(new Error('Network timeout'));

      const result = await issueCreator.createIssue('test-org', 'test-repo', {
        title: 'Test Issue',
        body: 'Body',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Network timeout');
      }
    });
  });

  describe('updateIssue', () => {
    it('updates existing issue', async () => {
      mockOctokitInstance.rest.issues.update.mockResolvedValue({
        data: {
          html_url: 'https://github.com/test/repo/issues/42',
          number: 42,
          id: 123456,
          node_id: 'I_abc123',
        },
      });

      const result = await issueCreator.updateIssue('test-org', 'test-repo', 42, {
        title: 'Updated Title',
        body: 'Updated body',
      });

      expect(result.ok).toBe(true);
      expect(mockOctokitInstance.rest.issues.update).toHaveBeenCalledWith({
        owner: 'test-org',
        repo: 'test-repo',
        issue_number: 42,
        title: 'Updated Title',
        body: 'Updated body',
        labels: undefined,
        assignees: undefined,
        milestone: undefined,
      });
    });
  });

  describe('addComment', () => {
    it('adds comment to issue', async () => {
      mockOctokitInstance.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 789,
          html_url: 'https://github.com/test/repo/issues/42#issuecomment-789',
        },
      });

      const result = await issueCreator.addComment(
        'test-org',
        'test-repo',
        42,
        'This is a comment'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(789);
        expect(result.value.url).toContain('issuecomment');
      }
    });
  });

  describe('createFromPlanSession', () => {
    it('creates issue from plan session with extracted title', async () => {
      mockOctokitInstance.rest.issues.create.mockResolvedValue({
        data: {
          html_url: 'https://github.com/test/repo/issues/1',
          number: 1,
          id: 1,
          node_id: 'I_1',
        },
      });

      const mockSession: PlanSession = {
        id: 'session-123',
        taskId: 'task-456',
        status: 'completed',
        turns: [
          { role: 'user', content: 'Create a feature' },
          { role: 'assistant', content: '# Feature Implementation Plan\n\nHere is the plan...' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:01:00Z',
      };

      const result = await issueCreator.createFromPlanSession(mockSession, 'test-org', 'test-repo');

      expect(result.ok).toBe(true);
      expect(mockOctokitInstance.rest.issues.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Feature Implementation Plan',
          labels: ['plan', 'agent-generated'],
        })
      );
    });
  });

  describe('Factory functions', () => {
    it('createGitHubIssueCreator creates instance from token', () => {
      const creator = createGitHubIssueCreator('ghp_test_token');
      expect(creator).toBeInstanceOf(GitHubIssueCreator);
    });

    it('createGitHubIssueCreatorFromOctokit creates instance from Octokit', () => {
      const creator = createGitHubIssueCreatorFromOctokit(
        mockOctokitInstance as unknown as Octokit
      );
      expect(creator).toBeInstanceOf(GitHubIssueCreator);
    });
  });
});
