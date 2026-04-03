/**
 * Integration tests for GitHub integration modules.
 *
 * Covers:
 * - template-sync.ts: parseGitHubUrl, syncTemplateFromGitHub
 * - issue-creator.ts: GitHubIssueCreator
 * - webhooks.ts: verifyWebhookSignature, parseWebhookPayload, parseWebhookEvent
 *
 * IT-IDs: IT-1884 through IT-1919
 */
import { describe, expect, it, vi } from 'vitest';

// Mock logger to suppress output
vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GitHubIssueCreator } from '../../src/lib/github/issue-creator';
import { parseGitHubUrl, syncTemplateFromGitHub } from '../../src/lib/github/template-sync';
import {
  parseWebhookEvent,
  parseWebhookPayload,
  verifyWebhookSignature,
} from '../../src/lib/github/webhooks';

// ── parseGitHubUrl ──────────────────────────────────────────────────────────

describe('parseGitHubUrl', () => {
  it('IT-1884: parses owner/repo format', () => {
    const result = parseGitHubUrl('acme/my-repo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.owner).toBe('acme');
      expect(result.value.repo).toBe('my-repo');
    }
  });

  it('IT-1885: parses HTTPS URL', () => {
    const result = parseGitHubUrl('https://github.com/acme/my-repo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.owner).toBe('acme');
      expect(result.value.repo).toBe('my-repo');
    }
  });

  it('IT-1886: parses HTTPS URL with .git suffix', () => {
    const result = parseGitHubUrl('https://github.com/acme/my-repo.git');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repo).toBe('my-repo');
    }
  });

  it('IT-1887: parses SSH URL', () => {
    const result = parseGitHubUrl('git@github.com:acme/my-repo.git');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.owner).toBe('acme');
      expect(result.value.repo).toBe('my-repo');
    }
  });

  it('IT-1888: returns error for invalid URL', () => {
    const result = parseGitHubUrl('not-a-url');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TEMPLATE_INVALID_REPO_URL');
    }
  });

  it('IT-1889: handles repo names with dots', () => {
    const result = parseGitHubUrl('acme/my.repo.v2');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repo).toBe('my.repo.v2');
    }
  });
});

// ── syncTemplateFromGitHub ──────────────────────────────────────────────────

