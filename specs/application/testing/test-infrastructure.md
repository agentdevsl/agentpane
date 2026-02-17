# Test Infrastructure Specification

## Overview

Comprehensive test infrastructure for AgentPane, providing mock implementations, test factories, utilities, and configuration for unit, integration, and E2E testing. This specification ensures consistent, isolated, and reproducible test execution across all test types.

**Related Documents**:

- [Test Cases Catalog](./test-cases.md) - Complete test case inventory
- [Database Schema](../database/schema.md) - Data models for factories
- [Error Catalog](../errors/error-catalog.md) - Error types for mocking

---

## Technology Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| Vitest | 4.0.17 | Unit and integration testing |
| Agent Browser | 0.5.0 | E2E testing with AI-powered interactions |
| PGlite | 0.3.15 | In-memory PostgreSQL for test isolation |
| Drizzle ORM | 0.45.1 | Type-safe database operations |
| @paralleldrive/cuid2 | 3.0.6 | Deterministic ID generation for tests |

---

## 1. Test Environment Setup

### 1.1 Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules', 'dist'],
    setupFiles: ['tests/setup.ts'],

    // Test isolation
    isolate: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        isolate: true,
      },
    },

    // Timeouts
    testTimeout: 10000,
    hookTimeout: 10000,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'app/**/*.ts', 'db/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/types.ts',
        '**/index.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/mocks/**',
        '**/fixtures/**',
      ],
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },

    // Reporter configuration
    reporters: ['default', 'html', 'json'],
    outputFile: {
      html: 'coverage/test-report.html',
      json: 'coverage/test-results.json',
    },
  },

  resolve: {
    alias: {
      '@': resolve(__dirname, './'),
      '@/lib': resolve(__dirname, './lib'),
      '@/db': resolve(__dirname, './db'),
      '@/app': resolve(__dirname, './app'),
      '@/tests': resolve(__dirname, './tests'),
    },
  },
});
```

### 1.2 Vitest Workspace Configuration

```typescript
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      setupFiles: ['tests/integration/setup.ts'],
      testTimeout: 30000,
    },
  },
]);
```

### 1.3 Test Setup File

```typescript
// tests/setup.ts
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDatabase, teardownTestDatabase, clearTestDatabase } from './helpers/database';
import { resetMocks } from './mocks';

// Global test setup
beforeAll(async () => {
  // Initialize test database
  await setupTestDatabase();

  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.ANTHROPIC_API_KEY = 'test-api-key';
  process.env.GITHUB_APP_ID = 'test-app-id';
  process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
});

// Cleanup after each test
afterEach(async () => {
  // Clear database state
  await clearTestDatabase();

  // Reset all mocks
  resetMocks();
  vi.clearAllMocks();
});

// Global teardown
afterAll(async () => {
  await teardownTestDatabase();
});

