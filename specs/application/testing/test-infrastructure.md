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
| Vitest | ^4.0.16 | Unit and integration testing |
| Playwright | ^1.58.2 | E2E browser automation |
| Agent Browser | 0.7.6 | AI-powered E2E test interactions |
| better-sqlite3 | ^12.6.2 | In-memory SQLite for test isolation (`:memory:`) |
| jsdom | ^28.1.0 | Browser environment for component tests |
| @testing-library/react | ^16.3.0 | React component testing utilities |
| @testing-library/jest-dom | ^6.8.0 | Custom DOM matchers for Vitest |
| @testing-library/user-event | ^14.6.1 | User interaction simulation |
| @vitest/coverage-v8 | ^4.0.16 | Code coverage provider |
| Drizzle ORM | ^0.45.1 | Type-safe database operations |
| @paralleldrive/cuid2 | ^3.3.0 | Collision-resistant ID generation for tests |

---

## 1. Test Environment Setup

### 1.1 Vitest Configuration

```typescript
// vitest.config.ts
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    env: {
      PGLITE_DATA_DIR: '',
    },
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      'node_modules',
      'dist',
      '.claude',
      '.worktrees',
      'submodule',
      '**/_archived/**',
      'packages/**',
      'tests/diagram-overlap.spec.ts',
    ],
    alias: {
      '@/db/client': resolve(__dirname, './src/db/client.ts'),
      '@/services/agent.service': resolve(__dirname, './src/services/agent.service.ts'),
      '@/services/session.service': resolve(__dirname, './src/services/session.service.ts'),
      '@/services/task.service': resolve(__dirname, './src/services/task.service.ts'),
      '@/services/worktree.service': resolve(__dirname, './src/services/worktree.service.ts'),
      '@/services/project.service': resolve(__dirname, './src/services/project.service.ts'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.{test,spec}.tsx',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/index.ts',
        'src/app/**/*.ts',
        'src/app/**/*.tsx',
        'src/types/**/*.ts',
        'src/lib/types/**/*.ts',
      ],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        statements: 74,
        branches: 64,
        functions: 80,
        lines: 74,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@agentpane/agent-sandbox-sdk': resolve(
        __dirname,
        './packages/agent-sandbox-sdk/src/index.ts'
      ),
      '@agentpane/nomad-sandbox-sdk': resolve(
        __dirname,
        './packages/nomad-sandbox-sdk/src/index.ts'
      ),
    },
  },
});
```

There is also a separate E2E config:

```typescript
// vitest.e2e.config.ts
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/smoke.test.ts', 'tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/k8s/**'],
    testTimeout: 60000,
    hookTimeout: 30000,
    setupFiles: ['./tests/e2e/setup.ts'],
    sequence: {
      concurrent: false,
    },
    maxConcurrency: 1,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

> **Note**: No `vitest.workspace.ts` file is used. Unit, integration, and service tests all live under the same config. Integration tests can be targeted via `vitest --include 'tests/integration/**'`.

### 1.3 Test Setup File

```typescript
// tests/setup.ts
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { clearTestDatabase, closeTestDatabase, setupTestDatabase } from './helpers/database';

vi.stubEnv('ANTHROPIC_API_KEY', 'test-api-key');
vi.stubEnv('NODE_ENV', 'test');

beforeAll(async () => {
  await setupTestDatabase();
});

afterEach(async () => {
  await clearTestDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeTestDatabase();
});
```

### 1.4 Environment Variables for Testing

```typescript
// tests/helpers/env.ts
import { vi } from 'vitest';

export const TEST_ENV = {
  ANTHROPIC_API_KEY: 'test-api-key-sk-ant-12345',
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
  SESSION_SECRET: 'test-session-secret-32-chars-long!',
  BASE_URL: 'http://localhost:3000',
  PGLITE_DATA_DIR: '',
  NODE_ENV: 'test',
} as const;

export function setupTestEnv(): void {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    vi.stubEnv(key, value);
  }
}

export function resetTestEnv(): void {
  vi.unstubAllEnvs();
}