describe('syncTemplateFromGitHub', () => {
  function createMockOctokit(overrides?: {
    getContent?: (params: { path: string }) => Promise<unknown>;
    getCommit?: () => Promise<unknown>;
  }) {
    const getContent =
      overrides?.getContent ??
      (async (_params: { path: string }) => ({
        data: [],
      }));

    const getCommit =
      overrides?.getCommit ??
      (async () => ({
        data: { sha: 'abc123' },
      }));

    return {
      rest: {
        repos: {
          getContent,
          getCommit,
        },
      },
    } as unknown as import('octokit').Octokit;
  }

  it('IT-1890: returns skills, commands, agents, and sha', async () => {
    const octokit = createMockOctokit();
    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toEqual([]);
      expect(result.value.commands).toEqual([]);
      expect(result.value.agents).toEqual([]);
      expect(result.value.sha).toBe('abc123');
    }
  });

  it('IT-1891: fetches skills from .claude/skills/ directory', async () => {
    const octokit = createMockOctokit({
      getContent: async (params: { path: string }) => {
        if (params.path === '.claude/skills') {
          return {
            data: [{ type: 'dir', name: 'deploy', path: '.claude/skills/deploy' }],
          };
        }
        if (params.path === '.claude/skills/deploy/SKILL.md') {
          return {
            data: {
              type: 'file',
              name: 'SKILL.md',
              path: '.claude/skills/deploy/SKILL.md',
              sha: 'skill-sha',
              content: Buffer.from(
                '---\nname: Deploy Skill\ndescription: Deploy to prod\ntags: deploy, ci\n---\nDeploy content here'
              ).toString('base64'),
              encoding: 'base64',
            },
          };
        }
        // Default: empty directory
        return { data: [] };
      },
    });

    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toHaveLength(1);
      expect(result.value.skills[0]).toMatchObject({
        id: 'deploy',
        name: 'Deploy Skill',
        description: 'Deploy to prod',
        content: 'Deploy content here',
      });
      expect(result.value.skills[0].tags).toEqual(['deploy', 'ci']);
    }
  });

  it('IT-1892: fetches commands from .claude/commands/ directory', async () => {
    const octokit = createMockOctokit({
      getContent: async (params: { path: string }) => {
        if (params.path === '.claude/commands') {
          return {
            data: [{ type: 'file', name: 'lint.md', path: '.claude/commands/lint.md' }],
          };
        }
        if (params.path === '.claude/commands/lint.md') {
          return {
            data: {
              type: 'file',
              name: 'lint.md',
              path: '.claude/commands/lint.md',
              sha: 'cmd-sha',
              content: Buffer.from(
                '---\nname: Lint Command\ndescription: Run linter\n---\nLint all the things'
              ).toString('base64'),
              encoding: 'base64',
            },
          };
        }
        return { data: [] };
      },
    });

    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commands).toHaveLength(1);
      expect(result.value.commands[0]).toMatchObject({
        name: 'Lint Command',
        description: 'Run linter',
        content: 'Lint all the things',
      });
    }
  });

  it('IT-1893: fetches agents from .claude/agents/ directory', async () => {
    const octokit = createMockOctokit({
      getContent: async (params: { path: string }) => {
        if (params.path === '.claude/agents') {
          return {
            data: [{ type: 'file', name: 'reviewer.md', path: '.claude/agents/reviewer.md' }],
          };
        }
        if (params.path === '.claude/agents/reviewer.md') {
          return {
            data: {
              type: 'file',
              name: 'reviewer.md',
              path: '.claude/agents/reviewer.md',
              sha: 'agent-sha',
              content: Buffer.from(
                '---\nname: Code Reviewer\ndescription: Reviews PRs\n---\nReview content'
              ).toString('base64'),
              encoding: 'base64',
            },
          };
        }
        return { data: [] };
      },
    });

    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agents).toHaveLength(1);
      expect(result.value.agents[0]).toMatchObject({
        name: 'Code Reviewer',
        description: 'Reviews PRs',
        content: 'Review content',
      });
    }
  });

  it('IT-1894: returns error when getCommit fails', async () => {
    const octokit = createMockOctokit({
      getCommit: async () => {
        throw new Error('Network error');
      },
    });

    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TEMPLATE_FETCH_FAILED');
    }
  });

  it('IT-1895: handles 404 for missing directories gracefully (returns empty)', async () => {
    const octokit = createMockOctokit({
      getContent: async () => {
        const err = new Error('Not found') as Error & { status: number };
        err.status = 404;
        throw err;
      },
    });

    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toEqual([]);
      expect(result.value.commands).toEqual([]);
      expect(result.value.agents).toEqual([]);
    }
  });

  it('IT-1896: uses custom configPath', async () => {
    const paths: string[] = [];
    const octokit = createMockOctokit({
      getContent: async (params: { path: string }) => {
        paths.push(params.path);
        return { data: [] };
      },
    });

    await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
      configPath: '.agentpane',
    });
    // Should use .agentpane prefix instead of .claude
    expect(paths.some((p) => p.startsWith('.agentpane/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('.claude/'))).toBe(false);
  });

  it('IT-1897: skips non-directory entries in skills', async () => {
    const octokit = createMockOctokit({
      getContent: async (params: { path: string }) => {
        if (params.path === '.claude/skills') {
          return {
            data: [{ type: 'file', name: 'README.md', path: '.claude/skills/README.md' }],
          };
        }
        return { data: [] };
      },
    });

    const result = await syncTemplateFromGitHub({
      octokit,
      owner: 'acme',
      repo: 'templates',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toEqual([]);
    }
  });
});

// ── GitHubIssueCreator ──────────────────────────────────────────────────────