// Extend Vitest matchers
expect.extend({
  toBeValidCuid2(received: string) {
    const cuid2Regex = /^[a-z0-9]{24,}$/;
    const pass = cuid2Regex.test(received);
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to be a valid CUID2`
          : `Expected ${received} to be a valid CUID2`,
    };
  },

  toBeISODate(received: string) {
    const pass = !isNaN(Date.parse(received));
    return {
      pass,
      message: () =>
        pass
          ? `Expected ${received} not to be a valid ISO date`
          : `Expected ${received} to be a valid ISO date`,
    };
  },
});
```

### 1.4 Environment Variables for Testing

```typescript
// tests/helpers/env.ts
export const TEST_ENV = {
  // Database
  DATABASE_URL: 'memory://',

  // Anthropic
  ANTHROPIC_API_KEY: 'test-anthropic-key-sk-ant-xxxxx',

  // GitHub App
  GITHUB_APP_ID: '123456',
  GITHUB_APP_NAME: 'agentpane-test',
  GITHUB_CLIENT_ID: 'Iv1.test123',
  GITHUB_CLIENT_SECRET: 'test-secret-123',
  GITHUB_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MvMj
-----END RSA PRIVATE KEY-----`,
  GITHUB_WEBHOOK_SECRET: 'whsec_test123',

  // Application
  APP_URL: 'http://localhost:5173',
  NODE_ENV: 'test',
} as const;

export function setupTestEnv(): void {
  Object.entries(TEST_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

export function cleanupTestEnv(): void {
  Object.keys(TEST_ENV).forEach((key) => {
    delete process.env[key];
  });
}
```

### 1.5 Agent Browser E2E Configuration

```typescript
// tests/e2e/agent-browser.config.ts
import { defineConfig } from 'agent-browser';

export default defineConfig({
  // Browser settings
  browser: {
    headless: process.env.CI === 'true',
    slowMo: process.env.CI ? 0 : 50,
    viewport: { width: 1280, height: 720 },
  },

  // Application settings
  baseUrl: process.env.TEST_BASE_URL ?? 'http://localhost:5173',

  // Timeouts
  timeout: 30000,
  navigationTimeout: 60000,

  // Retry configuration
  retries: process.env.CI ? 2 : 0,

  // Screenshot and video capture
  screenshot: {
    mode: 'only-on-failure',
    fullPage: true,
  },
  video: {
    mode: 'on-first-retry',
  },

  // Trace collection for debugging
  trace: {
    mode: 'on-first-retry',
    screenshots: true,
    snapshots: true,
    sources: true,
  },

  // Test isolation
  testIsolation: true,

  // Parallel execution
  workers: process.env.CI ? 2 : 1,
  fullyParallel: false,

  // Output directories
  outputDir: 'tests/e2e/results',

  // Custom setup
  globalSetup: 'tests/e2e/global-setup.ts',
  globalTeardown: 'tests/e2e/global-teardown.ts',
});
```

---

## 2. Mock Strategies

### 2.1 GitHub API Mocks (Octokit)

```typescript
// tests/mocks/github/octokit.ts
import { vi } from 'vitest';
import type { Octokit } from 'octokit';
import { createTestInstallation, createTestRepository } from '../factories';

export interface MockOctokitOptions {
  installations?: ReturnType<typeof createTestInstallation>[];
  repositories?: ReturnType<typeof createTestRepository>[];
  failOnAuth?: boolean;
  rateLimitRemaining?: number;
}

export function createMockOctokit(options: MockOctokitOptions = {}): Partial<Octokit> {
  const {
    installations = [createTestInstallation()],
    repositories = [createTestRepository()],
    failOnAuth = false,
    rateLimitRemaining = 5000,
  } = options;

  if (failOnAuth) {
    return {
      rest: {
        apps: {
          listInstallations: vi.fn().mockRejectedValue(new Error('Unauthorized')),
          getInstallation: vi.fn().mockRejectedValue(new Error('Unauthorized')),
        },
      },
    } as unknown as Partial<Octokit>;
  }

  return {
    rest: {
      apps: {
        listInstallations: vi.fn().mockResolvedValue({ data: installations }),
        getInstallation: vi.fn().mockImplementation(({ installation_id }) => {
          const installation = installations.find(i => i.id === installation_id);
          if (!installation) {
            const error = new Error('Not found');
            (error as any).status = 404;
            throw error;
          }
          return Promise.resolve({ data: installation });
        }),
        listReposAccessibleToInstallation: vi.fn().mockResolvedValue({
          data: { repositories, total_count: repositories.length },
        }),
        createInstallationAccessToken: vi.fn().mockResolvedValue({
          data: { token: 'ghs_test_token_123', expires_at: new Date(Date.now() + 3600000).toISOString() },
        }),
      },
      repos: {
        get: vi.fn().mockImplementation(({ owner, repo }) => {
          const repository = repositories.find(r => r.owner.login === owner && r.name === repo);
          if (!repository) {
            const error = new Error('Not found');
            (error as any).status = 404;
            throw error;
          }
          return Promise.resolve({ data: repository });
        }),
        getContent: vi.fn().mockImplementation(({ owner, repo, path }) => {
          if (path === '.claude/config.json') {
            return Promise.resolve({
              data: {
                content: Buffer.from(JSON.stringify({
                  allowedTools: ['Read', 'Edit', 'Bash'],
                  maxTurns: 50,
                  model: 'claude-sonnet-4-6',
                })).toString('base64'),
                encoding: 'base64',
              },
            });
          }
          const error = new Error('Not found');
          (error as any).status = 404;
          throw error;
        }),
        listBranches: vi.fn().mockResolvedValue({
          data: [{ name: 'main' }, { name: 'develop' }],
        }),
      },
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: {
            number: 1,
            html_url: 'https://github.com/test/repo/pull/1',
            state: 'open',
            mergeable: true,
            merged: false,
          },
        }),
        merge: vi.fn().mockResolvedValue({ data: { merged: true } }),
        get: vi.fn().mockResolvedValue({
          data: {
            number: 1,
            state: 'open',
            mergeable: true,
            merged: false,
          },
        }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }),
      },
      git: {
        getRef: vi.fn().mockResolvedValue({
          data: { object: { sha: 'abc123def456' } },
        }),
        createRef: vi.fn().mockResolvedValue({ data: { ref: 'refs/heads/test-branch' } }),
      },
      rateLimit: {
        get: vi.fn().mockResolvedValue({
          data: {
            rate: {
              limit: 5000,
              remaining: rateLimitRemaining,
              reset: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      },
    },
    paginate: vi.fn().mockImplementation(async (method) => {
      const result = await method();
      return result.data.repositories ?? result.data;
    }),
  } as unknown as Partial<Octokit>;
}

// Mock App class for installation management
export function createMockGitHubApp(options: MockOctokitOptions = {}) {
  const mockOctokit = createMockOctokit(options);

  return {
    getInstallationOctokit: vi.fn().mockResolvedValue(mockOctokit),
    eachInstallation: {
      iterator: vi.fn().mockImplementation(async function* () {
        for (const installation of options.installations ?? [createTestInstallation()]) {
          yield { installation };
        }
      }),
    },
    eachRepository: {
      iterator: vi.fn().mockImplementation(async function* () {
        for (const repository of options.repositories ?? [createTestRepository()]) {
          yield { octokit: mockOctokit, repository };
        }
      }),
    },
    webhooks: {
      on: vi.fn(),
      verify: vi.fn().mockReturnValue(true),
    },
  };
}
```

### 2.2 GitHub Webhook Payload Generators

```typescript
// tests/mocks/github/webhooks.ts
import { createTestRepository, createTestInstallation } from '../factories';
import { createHmac } from 'crypto';

export interface WebhookPayloadOptions {
  repository?: ReturnType<typeof createTestRepository>;
  installation?: ReturnType<typeof createTestInstallation>;
  ref?: string;
  commits?: Array<{
    id: string;
    message: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

// Push event payload generator
export function createPushPayload(options: WebhookPayloadOptions = {}) {
  const repository = options.repository ?? createTestRepository();
  const installation = options.installation ?? createTestInstallation();

  return {
    ref: options.ref ?? 'refs/heads/main',
    repository: {
      id: repository.id,
      name: repository.name,
      full_name: repository.full_name,
      owner: repository.owner,
      default_branch: repository.default_branch,
    },
    installation: {
      id: installation.id,
    },
    commits: options.commits ?? [
      {
        id: 'abc123',
        message: 'Update config',
        added: [],
        modified: ['.claude/config.json'],
        removed: [],
      },
    ],
    sender: {
      login: 'test-user',
      id: 1,
    },
  };
}

// Pull request event payload generator
export function createPullRequestPayload(
  action: 'opened' | 'closed' | 'synchronize' | 'merged',
  options: WebhookPayloadOptions & { prNumber?: number; merged?: boolean } = {}
) {
  const repository = options.repository ?? createTestRepository();
  const installation = options.installation ?? createTestInstallation();

  return {
    action,
    number: options.prNumber ?? 1,
    pull_request: {
      number: options.prNumber ?? 1,
      state: action === 'closed' ? 'closed' : 'open',
      merged: options.merged ?? (action === 'merged'),
      head: {
        ref: 'feature/test-branch',
        sha: 'abc123',
      },
      base: {
        ref: 'main',
        sha: 'def456',
      },
      title: 'Test PR',
      body: 'Test PR description',
    },
    repository: {
      id: repository.id,
      name: repository.name,
      full_name: repository.full_name,
      owner: repository.owner,
    },
    installation: {
      id: installation.id,
    },
    sender: {
      login: 'test-user',
      id: 1,
    },
  };
}

// Installation event payload generator
export function createInstallationPayload(
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend',
  options: WebhookPayloadOptions = {}
) {
  const installation = options.installation ?? createTestInstallation();
  const repositories = options.repository ? [options.repository] : [createTestRepository()];

  return {
    action,
    installation: {
      id: installation.id,
      account: installation.account,
      permissions: installation.permissions,
      repository_selection: installation.repository_selection,
    },
    repositories: repositories.map(r => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      private: r.private,
    })),
    sender: {
      login: 'test-user',
      id: 1,
    },
  };
}

// Generate webhook signature
export function generateWebhookSignature(payload: object, secret: string = 'test-webhook-secret'): string {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${signature}`;
}

// Create complete webhook request mock
export function createWebhookRequest(
  event: string,
  payload: object,
  options: { secret?: string; deliveryId?: string } = {}
) {
  const body = JSON.stringify(payload);
  const signature = generateWebhookSignature(payload, options.secret);

  return {
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': signature,
      'x-github-delivery': options.deliveryId ?? 'test-delivery-123',
      'content-type': 'application/json',
    },
    body,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(payload),
  };
}
```

### 2.3 GitHub OAuth Flow Mocks

```typescript
// tests/mocks/github/oauth.ts
import { vi } from 'vitest';

export interface MockOAuthOptions {
  code?: string;
  accessToken?: string;
  failOnExchange?: boolean;
  user?: {
    id: number;
    login: string;
    email: string;
    avatar_url: string;
  };
}

export function createMockOAuthFlow(options: MockOAuthOptions = {}) {
  const {
    code = 'test-oauth-code',
    accessToken = 'ghu_test_access_token',
    failOnExchange = false,
    user = {
      id: 12345,
      login: 'test-user',
      email: 'test@example.com',
      avatar_url: 'https://avatars.githubusercontent.com/u/12345',
    },
  } = options;

  return {
    generateAuthUrl: vi.fn().mockImplementation(({ state }) => ({
      url: `https://github.com/login/oauth/authorize?client_id=test&state=${state}`,
      state,
    })),

    exchangeCode: vi.fn().mockImplementation(async (receivedCode: string) => {
      if (failOnExchange) {
        throw new Error('OAuth exchange failed');
      }
      if (receivedCode !== code) {
        throw new Error('Invalid code');
      }
      return {
        access_token: accessToken,
        token_type: 'bearer',
        scope: 'read:user,user:email',
      };
    }),

    getUser: vi.fn().mockResolvedValue(user),

    validateState: vi.fn().mockImplementation((receivedState: string, expectedState: string) => {
      return receivedState === expectedState;
    }),
  };
}
```

### 2.4 Claude Agent SDK Mocks

```typescript
// tests/mocks/claude/agent-sdk.ts
import { vi } from 'vitest';

export interface MockAgentOptions {
  responses?: Array<{
    type: 'message' | 'tool_use' | 'stream_event';
    content?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    event?: {
      type: string;
      delta?: { text?: string };
    };
  }>;
  failAfterTurns?: number;
  maxTurns?: number;
  turnDelay?: number;
}

// Mock query() generator function
export function createMockQueryGenerator(options: MockAgentOptions = {}) {
  const {
    responses = [
      { type: 'message', content: 'I will help you with that task.' },
      { type: 'tool_use', tool_name: 'Read', tool_input: { file_path: '/test/file.ts' } },
      { type: 'message', content: 'Task completed successfully.' },
    ],
    failAfterTurns,
    maxTurns = 50,
    turnDelay = 0,
  } = options;

  return async function* mockQuery(params: {
    prompt: string;
    options?: {
      allowedTools?: string[];
      model?: string;
      maxTurns?: number;
      cwd?: string;
      hooks?: {
        PreToolUse?: Array<{ hooks: Array<(input: any) => Promise<{ deny?: boolean }>> }>;
        PostToolUse?: Array<{ hooks: Array<(input: any) => Promise<void>> }>;
      };
    };
  }) {
    let turn = 0;
    const effectiveMaxTurns = params.options?.maxTurns ?? maxTurns;

    for (const response of responses) {
      if (turnDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, turnDelay));
      }

      if (turn >= effectiveMaxTurns) {
        throw new Error('max turns exceeded');
      }

      if (failAfterTurns !== undefined && turn >= failAfterTurns) {
        throw new Error('Agent execution failed');
      }

      if (response.type === 'tool_use') {
        // Execute PreToolUse hooks
        const preToolHooks = params.options?.hooks?.PreToolUse?.[0]?.hooks ?? [];
        for (const hook of preToolHooks) {
          const result = await hook({
            tool_name: response.tool_name,
            tool_input: response.tool_input,
          });
          if (result.deny) {
            yield {
              type: 'tool_denied',
              tool_name: response.tool_name,
              reason: result.reason ?? 'Denied by hook',
            };
            continue;
          }
        }

        // Execute PostToolUse hooks
        const postToolHooks = params.options?.hooks?.PostToolUse?.[0]?.hooks ?? [];
        for (const hook of postToolHooks) {
          await hook({
            tool_name: response.tool_name,
            tool_input: response.tool_input,
            tool_response: response.tool_response ?? { success: true },
          });
        }
      }

      if (response.type === 'stream_event') {
        yield {
          type: 'stream_event',
          event: response.event,
        };
      } else if (response.type === 'message') {
        turn++;
        yield {
          type: 'message',
          result: response.content,
        };
      }
    }
  };
}