export function withTestEnv<T>(overrides: Partial<typeof TEST_ENV>, fn: () => T): T {
  const originalEnv = { ...process.env };
  try {
    setupTestEnv();
    for (const [key, value] of Object.entries(overrides)) {
      vi.stubEnv(key, value);
    }
    return fn();
  } finally {
    vi.unstubAllEnvs();
    Object.assign(process.env, originalEnv);
  }
}

export function mockEnvVar(key: string, value: string): () => void {
  const original = process.env[key];
  vi.stubEnv(key, value);
  return () => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      vi.stubEnv(key, original);
    }
  };
}
```

### 1.5 E2E Test Setup (Playwright)

E2E tests use Playwright for browser automation, configured via `vitest.e2e.config.ts` (see section 1.1) and a shared setup file:

```typescript
// tests/e2e/setup.ts
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { afterAll, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

// Server is considered running if E2E_BASE_URL is explicitly set
export const serverRunning = process.env.E2E_BASE_URL !== undefined;
export let browserReady = false;

let browser: Browser | null = null;
let page: Page | null = null;

// Exported helpers: open(), goto(), click(), fill(), getText(),
// waitForSelector(), waitForHidden(), waitForNetworkIdle(),
// screenshot(), drag(), exists(), getAll(), type(), press(),
// hover(), getAttribute(), getUrl(), close()

beforeAll(async () => {
  if (!serverRunning) return;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  page = await context.newPage();
  browserReady = true;
}, 30000);

afterAll(async () => {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
    browserReady = false;
  }
});
```

Run E2E tests with:
```bash
E2E_BASE_URL=http://localhost:3000 bun run test:e2e
```

---

## 2. Mock Strategies

> **Actual file layout**: The mock code examples below use illustrative subdirectory paths (e.g., `tests/mocks/github/`, `tests/mocks/claude/`). In the actual codebase, all mocks live as flat files in `tests/mocks/`:
>
> ```
> tests/mocks/
> ├── index.ts                  # Barrel export (re-exports all mocks)
> ├── external.ts               # Claude SDK, Durable Streams, Octokit auto-mocks
> ├── mock-builders.ts          # Type-safe Drizzle DB mock builders
> ├── mock-api.ts               # Hono context, request/response mocks
> ├── mock-git.ts               # Git command runner mocks
> ├── mock-sandbox.ts           # Sandbox provider/instance mocks
> ├── mock-streams.ts           # Durable Streams mock utilities
> ├── mock-services.ts          # Service interface mocks
> ├── mock-scenarios.ts         # Fully-wired service scenario builders
> ├── mock-agent-lifecycle.ts   # Agent lifecycle mock objects
> ├── mock-container-bridge.ts  # Container bridge event generators
> ├── git.ts                    # Legacy git command mocks
> └── services.ts               # Legacy service mocks
> ```
>
> Additionally, `tests/helpers/simulate-agent-stream.ts` provides mock SDK stream generators for planning/execution flow testing.

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

Factories are **DB-backed**: each `createTest*` function inserts a record into the in-memory SQLite test database and returns the persisted row. Each entity type lives in its own file under `tests/factories/`. A corresponding `build*` function creates the plain object without inserting.

```
tests/factories/
├── index.ts               # Barrel re-exports + shared types
├── project.factory.ts     # createTestProject, createTestProjects, buildProject
├── task.factory.ts         # createTestTask, createTestTasks, createTasksInColumns, buildTask
├── agent.factory.ts        # createTestAgent, createTestAgents, createRunningAgent, buildAgent
├── session.factory.ts      # createTestSession, createTestSessions, createActiveSession, createClosedSession, buildSession
├── worktree.factory.ts     # createTestWorktree, createTestWorktrees, createActiveWorktree, createMergedWorktree, createRemovedWorktree, buildWorktree
├── agent-run.factory.ts    # createTestAgentRun, createTestAgentRuns, createCompletedAgentRun, createFailedAgentRun, buildAgentRun
└── event-source.factory.ts # createTestEventSource, createTestSubscription, buildEventSource, buildSubscription
```

```typescript
// tests/factories/index.ts
import type { Agent, AgentRun, Project, Session, Task, Worktree } from '../../src/db/schema';

export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export { createTestAgent } from './agent.factory';
export { createTestAgentRun } from './agent-run.factory';
export * from './event-source.factory';
export { createTestProject } from './project.factory';
export { createTestSession } from './session.factory';
export { createTestTask } from './task.factory';
export { createTestWorktree } from './worktree.factory';