describe('GitHubIssueCreator', () => {
  function createMockOctokit(overrides?: {
    create?: (params: unknown) => Promise<unknown>;
    update?: (params: unknown) => Promise<unknown>;
    createComment?: (params: unknown) => Promise<unknown>;
  }) {
    return {
      rest: {
        issues: {
          create:
            overrides?.create ??
            (async () => ({
              data: {
                html_url: 'https://github.com/acme/repo/issues/42',
                number: 42,
                id: 12345,
                node_id: 'I_abc123',
              },
            })),
          update:
            overrides?.update ??
            (async () => ({
              data: {
                html_url: 'https://github.com/acme/repo/issues/42',
                number: 42,
                id: 12345,
                node_id: 'I_abc123',
              },
            })),
          createComment:
            overrides?.createComment ??
            (async () => ({
              data: {
                id: 99,
                html_url: 'https://github.com/acme/repo/issues/42#issuecomment-99',
              },
            })),
        },
      },
    } as unknown as import('octokit').Octokit;
  }

  it('IT-1898: creates an issue with proper formatting', async () => {
    const captured: unknown[] = [];
    const octokit = createMockOctokit({
      create: async (params: unknown) => {
        captured.push(params);
        return {
          data: {
            html_url: 'https://github.com/acme/repo/issues/1',
            number: 1,
            id: 100,
            node_id: 'I_node1',
          },
        };
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    const result = await creator.createIssue('acme', 'repo', {
      title: 'Test Issue',
      body: 'Test body',
      labels: ['bug'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBe('https://github.com/acme/repo/issues/1');
      expect(result.value.number).toBe(1);
    }
    expect(captured[0]).toMatchObject({
      owner: 'acme',
      repo: 'repo',
      title: 'Test Issue',
      body: 'Test body',
      labels: ['bug'],
    });
  });

  it('IT-1899: returns error on GitHub API failure', async () => {
    const octokit = createMockOctokit({
      create: async () => {
        const error = new Error('Validation failed') as Error & { status: number };
        error.status = 422;
        throw error;
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    const result = await creator.createIssue('acme', 'repo', {
      title: 'Test',
      body: 'body',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_GITHUB_ERROR');
    }
  });

  it('IT-1900: createFromToolInput adds plan and agent-generated labels', async () => {
    const captured: unknown[] = [];
    const octokit = createMockOctokit({
      create: async (params: unknown) => {
        captured.push(params);
        return {
          data: {
            html_url: 'https://github.com/acme/repo/issues/2',
            number: 2,
            id: 200,
            node_id: 'I_node2',
          },
        };
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    await creator.createFromToolInput(
      { title: 'Feature', body: 'Implement X', labels: ['enhancement'] },
      'acme',
      'repo'
    );

    const params = captured[0] as { labels: string[] };
    expect(params.labels).toContain('plan');
    expect(params.labels).toContain('agent-generated');
    expect(params.labels).toContain('enhancement');
  });

  it('IT-1901: createFromPlanSession extracts title from assistant turns', async () => {
    const captured: unknown[] = [];
    const octokit = createMockOctokit({
      create: async (params: unknown) => {
        captured.push(params);
        return {
          data: {
            html_url: 'https://github.com/acme/repo/issues/3',
            number: 3,
            id: 300,
            node_id: 'I_node3',
          },
        };
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    const session = {
      id: 'session-1',
      taskId: 'task-1',
      codespaceId: 'cs-1',
      status: 'completed' as const,
      turns: [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Build a login page',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: 'turn-2',
          role: 'assistant' as const,
          content: '# Login Page Implementation\n\nHere is the plan...',
          timestamp: '2024-01-01T00:01:00Z',
        },
      ],
      createdAt: '2024-01-01T00:00:00Z',
    };

    await creator.createFromPlanSession(session, 'acme', 'repo');

    const params = captured[0] as { title: string; body: string };
    expect(params.title).toBe('Login Page Implementation');
    expect(params.body).toContain('# Login Page Implementation');
    expect(params.body).toContain('Planning Session Summary');
  });

  it('IT-1902: createFromPlanSession uses override title/body when provided', async () => {
    const captured: unknown[] = [];
    const octokit = createMockOctokit({
      create: async (params: unknown) => {
        captured.push(params);
        return {
          data: {
            html_url: 'https://github.com/acme/repo/issues/4',
            number: 4,
            id: 400,
            node_id: 'I_node4',
          },
        };
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    const session = {
      id: 'session-1',
      taskId: 'task-1',
      codespaceId: 'cs-1',
      status: 'completed' as const,
      turns: [],
      createdAt: '2024-01-01T00:00:00Z',
    };

    await creator.createFromPlanSession(session, 'acme', 'repo', 'Custom Title', 'Custom Body');

    const params = captured[0] as { title: string; body: string };
    expect(params.title).toBe('Custom Title');
    expect(params.body).toBe('Custom Body');
  });

  it('IT-1903: updateIssue sends PATCH to GitHub', async () => {
    const captured: unknown[] = [];
    const octokit = createMockOctokit({
      update: async (params: unknown) => {
        captured.push(params);
        return {
          data: {
            html_url: 'https://github.com/acme/repo/issues/42',
            number: 42,
            id: 12345,
            node_id: 'I_abc123',
          },
        };
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    const result = await creator.updateIssue('acme', 'repo', 42, {
      title: 'Updated Title',
    });

    expect(result.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      owner: 'acme',
      repo: 'repo',
      issue_number: 42,
      title: 'Updated Title',
    });
  });

  it('IT-1904: addComment creates a comment on an issue', async () => {
    const captured: unknown[] = [];
    const octokit = createMockOctokit({
      createComment: async (params: unknown) => {
        captured.push(params);
        return {
          data: {
            id: 99,
            html_url: 'https://github.com/acme/repo/issues/42#issuecomment-99',
          },
        };
      },
    });

    const creator = new GitHubIssueCreator(octokit);
    const result = await creator.addComment('acme', 'repo', 42, 'Great work!');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(99);
    }
    expect(captured[0]).toMatchObject({
      owner: 'acme',
      repo: 'repo',
      issue_number: 42,
      body: 'Great work!',
    });
  });
});

// ── Webhook Signature Verification ──────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  it('IT-1905: returns error for missing signature', async () => {
    const result = await verifyWebhookSignature({
      payload: '{}',
      signature: null,
      secret: 'my-secret',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('GITHUB_WEBHOOK_INVALID');
    }
  });

  it('IT-1906: returns ok when secret is empty (bypass mode)', async () => {
    const result = await verifyWebhookSignature({
      payload: '{}',
      signature: 'sha256=anything',
      secret: '',
    });
    expect(result.ok).toBe(true);
  });

  it('IT-1907: returns error for non-sha256 algorithm', async () => {
    const result = await verifyWebhookSignature({
      payload: '{}',
      signature: 'sha1=abc123',
      secret: 'my-secret',
    });
    expect(result.ok).toBe(false);
  });

  it('IT-1908: returns error for signature without hash part', async () => {
    const result = await verifyWebhookSignature({
      payload: '{}',
      signature: 'sha256=',
      secret: 'my-secret',
    });
    // split('=') on 'sha256=' gives ['sha256', ''] — hash is empty string which is falsy
    expect(result.ok).toBe(false);
  });

  it('IT-1909: validates correct HMAC signature', async () => {
    const secret = 'test-webhook-secret';
    const payload = '{"action":"opened"}';

    // Compute expected HMAC
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const computedHash = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const result = await verifyWebhookSignature({
      payload,
      signature: `sha256=${computedHash}`,
      secret,
    });
    expect(result.ok).toBe(true);
  });

  it('IT-1910: rejects incorrect HMAC signature', async () => {
    const result = await verifyWebhookSignature({
      payload: '{"action":"opened"}',
      signature: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      secret: 'my-secret',
    });
    expect(result.ok).toBe(false);
  });
});

// ── parseWebhookPayload ─────────────────────────────────────────────────────

describe('parseWebhookPayload', () => {
  it('IT-1911: parses valid JSON payload', () => {
    const result = parseWebhookPayload(
      '{"action":"created","sender":{"login":"bot","type":"Bot"}}'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe('created');
      expect(result.value.sender?.login).toBe('bot');
    }
  });

  it('IT-1912: returns error for invalid JSON', () => {
    const result = parseWebhookPayload('not-json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});

// ── parseWebhookEvent ───────────────────────────────────────────────────────

describe('parseWebhookEvent', () => {
  it('IT-1913: parses webhook event from headers and body', () => {
    const headers = new Headers({
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-123',
    });
    const body =
      '{"action":"completed","repository":{"owner":{"login":"acme"},"name":"repo","full_name":"acme/repo"}}';

    const result = parseWebhookEvent(headers, body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event).toBe('push');
      expect(result.value.deliveryId).toBe('delivery-123');
      expect(result.value.action).toBe('completed');
      expect(result.value.payload.repository?.full_name).toBe('acme/repo');
    }
  });

  it('IT-1914: returns error when x-github-event header is missing', () => {
    const headers = new Headers({
      'x-github-delivery': 'delivery-123',
    });
    const result = parseWebhookEvent(headers, '{}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Missing required webhook headers');
    }
  });

  it('IT-1915: returns error when x-github-delivery header is missing', () => {
    const headers = new Headers({
      'x-github-event': 'push',
    });
    const result = parseWebhookEvent(headers, '{}');
    expect(result.ok).toBe(false);
  });

  it('IT-1916: returns error when body is invalid JSON', () => {
    const headers = new Headers({
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-123',
    });
    const result = parseWebhookEvent(headers, 'invalid-json');
    expect(result.ok).toBe(false);
  });

  it('IT-1917: handles ping event', () => {
    const headers = new Headers({
      'x-github-event': 'ping',
      'x-github-delivery': 'delivery-456',
    });
    const result = parseWebhookEvent(headers, '{}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event).toBe('ping');
    }
  });
});