// Mock tool() function
export function createMockTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
) {
  return {
    name,
    description: `Mock tool: ${name}`,
    schema: {},
    handler,
  };
}

// Pre-built mock tools
export const mockTools = {
  Read: createMockTool('Read', async ({ file_path }) => ({
    content: [{ type: 'text', text: `Contents of ${file_path}:\n// Mock file content` }],
  })),

  Edit: createMockTool('Edit', async ({ file_path, old_string, new_string }) => ({
    content: [{ type: 'text', text: `Edited ${file_path}: replaced "${old_string}" with "${new_string}"` }],
  })),

  Bash: createMockTool('Bash', async ({ command }) => ({
    content: [{ type: 'text', text: `$ ${command}\nCommand executed successfully` }],
  })),

  Glob: createMockTool('Glob', async ({ pattern }) => ({
    content: [{ type: 'text', text: `Files matching ${pattern}:\n/test/file1.ts\n/test/file2.ts` }],
  })),

  Grep: createMockTool('Grep', async ({ pattern }) => ({
    content: [{ type: 'text', text: `Matches for ${pattern}:\n/test/file.ts:10: matching line` }],
  })),
};

// Streaming response mock
export function createMockStreamingResponse(text: string, chunkSize: number = 10) {
  const chunks: Array<{ type: 'stream_event'; event: { type: string; delta: { text: string } } }> = [];

  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { text: text.slice(i, i + chunkSize) },
      },
    });
  }

  return chunks;
}
```

### 2.5 Durable Streams Mocks

```typescript
// tests/mocks/durable-streams/index.ts
import { vi } from 'vitest';
import { EventEmitter } from 'events';

// In-memory stream implementation
export class MockDurableStream extends EventEmitter {
  private events: Map<string, Array<{ channel: string; data: unknown; timestamp: number }>> = new Map();
  private subscribers: Map<string, Set<(event: unknown) => void>> = new Map();

  publish(streamId: string, event: { channel: string; data: unknown }): void {
    const streamEvents = this.events.get(streamId) ?? [];
    const timestampedEvent = { ...event, timestamp: Date.now() };
    streamEvents.push(timestampedEvent);
    this.events.set(streamId, streamEvents);

    // Notify subscribers
    const subs = this.subscribers.get(streamId);
    if (subs) {
      subs.forEach(callback => callback(event));
    }

    this.emit('event', { streamId, event });
  }

  subscribe(streamId: string, callback: (event: unknown) => void): () => void {
    if (!this.subscribers.has(streamId)) {
      this.subscribers.set(streamId, new Set());
    }
    this.subscribers.get(streamId)!.add(callback);

    return () => {
      this.subscribers.get(streamId)?.delete(callback);
    };
  }

  getHistory(streamId: string): Array<{ channel: string; data: unknown; timestamp: number }> {
    return this.events.get(streamId) ?? [];
  }

  clear(): void {
    this.events.clear();
    this.subscribers.clear();
  }
}

// Mock server
export function createMockDurableStreamsServer() {
  const stream = new MockDurableStream();

  return {
    stream,
    publish: vi.fn((streamId: string, event: { channel: string; data: unknown }) => {
      stream.publish(streamId, event);
    }),
    createStream: vi.fn((streamId: string) => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          const unsubscribe = stream.subscribe(streamId, (event) => {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
          });

          // Store unsubscribe for cleanup
          (controller as any).unsubscribe = unsubscribe;
        },
        cancel(controller) {
          (controller as any).unsubscribe?.();
        },
      });
    }),
  };
}

// Mock client
export function createMockDurableStreamsClient() {
  const stream = new MockDurableStream();
  const subscriptions = new Map<string, () => void>();

  return {
    stream,
    subscribe: vi.fn((streamId: string, callback: (event: unknown) => void, options?: {
      onError?: (error: Error) => void;
      onReconnect?: () => void;
    }) => {
      const unsubscribe = stream.subscribe(streamId, callback);
      subscriptions.set(streamId, unsubscribe);
      return unsubscribe;
    }),
    send: vi.fn(async (streamId: string, event: { channel: string; data: unknown }) => {
      stream.publish(streamId, event);
    }),
    disconnect: vi.fn(() => {
      subscriptions.forEach(unsub => unsub());
      subscriptions.clear();
    }),
  };
}

// Mock presence tracking
export function createMockPresenceManager() {
  const presence = new Map<string, Map<string, { userId: string; lastSeen: number; cursor?: { x: number; y: number } }>>();

  return {
    join: vi.fn((sessionId: string, userId: string) => {
      if (!presence.has(sessionId)) {
        presence.set(sessionId, new Map());
      }
      presence.get(sessionId)!.set(userId, { userId, lastSeen: Date.now() });
    }),
    leave: vi.fn((sessionId: string, userId: string) => {
      presence.get(sessionId)?.delete(userId);
    }),
    updateCursor: vi.fn((sessionId: string, userId: string, cursor: { x: number; y: number }) => {
      const user = presence.get(sessionId)?.get(userId);
      if (user) {
        user.cursor = cursor;
        user.lastSeen = Date.now();
      }
    }),
    getParticipants: vi.fn((sessionId: string) => {
      return Array.from(presence.get(sessionId)?.values() ?? []);
    }),
    clear: vi.fn(() => {
      presence.clear();
    }),
  };
}
```

### 2.6 File System Mocks

```typescript
// tests/mocks/filesystem/index.ts
import { vi } from 'vitest';

export interface MockFileSystemOptions {
  files?: Record<string, string>;
  directories?: string[];
}

// In-memory file system
export class MockFileSystem {
  private files: Map<string, string> = new Map();
  private directories: Set<string> = new Set();

  constructor(options: MockFileSystemOptions = {}) {
    if (options.files) {
      Object.entries(options.files).forEach(([path, content]) => {
        this.files.set(path, content);
        // Auto-create parent directories
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          this.directories.add(parts.slice(0, i).join('/'));
        }
      });
    }
    if (options.directories) {
      options.directories.forEach(dir => this.directories.add(dir));
    }
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  exists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }

  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  mkdir(path: string): void {
    this.directories.add(path);
  }

  readdir(path: string): string[] {
    const entries: string[] = [];
    const prefix = path.endsWith('/') ? path : `${path}/`;

    this.files.forEach((_, filePath) => {
      if (filePath.startsWith(prefix)) {
        const relativePath = filePath.slice(prefix.length);
        const firstPart = relativePath.split('/')[0];
        if (!entries.includes(firstPart)) {
          entries.push(firstPart);
        }
      }
    });

    this.directories.forEach(dir => {
      if (dir.startsWith(prefix)) {
        const relativePath = dir.slice(prefix.length);
        const firstPart = relativePath.split('/')[0];
        if (firstPart && !entries.includes(firstPart)) {
          entries.push(firstPart);
        }
      }
    });

    return entries;
  }

  unlink(path: string): void {
    this.files.delete(path);
  }

  rmdir(path: string): void {
    this.directories.delete(path);
    // Remove all files within directory
    const prefix = path.endsWith('/') ? path : `${path}/`;
    this.files.forEach((_, filePath) => {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath);
      }
    });
  }

  clear(): void {
    this.files.clear();
    this.directories.clear();
  }
}

// Git worktree mocks
export function createMockWorktreeOperations(fs: MockFileSystem = new MockFileSystem()) {
  const worktrees = new Map<string, { branch: string; path: string; baseBranch: string }>();

  return {
    fs,
    worktrees,

    add: vi.fn(async (projectPath: string, worktreePath: string, branch: string, baseBranch: string) => {
      if (worktrees.has(worktreePath)) {
        throw new Error(`Worktree already exists at ${worktreePath}`);
      }
      worktrees.set(worktreePath, { branch, path: worktreePath, baseBranch });
      fs.mkdir(worktreePath);
      return { exitCode: 0, stdout: '', stderr: '' };
    }),

    remove: vi.fn(async (projectPath: string, worktreePath: string, force: boolean = false) => {
      if (!worktrees.has(worktreePath) && !force) {
        throw new Error(`Worktree not found at ${worktreePath}`);
      }
      worktrees.delete(worktreePath);
      fs.rmdir(worktreePath);
      return { exitCode: 0, stdout: '', stderr: '' };
    }),

    list: vi.fn(async (projectPath: string) => {
      const output = Array.from(worktrees.entries())
        .map(([path, info]) => `worktree ${path}\nHEAD abc123\nbranch refs/heads/${info.branch}\n`)
        .join('\n');
      return { exitCode: 0, stdout: output, stderr: '' };
    }),

    status: vi.fn(async (worktreePath: string) => {
      return { exitCode: 0, stdout: '', stderr: '' }; // Clean status
    }),

    prune: vi.fn(async (projectPath: string) => {
      return { exitCode: 0, stdout: '', stderr: '' };
    }),

    clear: vi.fn(() => {
      worktrees.clear();
      fs.clear();
    }),
  };
}