export type { Project, Task, Agent, Session, Worktree, AgentRun };
```

Example factory (project):

```typescript
// tests/factories/project.factory.ts
import { createId } from '@paralleldrive/cuid2';
import type { NewProject, Project, ProjectConfig } from '../../src/db/schema';
import { projects } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

export type ProjectFactoryOptions = Partial<NewProject> & {
  config?: Partial<ProjectConfig>;
};

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  worktreeRoot: '.worktrees',
  defaultBranch: 'main',
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  maxTurns: 50,
};

export function buildProject(options: ProjectFactoryOptions = {}): NewProject {
  const id = options.id ?? createId();
  return {
    id,
    name: options.name ?? `Test Project ${id.slice(0, 6)}`,
    path: options.path ?? `/tmp/test-project-${id}`,
    description: options.description ?? null,
    config: { ...DEFAULT_PROJECT_CONFIG, ...options.config },
    maxConcurrentAgents: options.maxConcurrentAgents ?? 3,
    githubOwner: options.githubOwner ?? null,
    githubRepo: options.githubRepo ?? null,
    githubInstallationId: options.githubInstallationId ?? null,
    configPath: options.configPath ?? '.claude',
    sandboxConfigId: options.sandboxConfigId ?? null,
  };
}

export async function createTestProject(options: ProjectFactoryOptions = {}): Promise<Project> {
  const db = getTestDb();
  const data = buildProject(options);
  const [project] = await db.insert(projects).values(data).returning();
  if (!project) throw new Error('Failed to create test project');
  return project;
}
```

All other entity factories follow the same pattern: `build*()` for the plain object, `createTest*()` for DB insertion.

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

### 4.1 In-Memory better-sqlite3 Setup

The test database uses better-sqlite3 with `:memory:` mode for fast, isolated test execution. It also supports an optional `DB_MODE=postgres` path for Postgres integration testing.

```typescript
// tests/helpers/database.ts
import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../src/db/schema/sqlite';
import {
  EVENT_SYSTEM_MIGRATION_SQL,
  MIGRATION_SQL,
  RBAC_GITHUB_TOKEN_MIGRATION_SQL,
  RBAC_MIGRATION_SQL,
} from '../../src/lib/bootstrap/phases/schema';

const DB_MODE = process.env.DB_MODE ?? 'sqlite';
type TestDatabase = BetterSQLite3Database<typeof schema>;

let testSqlite: SQLiteDatabase | null = null;
let testDb: TestDatabase | null = null;

export async function setupTestDatabase(): Promise<TestDatabase> {
  if (testDb) return testDb;

  // Use in-memory SQLite for tests
  testSqlite = new Database(':memory:');
  testSqlite.pragma('foreign_keys = ON');
  testDb = drizzle(testSqlite, { schema });

  // Run base migrations
  testSqlite.exec(MIGRATION_SQL);

  // Add team_id column before RBAC migration (which creates an index on it)
  try {
    testSqlite.exec(RBAC_GITHUB_TOKEN_MIGRATION_SQL);
  } catch {
    // column may already exist
  }

  // Run RBAC migrations (teams, task_tags, api_tokens, etc.)
  testSqlite.exec(RBAC_MIGRATION_SQL);

  // Run event system migrations (event_sources, event_subscriptions, event_log)
  testSqlite.exec(EVENT_SYSTEM_MIGRATION_SQL);

  return testDb;
}

export function getTestDb(): TestDatabase {
  if (!testDb) throw new Error('Test database not initialized');
  return testDb;
}