// Bun shell mock
export function createMockBunShell(worktreeOps: ReturnType<typeof createMockWorktreeOperations>) {
  return vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '');

    // Parse and route commands
    if (command.includes('git worktree add')) {
      const match = command.match(/worktree add ([^\s]+) -b ([^\s]+) ([^\s]+)/);
      if (match) {
        return worktreeOps.add('', match[1], match[2], match[3]);
      }
    }

    if (command.includes('git worktree remove')) {
      const match = command.match(/worktree remove ([^\s]+)/);
      const force = command.includes('--force');
      if (match) {
        return worktreeOps.remove('', match[1], force);
      }
    }

    if (command.includes('git worktree list')) {
      return worktreeOps.list('');
    }

    if (command.includes('git status --porcelain')) {
      return worktreeOps.status('');
    }

    if (command.includes('bun install')) {
      return Promise.resolve({ exitCode: 0, stdout: 'Installed dependencies', stderr: '' });
    }

    if (command.includes('cp ')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // Default success
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
}
```

---

## 3. Test Factories

### 3.1 Core Entity Factories

```typescript
// tests/factories/index.ts
import { createId } from '@paralleldrive/cuid2';
import type {
  Project, NewProject, ProjectConfig,
  Task, NewTask, TaskColumn,
  Agent, NewAgent, AgentConfig, AgentStatus,
  Worktree, NewWorktree, WorktreeStatus,
  Session, NewSession,
  AgentRun, NewAgentRun,
} from '@/db/schema';

// Deterministic ID generation for reproducible tests
let idCounter = 0;
export function createTestId(prefix: string = 'test'): string {
  idCounter++;
  return `${prefix}_${idCounter.toString().padStart(8, '0')}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

// ============ Project Factory ============
export interface CreateTestProjectOptions extends Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>> {
  config?: Partial<ProjectConfig>;
}

export function createTestProject(options: CreateTestProjectOptions = {}): Project {
  const now = new Date();

  return {
    id: createTestId('proj'),
    name: 'Test Project',
    path: '/tmp/test-projects/test-project',
    description: 'A test project for unit tests',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
      model: 'claude-sonnet-4-6',
      ...options.config,
    },
    maxConcurrentAgents: 3,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
    createdAt: now,
    updatedAt: now,
    ...options,
  };
}

// ============ Task Factory ============
export interface CreateTestTaskOptions extends Partial<Omit<Task, 'id' | 'createdAt' | 'updatedAt'>> {
  projectId?: string;
}

export function createTestTask(options: CreateTestTaskOptions = {}): Task {
  const now = new Date();

  return {
    id: createTestId('task'),
    projectId: options.projectId ?? createTestId('proj'),
    agentId: null,
    sessionId: null,
    title: 'Test Task',
    description: 'A test task description',
    column: 'backlog' as TaskColumn,
    position: 0,
    branch: null,
    worktreeId: null,
    diffSummary: null,
    filesChanged: null,
    linesAdded: null,
    linesRemoved: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    rejectionCount: 0,
    startedAt: null,
    completedAt: null,
    turnCount: 0,
    labels: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...options,
  };
}

// ============ Agent Factory ============
export interface CreateTestAgentOptions extends Partial<Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>> {
  projectId?: string;
  config?: Partial<AgentConfig>;
}

export function createTestAgent(options: CreateTestAgentOptions = {}): Agent {
  const now = new Date();

  return {
    id: createTestId('agent'),
    projectId: options.projectId ?? createTestId('proj'),
    name: 'Test Agent',
    type: 'task',
    status: 'idle' as AgentStatus,
    config: {
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
      model: 'claude-sonnet-4-6',
      ...options.config,
    },
    currentTaskId: null,
    currentSessionId: null,
    currentWorktreeId: null,
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    lastError: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
    ...options,
  };
}

// ============ Session Factory ============
export interface CreateTestSessionOptions extends Partial<Omit<Session, 'id' | 'createdAt' | 'updatedAt'>> {
  projectId?: string;
}

export function createTestSession(options: CreateTestSessionOptions = {}): Session {
  const now = new Date();
  const id = createTestId('sess');

  return {
    id,
    projectId: options.projectId ?? createTestId('proj'),
    taskId: null,
    agentId: null,
    title: 'Test Session',
    url: `/sessions/${id}`,
    isActive: true,
    activeUsers: [],
    messageCount: 0,
    toolCallCount: 0,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...options,
  };
}

// ============ Worktree Factory ============
export interface CreateTestWorktreeOptions extends Partial<Omit<Worktree, 'id' | 'createdAt' | 'updatedAt'>> {
  projectId?: string;
  taskId?: string;
}

export function createTestWorktree(options: CreateTestWorktreeOptions = {}): Worktree {
  const now = new Date();
  const projectId = options.projectId ?? createTestId('proj');
  const taskId = options.taskId ?? createTestId('task');

  return {
    id: createTestId('wt'),
    projectId,
    taskId,
    branch: `feature/${taskId}-test-feature`,
    baseBranch: 'main',
    path: `/tmp/test-projects/.worktrees/feature-${taskId}-test-feature`,
    status: 'active' as WorktreeStatus,
    envCopied: true,
    depsInstalled: true,
    initScriptRun: false,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    removedAt: null,
    ...options,
  };
}

// ============ Agent Run Factory ============
export interface CreateTestAgentRunOptions extends Partial<Omit<AgentRun, 'id' | 'startedAt'>> {
  agentId?: string;
  projectId?: string;
}

export function createTestAgentRun(options: CreateTestAgentRunOptions = {}): AgentRun {
  const now = new Date();

  return {
    id: createTestId('run'),
    agentId: options.agentId ?? createTestId('agent'),
    taskId: null,
    projectId: options.projectId ?? createTestId('proj'),
    sessionId: null,
    status: 'running' as AgentStatus,
    prompt: 'Test prompt for agent execution',
    result: null,
    turnCount: 0,
    tokenInputCount: 0,
    tokenOutputCount: 0,
    toolCalls: [],
    error: null,
    errorType: null,
    startedAt: now,
    completedAt: null,
    duration: null,
    ...options,
  };
}

// ============ User Factory ============
export interface TestUser {
  id: string;
  login: string;
  email: string;
  avatarUrl: string;
}

export function createTestUser(options: Partial<TestUser> = {}): TestUser {
  const id = createTestId('user');
  return {
    id,
    login: `test-user-${id}`,
    email: `test-${id}@example.com`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id}`,
    ...options,
  };
}
```

### 3.2 GitHub Entity Factories

```typescript
// tests/factories/github.ts
import { createTestId } from './index';

// ============ Installation Factory ============
export interface CreateTestInstallationOptions {
  id?: number;
  accountLogin?: string;
  accountType?: 'User' | 'Organization';
  permissions?: Record<string, string>;
  repositorySelection?: 'all' | 'selected';
}

export function createTestInstallation(options: CreateTestInstallationOptions = {}) {
  const id = options.id ?? parseInt(createTestId('inst').replace('inst_', ''), 10);

  return {
    id,
    account: {
      id: id + 1000,
      login: options.accountLogin ?? 'test-account',
      type: options.accountType ?? 'User',
      avatar_url: `https://avatars.githubusercontent.com/u/${id + 1000}`,
    },
    permissions: options.permissions ?? {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    },
    repository_selection: options.repositorySelection ?? 'all',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ============ Repository Factory ============
export interface CreateTestRepositoryOptions {
  id?: number;
  name?: string;
  owner?: string;
  isPrivate?: boolean;
  defaultBranch?: string;
  hasConfig?: boolean;
}

export function createTestRepository(options: CreateTestRepositoryOptions = {}) {
  const id = options.id ?? parseInt(createTestId('repo').replace('repo_', ''), 10);
  const owner = options.owner ?? 'test-owner';
  const name = options.name ?? 'test-repo';

  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    owner: {
      id: id + 2000,
      login: owner,
      type: 'User',
      avatar_url: `https://avatars.githubusercontent.com/u/${id + 2000}`,
    },
    private: options.isPrivate ?? false,
    default_branch: options.defaultBranch ?? 'main',
    description: 'A test repository',
    language: 'TypeScript',
    updated_at: new Date().toISOString(),
  };
}
```

### 3.3 Event Factories

```typescript
// tests/factories/events.ts
import { createTestId } from './index';
import type {
  ChunkEvent,
  ToolCallEvent,
  AgentStateEvent,
  TerminalEvent,
  WorkflowEvent,
  PresenceEvent,
} from '@/lib/sessions/schema';

export function createTestChunkEvent(options: Partial<ChunkEvent> = {}): ChunkEvent {
  return {
    id: createTestId('chunk'),
    agentId: options.agentId ?? createTestId('agent'),
    sessionId: options.sessionId ?? createTestId('sess'),
    text: 'Test chunk text',
    accumulated: undefined,
    turn: 1,
    timestamp: Date.now(),
    ...options,
  };
}

export function createTestToolCallEvent(options: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: createTestId('tool'),
    agentId: options.agentId ?? createTestId('agent'),
    sessionId: options.sessionId ?? createTestId('sess'),
    tool: 'Read',
    input: { file_path: '/test/file.ts' },
    output: undefined,
    status: 'pending',
    duration: undefined,
    timestamp: Date.now(),
    ...options,
  };
}

export function createTestAgentStateEvent(options: Partial<AgentStateEvent> = {}): AgentStateEvent {
  return {
    agentId: options.agentId ?? createTestId('agent'),
    sessionId: options.sessionId ?? createTestId('sess'),
    status: 'running',
    taskId: undefined,
    turn: 0,
    progress: 0,
    currentTool: undefined,
    message: undefined,
    error: undefined,
    timestamp: Date.now(),
    ...options,
  };
}

export function createTestTerminalEvent(options: Partial<TerminalEvent> = {}): TerminalEvent {
  return {
    id: createTestId('term'),
    sessionId: options.sessionId ?? createTestId('sess'),
    type: 'output',
    data: 'Test terminal output',
    source: 'agent',
    timestamp: Date.now(),
    ...options,
  };
}

export function createTestWorkflowEvent(options: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    id: createTestId('wf'),
    sessionId: options.sessionId ?? createTestId('sess'),
    taskId: undefined,
    type: 'approval:requested',
    payload: {},
    actor: undefined,
    timestamp: Date.now(),
    ...options,
  };
}

export function createTestPresenceEvent(options: Partial<PresenceEvent> = {}): PresenceEvent {
  return {
    userId: options.userId ?? createTestId('user'),
    sessionId: options.sessionId ?? createTestId('sess'),
    displayName: 'Test User',
    avatarUrl: undefined,
    cursor: undefined,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    ...options,
  };
}
```

---

## 4. Test Database

### 4.1 In-Memory PGlite Setup

```typescript
// tests/helpers/database.ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@/db/schema';

let pglite: PGlite | null = null;
let db: PgliteDatabase<typeof schema> | null = null;

export async function setupTestDatabase(): Promise<PgliteDatabase<typeof schema>> {
  // Create in-memory PGlite instance
  pglite = new PGlite();
  db = drizzle(pglite, { schema });

  // Run migrations
  await migrate(db, { migrationsFolder: './db/migrations' });

  return db;
}

export async function getTestDatabase(): Promise<PgliteDatabase<typeof schema>> {
  if (!db) {
    return setupTestDatabase();
  }
  return db;
}

export async function clearTestDatabase(): Promise<void> {
  if (!db) return;

  // Clear all tables in reverse dependency order
  await db.delete(schema.auditLogs);
  await db.delete(schema.agentRuns);
  await db.delete(schema.sessions);
  await db.delete(schema.worktrees);
  await db.delete(schema.tasks);
  await db.delete(schema.agents);
  await db.delete(schema.repositoryConfigs);
  await db.delete(schema.githubInstallations);
  await db.delete(schema.projects);
}

export async function teardownTestDatabase(): Promise<void> {
  if (pglite) {
    await pglite.close();
    pglite = null;
    db = null;
  }
}

// Seed database with test data
export async function seedTestDatabase(options: {
  projects?: number;
  tasksPerProject?: number;
  agentsPerProject?: number;
} = {}): Promise<{
  projects: schema.Project[];
  tasks: schema.Task[];
  agents: schema.Agent[];
}> {
  const {
    projects: projectCount = 1,
    tasksPerProject = 3,
    agentsPerProject = 1,
  } = options;

  if (!db) {
    throw new Error('Database not initialized');
  }

  const projects: schema.Project[] = [];
  const tasks: schema.Task[] = [];
  const agents: schema.Agent[] = [];

  for (let i = 0; i < projectCount; i++) {
    const [project] = await db.insert(schema.projects).values({
      name: `Test Project ${i + 1}`,
      path: `/tmp/test-projects/project-${i + 1}`,
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read', 'Edit', 'Bash'],
        maxTurns: 50,
        model: 'claude-sonnet-4-6',
      },
    }).returning();
    projects.push(project);

    for (let j = 0; j < tasksPerProject; j++) {
      const column = ['backlog', 'in_progress', 'waiting_approval', 'verified'][j % 4] as schema.TaskColumn;
      const [task] = await db.insert(schema.tasks).values({
        projectId: project.id,
        title: `Task ${j + 1} for Project ${i + 1}`,
        description: `Description for task ${j + 1}`,
        column,
        position: j,
      }).returning();
      tasks.push(task);
    }

    for (let k = 0; k < agentsPerProject; k++) {
      const [agent] = await db.insert(schema.agents).values({
        projectId: project.id,
        name: `Agent ${k + 1} for Project ${i + 1}`,
        type: 'task',
        status: 'idle',
        config: {
          allowedTools: ['Read', 'Edit', 'Bash'],
          maxTurns: 50,
          model: 'claude-sonnet-4-6',
        },
      }).returning();
      agents.push(agent);
    }
  }

  return { projects, tasks, agents };
}
```

### 4.2 Transaction-Based Test Isolation

```typescript
// tests/helpers/transaction.ts
import { sql } from 'drizzle-orm';
import { getTestDatabase } from './database';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type * as schema from '@/db/schema';

export interface TransactionContext {
  db: PgliteDatabase<typeof schema>;
  rollback: () => Promise<void>;
}

// Create a transaction that can be rolled back after each test
export async function createTestTransaction(): Promise<TransactionContext> {
  const db = await getTestDatabase();

  // Start a savepoint for rollback
  await db.execute(sql`SAVEPOINT test_savepoint`);

  return {
    db,
    rollback: async () => {
      await db.execute(sql`ROLLBACK TO SAVEPOINT test_savepoint`);
    },
  };
}

// Higher-order function for transaction-wrapped tests
export function withTestTransaction<T>(
  testFn: (ctx: TransactionContext) => Promise<T>
): () => Promise<T> {
  return async () => {
    const ctx = await createTestTransaction();
    try {
      return await testFn(ctx);
    } finally {
      await ctx.rollback();
    }
  };
}
```

---

## 5. Test Utilities

### 5.1 React Component Testing

```typescript
// tests/helpers/react.tsx
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter, type RouteObject } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

// Create a fresh QueryClient for each test
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

interface TestProvidersProps {
  children: ReactNode;
  queryClient?: QueryClient;
}

function TestProviders({ children, queryClient }: TestProvidersProps) {
  const client = queryClient ?? createTestQueryClient();

  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}

// Custom render with providers
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'> & {
    queryClient?: QueryClient;
  }
): ReturnType<typeof render> & { queryClient: QueryClient } {
  const queryClient = options?.queryClient ?? createTestQueryClient();

  const result = render(ui, {
    wrapper: ({ children }) => (
      <TestProviders queryClient={queryClient}>
        {children}
      </TestProviders>
    ),
    ...options,
  });

  return {
    ...result,
    queryClient,
  };
}

// Create test router for route testing
export function createTestRouter(routes: RouteObject[], initialEntries: string[] = ['/']) {
  return createMemoryRouter(routes, {
    initialEntries,
  });
}

// Render with router
export function renderWithRouter(
  routes: RouteObject[],
  options?: {
    initialEntries?: string[];
    queryClient?: QueryClient;
  }
) {
  const router = createTestRouter(routes, options?.initialEntries);
  const queryClient = options?.queryClient ?? createTestQueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

### 5.2 Async Utilities

```typescript
// tests/helpers/async.ts
import { vi } from 'vitest';

// Wait for a condition to be true
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  options: {
    timeout?: number;
    interval?: number;
    timeoutMessage?: string;
  } = {}
): Promise<T> {
  const { timeout = 5000, interval = 50, timeoutMessage = 'Condition not met' } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      if (result) {
        return result;
      }
    } catch {
      // Continue waiting
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout: ${timeoutMessage}`);
}