export async function clearTestDatabase(): Promise<void> {
  if (!testDb) return;

  // Delete in order respecting foreign key constraints
  await testDb.delete(schema.auditLogs);
  await testDb.delete(schema.eventLog);
  await testDb.delete(schema.eventSubscriptions);
  await testDb.delete(schema.eventSources);
  await testDb.delete(schema.agentRuns);
  await testDb.delete(schema.sessions);
  await testDb.delete(schema.worktrees);
  await testDb.delete(schema.tasks);
  await testDb.delete(schema.agents);
  await testDb.delete(schema.repositoryConfigs);
  await testDb.delete(schema.githubInstallations);
  await testDb.delete(schema.githubTokens);
  // RBAC tables
  await testDb.delete(schema.taskTags);
  await testDb.delete(schema.projectTags);
  await testDb.delete(schema.apiTokens);
  await testDb.delete(schema.teamInvitations);
  await testDb.delete(schema.projectMembers);
  await testDb.delete(schema.teamProjects);
  await testDb.delete(schema.teamMembers);
  await testDb.delete(schema.tags);
  await testDb.delete(schema.teams);
  await testDb.delete(schema.projects);
  await testDb.delete(schema.sandboxConfigs);
  await testDb.delete(schema.marketplaces);
}

export async function closeTestDatabase(): Promise<void> {
  if (testSqlite) {
    testSqlite.close();
    testSqlite = null;
    testDb = null;
  }
}

// Seed database with test data using factories
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';

export type SeedOptions = {
  projects?: number;
  tasksPerProject?: number;
  agentsPerProject?: number;
};

export async function seedTestDatabase(options: SeedOptions = {}): Promise<schema.Project[]> {
  const { projects = 1, tasksPerProject = 5, agentsPerProject = 2 } = options;

  const createdProjects: schema.Project[] = [];

  for (let projectIndex = 0; projectIndex < projects; projectIndex += 1) {
    const project = await createTestProject({
      name: `Test Project ${projectIndex + 1}`,
    });
    createdProjects.push(project);

    for (let agentIndex = 0; agentIndex < agentsPerProject; agentIndex += 1) {
      await createTestAgent(project.id, { name: `Agent ${agentIndex + 1}` });
    }

    for (let taskIndex = 0; taskIndex < tasksPerProject; taskIndex += 1) {
      await createTestTask(project.id, { title: `Task ${taskIndex + 1}` });
    }
  }

  return createdProjects;
}
```

### 4.2 Test Isolation Strategy

Tests use the `clearTestDatabase()` function in `afterEach` (called from `tests/setup.ts`) to delete all rows between tests, rather than transaction-based rollback. This approach is simpler with SQLite's in-memory mode and avoids complexity around SQLite's limited savepoint support.

For tests that need additional raw SQL (e.g., custom migrations), the `execRawSql()` helper is available:

```typescript
// tests/helpers/database.ts (excerpt)
export function execRawSql(sql: string): void {
  if (!testSqlite) throw new Error('Test database not initialized');
  testSqlite.exec(sql);
}
```

---

## 5. Test Utilities

### 5.1 React Component Testing

Component tests use `@testing-library/react` directly with `render`, `screen`, and `fireEvent`. The Vitest environment is set to `jsdom` (see vitest.config.ts) and `@testing-library/jest-dom/vitest` is imported in `tests/setup.ts` for custom DOM matchers.

```typescript
// Example component test pattern
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MyComponent } from '@/app/components/features/my-component';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Expected text')).toBeInTheDocument();
  });

  it('handles user interaction', async () => {
    const onAction = vi.fn();
    render(<MyComponent onAction={onAction} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onAction).toHaveBeenCalled();
  });
});
```

> **Note**: This project uses `@tanstack/db` and `@tanstack/react-db` for client state (not `@tanstack/react-query`). There is no `QueryClientProvider` wrapper needed for component tests.

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

> **Note**: The `tests/fixtures/` directory does not currently exist in the codebase. The DB-backed factories in `tests/factories/` serve as the primary mechanism for creating test data. The patterns below are reference designs for future fixture files if needed.

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

E2E tests use **Playwright** (not agent-browser) for browser automation, run via `vitest.e2e.config.ts`. The setup is in `tests/e2e/setup.ts` (see section 1.5).

### 7.1 Running E2E Tests

The server must be running separately before E2E tests execute. Tests are gated by the `E2E_BASE_URL` environment variable:

```bash
# Start dev server first
npm run dev