// Wait for an event to be emitted
export function waitForEvent<T>(
  emitter: { on: (event: string, listener: (data: T) => void) => void },
  eventName: string,
  options: { timeout?: number; filter?: (data: T) => boolean } = {}
): Promise<T> {
  const { timeout = 5000, filter } = options;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${eventName}`));
    }, timeout);

    emitter.on(eventName, (data: T) => {
      if (!filter || filter(data)) {
        clearTimeout(timer);
        resolve(data);
      }
    });
  });
}

// Flush all pending promises
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

// Create a deferred promise for controlled resolution
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// Mock timer utilities
export function useFakeTimers() {
  vi.useFakeTimers();

  return {
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    advanceToNext: () => vi.advanceTimersToNextTimer(),
    runAll: () => vi.runAllTimers(),
    restore: () => vi.useRealTimers(),
  };
}
```

### 5.3 Auth Context Mocking

```typescript
// tests/helpers/auth.ts
import { vi } from 'vitest';
import { createTestUser, type TestUser } from '../factories';

export interface MockAuthContext {
  user: TestUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

export function createMockAuthContext(options: {
  authenticated?: boolean;
  user?: TestUser;
  accessToken?: string;
} = {}): MockAuthContext {
  const {
    authenticated = true,
    user = authenticated ? createTestUser() : null,
    accessToken = authenticated ? 'test-access-token' : null,
  } = options;

  return {
    user,
    isAuthenticated: authenticated,
    isLoading: false,
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn().mockResolvedValue(accessToken),
  };
}

// Mock useAuth hook
export function mockUseAuth(context: MockAuthContext) {
  return vi.fn().mockReturnValue(context);
}
```

---

## 6. Fixture Data

### 6.1 Sample Projects

```typescript
// tests/fixtures/projects.ts
import type { Project, ProjectConfig } from '@/db/schema';
import { createTestId } from '../factories';

export const sampleProjects: Record<string, Omit<Project, 'id' | 'createdAt' | 'updatedAt'>> = {
  // Basic TypeScript project
  basic: {
    name: 'Basic TypeScript Project',
    path: '/Users/test/projects/basic-ts',
    description: 'A simple TypeScript project',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
      model: 'claude-sonnet-4-6',
    },
    maxConcurrentAgents: 3,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
  },

  // GitHub-connected project
  githubConnected: {
    name: 'GitHub Connected Project',
    path: '/Users/test/projects/github-project',
    description: 'A project connected to GitHub',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 100,
      model: 'claude-sonnet-4-6',
      initScript: 'bun run setup',
      envFile: '.env.local',
    },
    maxConcurrentAgents: 5,
    githubOwner: 'test-org',
    githubRepo: 'test-repo',
    githubInstallationId: '12345',
    configPath: '.claude',
  },

  // Restricted project
  restricted: {
    name: 'Restricted Project',
    path: '/Users/test/projects/restricted',
    description: 'A project with limited tools',
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'develop',
      allowedTools: ['Read', 'Glob', 'Grep'],
      maxTurns: 20,
      model: 'claude-sonnet-4-6',
    },
    maxConcurrentAgents: 1,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
  },
};

export function getSampleProject(name: keyof typeof sampleProjects): Project {
  const now = new Date();
  const sample = sampleProjects[name];

  return {
    id: createTestId('proj'),
    ...sample,
    createdAt: now,
    updatedAt: now,
  };
}
```

### 6.2 Sample Tasks in Various States

```typescript
// tests/fixtures/tasks.ts
import type { Task, TaskColumn } from '@/db/schema';
import { createTestId } from '../factories';

export interface SampleTaskSet {
  backlog: Task[];
  inProgress: Task[];
  waitingApproval: Task[];
  verified: Task[];
}

export function createSampleTaskSet(projectId: string): SampleTaskSet {
  const now = new Date();
  const createTask = (
    title: string,
    column: TaskColumn,
    position: number,
    extra: Partial<Task> = {}
  ): Task => ({
    id: createTestId('task'),
    projectId,
    agentId: null,
    sessionId: null,
    title,
    description: `Description for ${title}`,
    column,
    position,
    branch: column !== 'backlog' ? `feature/${createTestId('task')}-${title.toLowerCase().replace(/\s+/g, '-')}` : null,
    worktreeId: null,
    diffSummary: null,
    filesChanged: column === 'waiting_approval' ? 5 : null,
    linesAdded: column === 'waiting_approval' ? 150 : null,
    linesRemoved: column === 'waiting_approval' ? 30 : null,
    approvedAt: column === 'verified' ? now : null,
    approvedBy: column === 'verified' ? 'test-user' : null,
    rejectionReason: null,
    rejectionCount: 0,
    startedAt: column !== 'backlog' ? now : null,
    completedAt: column === 'verified' ? now : null,
    turnCount: column !== 'backlog' ? 25 : 0,
    labels: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...extra,
  });

  return {
    backlog: [
      createTask('Implement user authentication', 'backlog', 0),
      createTask('Add API rate limiting', 'backlog', 1),
      createTask('Create dashboard widgets', 'backlog', 2),
    ],
    inProgress: [
      createTask('Fix stream reconnection', 'in_progress', 0, {
        agentId: createTestId('agent'),
        sessionId: createTestId('sess'),
      }),
    ],
    waitingApproval: [
      createTask('Add dark mode support', 'waiting_approval', 0, {
        diffSummary: '+150 -30 in 5 files',
        filesChanged: 5,
        linesAdded: 150,
        linesRemoved: 30,
      }),
      createTask('Optimize database queries', 'waiting_approval', 1, {
        diffSummary: '+45 -120 in 3 files',
        filesChanged: 3,
        linesAdded: 45,
        linesRemoved: 120,
      }),
    ],
    verified: [
      createTask('Setup project structure', 'verified', 0),
      createTask('Add logging middleware', 'verified', 1),
    ],
  };
}
```

### 6.3 Sample Agent Execution Histories

```typescript
// tests/fixtures/agent-runs.ts
import type { AgentRun, AgentStatus } from '@/db/schema';
import { createTestId } from '../factories';

export interface AgentExecutionHistory {
  run: AgentRun;
  toolCalls: Array<{
    tool: string;
    input: Record<string, unknown>;
    output: unknown;
    duration: number;
  }>;
}

export function createSampleAgentRun(
  agentId: string,
  projectId: string,
  status: AgentStatus = 'completed',
  options: Partial<AgentRun> = {}
): AgentExecutionHistory {
  const startedAt = new Date(Date.now() - 300000); // 5 minutes ago
  const completedAt = status === 'completed' || status === 'error' ? new Date() : null;

  const toolCalls = [
    {
      tool: 'Read',
      input: { file_path: '/src/index.ts' },
      output: { content: '// File contents...' },
      duration: 150,
    },
    {
      tool: 'Grep',
      input: { pattern: 'function', path: '/src' },
      output: { matches: ['/src/index.ts:10'] },
      duration: 200,
    },
    {
      tool: 'Edit',
      input: {
        file_path: '/src/index.ts',
        old_string: 'old code',
        new_string: 'new code',
      },
      output: { success: true },
      duration: 100,
    },
    {
      tool: 'Bash',
      input: { command: 'bun test' },
      output: { exitCode: 0, stdout: 'Tests passed' },
      duration: 5000,
    },
  ];

  return {
    run: {
      id: createTestId('run'),
      agentId,
      taskId: options.taskId ?? createTestId('task'),
      projectId,
      sessionId: createTestId('sess'),
      status,
      prompt: 'Implement the authentication middleware',
      result: status === 'completed' ? 'Successfully implemented authentication middleware with JWT support.' : null,
      turnCount: 15,
      tokenInputCount: 25000,
      tokenOutputCount: 8000,
      toolCalls: toolCalls.map(tc => ({
        tool: tc.tool,
        count: 1,
        totalDuration: tc.duration,
      })),
      error: status === 'error' ? 'Execution failed: Rate limit exceeded' : null,
      errorType: status === 'error' ? 'RATE_LIMIT' : null,
      startedAt,
      completedAt,
      duration: completedAt ? completedAt.getTime() - startedAt.getTime() : null,
      ...options,
    },
    toolCalls,
  };
}
```

### 6.4 Sample GitHub Webhook Payloads

```typescript
// tests/fixtures/github-webhooks.ts
export const sampleWebhooks = {
  // Config file changed
  configPush: {
    ref: 'refs/heads/main',
    repository: {
      id: 12345,
      name: 'test-repo',
      full_name: 'test-org/test-repo',
      owner: { login: 'test-org', id: 1 },
      default_branch: 'main',
    },
    installation: { id: 67890 },
    commits: [
      {
        id: 'abc123',
        message: 'Update agent configuration',
        added: [],
        modified: ['.claude/config.json'],
        removed: [],
      },
    ],
    sender: { login: 'test-user', id: 100 },
  },

  // New installation
  installationCreated: {
    action: 'created',
    installation: {
      id: 67890,
      account: {
        id: 1,
        login: 'test-org',
        type: 'Organization',
        avatar_url: 'https://avatars.githubusercontent.com/u/1',
      },
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
      },
      repository_selection: 'selected',
    },
    repositories: [
      { id: 12345, name: 'test-repo', full_name: 'test-org/test-repo', private: false },
    ],
    sender: { login: 'test-user', id: 100 },
  },

  // PR opened
  pullRequestOpened: {
    action: 'opened',
    number: 42,
    pull_request: {
      number: 42,
      state: 'open',
      merged: false,
      head: { ref: 'feature/add-auth', sha: 'abc123' },
      base: { ref: 'main', sha: 'def456' },
      title: 'Add authentication',
      body: 'Implements user authentication with JWT.',
    },
    repository: {
      id: 12345,
      name: 'test-repo',
      full_name: 'test-org/test-repo',
      owner: { login: 'test-org' },
    },
    installation: { id: 67890 },
    sender: { login: 'test-user', id: 100 },
  },

  // PR merged
  pullRequestMerged: {
    action: 'closed',
    number: 42,
    pull_request: {
      number: 42,
      state: 'closed',
      merged: true,
      head: { ref: 'feature/add-auth', sha: 'abc123' },
      base: { ref: 'main', sha: 'def456' },
      title: 'Add authentication',
      body: 'Implements user authentication with JWT.',
      merged_at: new Date().toISOString(),
    },
    repository: {
      id: 12345,
      name: 'test-repo',
      full_name: 'test-org/test-repo',
      owner: { login: 'test-org' },
    },
    installation: { id: 67890 },
    sender: { login: 'test-user', id: 100 },
  },
};
```

---

## 7. E2E Test Setup

### 7.1 Global Setup

```typescript
// tests/e2e/global-setup.ts
import { execSync } from 'child_process';
import { seedTestDatabase, setupTestDatabase } from '../helpers/database';

export default async function globalSetup() {
  console.log('Setting up E2E test environment...');

  // Start test server
  const serverProcess = execSync('bun run dev &', {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '5173',
    },
  });

  // Wait for server to be ready
  let retries = 30;
  while (retries > 0) {
    try {
      const response = await fetch('http://localhost:5173/api/health');
      if (response.ok) break;
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    retries--;
  }

  if (retries === 0) {
    throw new Error('Test server failed to start');
  }

  // Setup and seed database
  await setupTestDatabase();
  await seedTestDatabase({ projects: 2, tasksPerProject: 5, agentsPerProject: 2 });

  console.log('E2E test environment ready');
}
```

### 7.2 Global Teardown

```typescript
// tests/e2e/global-teardown.ts
import { execSync } from 'child_process';
import { teardownTestDatabase } from '../helpers/database';

export default async function globalTeardown() {
  console.log('Tearing down E2E test environment...');

  // Stop test server
  try {
    execSync('pkill -f "bun run dev"');
  } catch {
    // Server might already be stopped
  }

  // Cleanup database
  await teardownTestDatabase();

  console.log('E2E test environment cleaned up');
}
```

### 7.3 E2E Test Utilities

```typescript
// tests/e2e/helpers.ts
import type { Page, Browser } from 'agent-browser';
import { seedTestDatabase, clearTestDatabase } from '../helpers/database';
import { createTestProject, createTestTask } from '../factories';

export interface E2ETestContext {
  page: Page;
  browser: Browser;
}

// Setup test project for E2E
export async function setupE2ETestProject(ctx: E2ETestContext): Promise<{
  project: ReturnType<typeof createTestProject>;
  tasks: ReturnType<typeof createTestTask>[];
}> {
  await clearTestDatabase();

  const { projects, tasks } = await seedTestDatabase({
    projects: 1,
    tasksPerProject: 5,
    agentsPerProject: 1,
  });

  return {
    project: projects[0],
    tasks,
  };
}

// Navigate and wait for page load
export async function navigateTo(ctx: E2ETestContext, path: string): Promise<void> {
  await ctx.page.goto(`http://localhost:5173${path}`);
  await ctx.page.waitForLoadState('networkidle');
}