# Then run E2E tests in another terminal
E2E_BASE_URL=http://localhost:3000 bun run test:e2e
```

### 7.2 E2E Test Structure

E2E tests live in `tests/e2e/` and include component-level tests and workflow tests:

```
tests/e2e/
├── setup.ts                     # Playwright browser lifecycle (beforeAll/afterAll)
├── smoke.test.ts                # Basic health checks (run first)
├── kanban-workflow.test.ts      # Kanban board E2E flow
├── agent-session.test.ts        # Agent session E2E
├── workflow.test.ts             # Full workflow E2E
├── project-workflow.test.ts     # Project lifecycle E2E
├── k8s/                         # Kubernetes E2E tests
│   └── agent-sandbox-e2e.test.ts
└── components/                  # Component-focused E2E tests
    ├── navigation.test.ts
    ├── kanban.test.ts
    ├── session.test.ts
    ├── settings.test.ts
    ├── global-settings.test.ts
    ├── dialogs.test.ts
    ├── sidebar.test.ts
    ├── shortcuts.test.ts
    ├── states.test.ts
    └── ui-components.test.ts
```

### 7.3 E2E Helpers

The `tests/e2e/setup.ts` exports Playwright helper functions used by all E2E tests:

| Helper | Purpose |
|--------|---------|
| `goto(path)` | Navigate to a path (relative to BASE_URL) |
| `click(selector)` | Click an element |
| `fill(selector, text)` | Fill an input field |
| `getText(selector)` | Get text content |
| `waitForSelector(selector)` | Wait for element to appear |
| `waitForHidden(selector)` | Wait for element to disappear |
| `waitForNetworkIdle()` | Wait for network to settle |
| `screenshot(name)` | Take a screenshot |
| `drag(source, target)` | Drag and drop |
| `exists(selector)` | Check if element is visible |
| `type(selector, text)` | Type text character by character |
| `press(key)` | Press a keyboard key |
| `hover(selector)` | Hover over an element |

### 7.4 E2E Configuration

E2E tests run sequentially (no parallelism) with a single browser instance:

- `maxConcurrency: 1`, `maxWorkers: 1`
- `testTimeout: 60000` (60 seconds per test)
- `hookTimeout: 30000` (30 seconds for setup/teardown)
- Smoke test runs first to verify server health
- K8s E2E tests excluded by default (run via `bun run test:k8s-e2e`)

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

      - name: Unit + Integration tests
        run: bun run test:coverage

      - name: Integration tests (targeted)
        run: bun run test:integration

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

      - name: Install Playwright browsers
        run: bunx playwright install --with-deps chromium

      - name: Run E2E tests (shard ${{ matrix.shard }}/4)
        run: bun run test:e2e --shard=${{ matrix.shard }}/4
        env:
          E2E_BASE_URL: http://localhost:3000
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
    "test:coverage": "vitest run --coverage",
    "test:e2e": "vitest --config vitest.e2e.config.ts",
    "test:ui": "bun scripts/run-ui-tests.ts",
    "test:integration": "vitest --include 'tests/integration/**'",
    "test:k8s": "K8S_INTEGRATION_TESTS=true vitest run --include 'src/lib/sandbox/providers/__tests__/k8s-tmux.integration.test.ts'",
    "test:k8s-e2e": "K8S_E2E=true vitest run tests/e2e/k8s/"
  }
}
```

---

## 9. Performance Testing

### 9.1 Benchmark Setup

```typescript
// tests/performance/benchmark.ts
import { bench, describe } from 'vitest';
import { getTestDb, seedTestDatabase } from '../helpers/database';
import { createTestProject, createTestTask } from '../factories';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';

describe('Database Performance', () => {
  bench('Insert 100 tasks', async () => {
    const db = await getTestDb();
    const project = createTestProject();

    await db.insert(schema.projects).values(project);

    const tasks = Array.from({ length: 100 }, (_, i) =>
      createTestTask({ projectId: project.id, position: i })
    );

    await db.insert(schema.tasks).values(tasks);
  }, { iterations: 10 });

  bench('Query tasks by project', async () => {
    const db = await getTestDb();
    await seedTestDatabase({ projects: 1, tasksPerProject: 100 });

    const projects = await db.select().from(schema.projects).limit(1);
    await db.select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, projects[0].id));
  }, { iterations: 100 });

  bench('Update task position (Kanban drag)', async () => {
    const db = await getTestDb();
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
        await fetch('http://localhost:3000/api/tasks');
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
  const { getTestDb } = await import('../helpers/database');
  const db = await getTestDb();

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