// Wait for element with text
export async function waitForText(
  ctx: E2ETestContext,
  text: string,
  timeout: number = 5000
): Promise<void> {
  await ctx.page.waitForSelector(`text=${text}`, { timeout });
}

// Take screenshot on failure
export async function captureScreenshotOnFailure(
  ctx: E2ETestContext,
  testName: string
): Promise<string> {
  const screenshotPath = `tests/e2e/results/screenshots/${testName}-${Date.now()}.png`;
  await ctx.page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

// Drag and drop helper for Kanban
export async function dragTask(
  ctx: E2ETestContext,
  taskTitle: string,
  targetColumn: 'backlog' | 'in_progress' | 'waiting_approval' | 'verified'
): Promise<void> {
  const taskCard = await ctx.page.locator(`[data-testid="task-card"]:has-text("${taskTitle}")`);
  const targetDropzone = await ctx.page.locator(`[data-testid="column-${targetColumn}"]`);

  await taskCard.dragTo(targetDropzone);
  await ctx.page.waitForSelector(`[data-testid="column-${targetColumn}"] [data-testid="task-card"]:has-text("${taskTitle}")`);
}
```

### 7.4 Parallel Test Configuration

```typescript
// tests/e2e/parallel.config.ts
import { defineConfig } from 'agent-browser';

export default defineConfig({
  // Enable sharding for parallel execution across CI workers
  shard: {
    current: parseInt(process.env.SHARD_INDEX ?? '1', 10),
    total: parseInt(process.env.SHARD_TOTAL ?? '1', 10),
  },

  // Worker configuration
  workers: process.env.CI ? 4 : 1,
  fullyParallel: true,

  // Test isolation between workers
  testIsolation: true,

  // Report merging for parallel runs
  reporter: [
    ['html', { outputFolder: `tests/e2e/results/shard-${process.env.SHARD_INDEX ?? '1'}` }],
    ['json', { outputFile: `tests/e2e/results/shard-${process.env.SHARD_INDEX ?? '1'}/results.json` }],
  ],
});
```

---

## 8. CI Integration

### 8.1 GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # Unit and Integration Tests
  unit-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Type check
        run: bun run typecheck

      - name: Lint
        run: bun run lint

      - name: Unit tests
        run: bun run test:unit --coverage

      - name: Integration tests
        run: bun run test:integration --coverage

      - name: Merge coverage reports
        run: bun run coverage:merge

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          files: coverage/lcov.info
          flags: unit,integration
          fail_ci_if_error: true

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results-unit-integration
          path: |
            coverage/
            tests/results/

  # E2E Tests (Sharded)
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Install Agent Browser dependencies
        run: bunx agent-browser install

      - name: Run E2E tests (shard ${{ matrix.shard }}/4)
        run: bun run test:e2e --shard=${{ matrix.shard }}/4
        env:
          SHARD_INDEX: ${{ matrix.shard }}
          SHARD_TOTAL: 4

      - name: Upload E2E results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: e2e-results-shard-${{ matrix.shard }}
          path: |
            tests/e2e/results/
            tests/e2e/screenshots/
            tests/e2e/videos/

  # Merge E2E Results
  e2e-report:
    needs: e2e
    runs-on: ubuntu-latest
    if: always()
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Download all E2E results
        uses: actions/download-artifact@v4
        with:
          pattern: e2e-results-shard-*
          path: all-results/

      - name: Merge E2E reports
        run: bun run e2e:merge-reports

      - name: Upload merged E2E report
        uses: actions/upload-artifact@v4
        with:
          name: e2e-report
          path: tests/e2e/merged-report/

  # Coverage Gate
  coverage-gate:
    needs: [unit-integration]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download coverage
        uses: actions/download-artifact@v4
        with:
          name: test-results-unit-integration
          path: coverage/

      - name: Check coverage thresholds
        run: |
          COVERAGE=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
          if (( $(echo "$COVERAGE < 80" | bc -l) )); then
            echo "Coverage ($COVERAGE%) is below threshold (80%)"
            exit 1
          fi
          echo "Coverage: $COVERAGE%"
```

### 8.2 Test Scripts in package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "agent-browser test tests/e2e/",
    "test:coverage": "vitest run --coverage",
    "coverage:merge": "nyc merge coverage/ coverage/merged.json && nyc report --reporter=lcov --temp-dir=coverage",
    "e2e:merge-reports": "bun scripts/merge-e2e-reports.ts"
  }
}
```

---

## 9. Performance Testing

### 9.1 Benchmark Setup

```typescript
// tests/performance/benchmark.ts
import { bench, describe } from 'vitest';
import { getTestDatabase, seedTestDatabase } from '../helpers/database';
import { createTestProject, createTestTask } from '../factories';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';

describe('Database Performance', () => {
  bench('Insert 100 tasks', async () => {
    const db = await getTestDatabase();
    const project = createTestProject();

    await db.insert(schema.projects).values(project);

    const tasks = Array.from({ length: 100 }, (_, i) =>
      createTestTask({ projectId: project.id, position: i })
    );

    await db.insert(schema.tasks).values(tasks);
  }, { iterations: 10 });

  bench('Query tasks by project', async () => {
    const db = await getTestDatabase();
    await seedTestDatabase({ projects: 1, tasksPerProject: 100 });

    const projects = await db.select().from(schema.projects).limit(1);
    await db.select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, projects[0].id));
  }, { iterations: 100 });

  bench('Update task position (Kanban drag)', async () => {
    const db = await getTestDatabase();
    const { tasks } = await seedTestDatabase({ projects: 1, tasksPerProject: 50 });

    await db.update(schema.tasks)
      .set({ column: 'in_progress', position: 0 })
      .where(eq(schema.tasks.id, tasks[0].id));
  }, { iterations: 100 });
});
```

### 9.2 Load Testing Approach

```typescript
// tests/performance/load.ts
import { describe, it, expect } from 'vitest';

interface LoadTestResult {
  requestsPerSecond: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
}

async function runLoadTest(
  targetFn: () => Promise<void>,
  options: {
    duration: number; // seconds
    concurrency: number;
    rampUp?: number; // seconds
  }
): Promise<LoadTestResult> {
  const { duration, concurrency, rampUp = 0 } = options;
  const latencies: number[] = [];
  let errors = 0;
  let requests = 0;

  const startTime = Date.now();
  const endTime = startTime + (duration + rampUp) * 1000;

  const workers = Array.from({ length: concurrency }, async (_, workerIndex) => {
    // Stagger worker start for ramp-up
    if (rampUp > 0) {
      const delay = (rampUp * 1000 * workerIndex) / concurrency;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    while (Date.now() < endTime) {
      const requestStart = Date.now();
      try {
        await targetFn();
        latencies.push(Date.now() - requestStart);
      } catch {
        errors++;
      }
      requests++;
    }
  });

  await Promise.all(workers);

  const totalDuration = (Date.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);

  return {
    requestsPerSecond: requests / totalDuration,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    p99LatencyMs: latencies[Math.floor(latencies.length * 0.99)] ?? 0,
    errorRate: errors / requests,
  };
}

describe('Load Tests', () => {
  it('should handle 100 concurrent task queries', async () => {
    const result = await runLoadTest(
      async () => {
        await fetch('http://localhost:5173/api/tasks');
      },
      { duration: 10, concurrency: 100 }
    );

    expect(result.p95LatencyMs).toBeLessThan(500);
    expect(result.errorRate).toBeLessThan(0.01);
  }, { timeout: 30000 });
});
```

### 9.3 Metrics Collection

```typescript
// tests/performance/metrics.ts
import { performance, PerformanceObserver } from 'perf_hooks';

export interface PerformanceMetrics {
  name: string;
  duration: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  timestamp: number;
}

class MetricsCollector {
  private metrics: PerformanceMetrics[] = [];
  private observer: PerformanceObserver;

  constructor() {
    this.observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach(entry => {
        this.metrics.push({
          name: entry.name,
          duration: entry.duration,
          memory: process.memoryUsage(),
          timestamp: Date.now(),
        });
      });
    });
    this.observer.observe({ entryTypes: ['measure'] });
  }

  startMark(name: string): void {
    performance.mark(`${name}-start`);
  }

  endMark(name: string): void {
    performance.mark(`${name}-end`);
    performance.measure(name, `${name}-start`, `${name}-end`);
  }

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.startMark(name);
    try {
      return await fn();
    } finally {
      this.endMark(name);
    }
  }

  getMetrics(): PerformanceMetrics[] {
    return [...this.metrics];
  }

  getSummary(): {
    totalDuration: number;
    avgDuration: number;
    maxDuration: number;
    minDuration: number;
    count: number;
  } {
    if (this.metrics.length === 0) {
      return { totalDuration: 0, avgDuration: 0, maxDuration: 0, minDuration: 0, count: 0 };
    }

    const durations = this.metrics.map(m => m.duration);
    return {
      totalDuration: durations.reduce((a, b) => a + b, 0),
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxDuration: Math.max(...durations),
      minDuration: Math.min(...durations),
      count: durations.length,
    };
  }

  clear(): void {
    this.metrics = [];
    performance.clearMarks();
    performance.clearMeasures();
  }

  disconnect(): void {
    this.observer.disconnect();
  }
}

export const metricsCollector = new MetricsCollector();
```

---

## 10. Debugging Tests

### 10.1 Debug Configuration

```typescript
// tests/debug/config.ts
import { vi } from 'vitest';

export interface DebugOptions {
  verbose: boolean;
  logQueries: boolean;
  logEvents: boolean;
  pauseOnFailure: boolean;
}

const defaultDebugOptions: DebugOptions = {
  verbose: process.env.DEBUG === 'true',
  logQueries: process.env.DEBUG_QUERIES === 'true',
  logEvents: process.env.DEBUG_EVENTS === 'true',
  pauseOnFailure: process.env.DEBUG_PAUSE === 'true',
};

export function enableDebugMode(options: Partial<DebugOptions> = {}): void {
  const config = { ...defaultDebugOptions, ...options };

  if (config.verbose) {
    // Enable verbose console output
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      process.stdout.write(`[DEBUG] ${args.join(' ')}\n`);
    });
  }

  if (config.logQueries) {
    // Log all database queries
    vi.mock('@/db/client', async (importOriginal) => {
      const original = await importOriginal<typeof import('@/db/client')>();
      return {
        ...original,
        db: new Proxy(original.db, {
          get(target, prop) {
            const value = target[prop as keyof typeof target];
            if (typeof value === 'function') {
              return (...args: unknown[]) => {
                console.log(`[DB] ${String(prop)}`, args);
                return (value as Function).apply(target, args);
              };
            }
            return value;
          },
        }),
      };
    });
  }

  if (config.logEvents) {
    // Log all Durable Streams events
    vi.mock('@/lib/streams/server', async (importOriginal) => {
      const original = await importOriginal<typeof import('@/lib/streams/server')>();
      return {
        ...original,
        publishAgentEvent: (agentId: string, event: unknown) => {
          console.log(`[EVENT] agent:${agentId}`, JSON.stringify(event, null, 2));
          return original.publishAgentEvent(agentId, event as any);
        },
      };
    });
  }
}
```

### 10.2 Verbose Logging Helper

```typescript
// tests/debug/logger.ts
export class TestLogger {
  private logs: Array<{ level: string; message: string; data?: unknown; timestamp: Date }> = [];

  private log(level: string, message: string, data?: unknown): void {
    const entry = { level, message, data, timestamp: new Date() };
    this.logs.push(entry);

    if (process.env.DEBUG === 'true') {
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`[${level.toUpperCase()}] ${entry.timestamp.toISOString()} - ${message}${dataStr}`);
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  getLogs(level?: string): typeof this.logs {
    if (level) {
      return this.logs.filter(l => l.level === level);
    }
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
  }

  dump(): string {
    return this.logs
      .map(l => `[${l.level.toUpperCase()}] ${l.timestamp.toISOString()} - ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ''}`)
      .join('\n');
  }
}

export const testLogger = new TestLogger();
```

### 10.3 Snapshot Testing

```typescript
// tests/debug/snapshots.ts
import { expect } from 'vitest';

// Custom snapshot serializer for database entities
expect.addSnapshotSerializer({
  test: (val) => val && typeof val === 'object' && ('id' in val || 'createdAt' in val),
  serialize: (val, config, indentation, depth, refs, printer) => {
    const normalized = { ...val };

    // Normalize dynamic fields
    if ('id' in normalized && typeof normalized.id === 'string') {
      normalized.id = '[CUID2]';
    }
    if ('createdAt' in normalized) {
      normalized.createdAt = '[DATE]';
    }
    if ('updatedAt' in normalized) {
      normalized.updatedAt = '[DATE]';
    }

    return printer(normalized, config, indentation, depth, refs);
  },
});

// Snapshot test helper for API responses
export function toMatchApiSnapshot(response: unknown): void {
  expect(response).toMatchSnapshot();
}

// Snapshot test helper for database state
export async function toMatchDatabaseSnapshot(tableName: string): Promise<void> {
  const { getTestDatabase } = await import('../helpers/database');
  const db = await getTestDatabase();

  // Query all rows from the table
  const rows = await db.execute(`SELECT * FROM ${tableName} ORDER BY created_at`);

  expect(rows).toMatchSnapshot();
}
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Test Cases](./test-cases.md) | Test case definitions this infrastructure supports |
| [Database Schema](../database/schema.md) | Entity types for factories |
| [Error Catalog](../errors/error-catalog.md) | Error types for mock responses |
| [Agent Service](../services/agent-service.md) | Agent mocking patterns |
| [GitHub App](../integrations/github-app.md) | GitHub API mocking |
| [Durable Sessions](../integrations/durable-sessions.md) | Stream mocking |
| [Git Worktrees](../integrations/git-worktrees.md) | File system mocking |
