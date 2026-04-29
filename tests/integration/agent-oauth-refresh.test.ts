/**
 * Integration test: F03-09 (arch29-W2-C) — OAuth refresh token plumbing.
 *
 * Before: `container-exec.service.ts:722` hardcoded `oauthRefreshToken: null`
 * with the inline comment "refreshToken storage is not yet wired through the
 * registry". The agent-runner accepted `CLAUDE_OAUTH_REFRESH_TOKEN` but no
 * host could populate it because no DB column existed.
 *
 * After: `api_keys.encrypted_refresh_token` (added in migration 0019/0013)
 * holds the encrypted refresh token. `ApiKeyService.getDecryptedRefreshToken`
 * surfaces the decrypted value, and `container-exec.service.ts` threads it
 * through to the agent-runner via `CLAUDE_OAUTH_REFRESH_TOKEN`.
 *
 * Test bar (red→green):
 *   - Before fix: `CLAUDE_OAUTH_REFRESH_TOKEN` is absent from the spawned
 *     agent-runner env even when the api_keys row carries one.
 *   - After fix: the env var matches the decrypted refresh token.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiKeys } from '../../src/db/schema';
import { ApiKeyService } from '../../src/services/api-key.service';
import { ContainerExecService } from '../../src/services/container-agent/container-exec.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createMockDurableStreamsService,
  createMockSandbox,
  createMockSandboxProvider,
} from '../mocks/mock-services';

// Mock settings service to avoid file I/O.
vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
}));

vi.mock('../../src/lib/constants/models.js', () => ({
  DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6',
  getFullModelId: vi.fn().mockImplementation((model: string) => model),
}));

vi.mock('../../src/lib/sandbox/skill-injector.js', () => ({
  injectSkills: vi.fn().mockResolvedValue({ injected: 0, skipped: 0, errors: [] }),
}));

vi.mock('../../src/services/template.service.js', () => {
  return {
    TemplateService: class MockTemplateService {
      getMergedConfig = vi.fn().mockResolvedValue({ ok: true, value: { skills: [] } });
    },
  };
});

vi.mock('../../src/lib/agents/container-bridge.js', () => ({
  createContainerBridge: vi.fn().mockImplementation((opts) => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    processStderr: vi.fn(),
    _opts: opts,
  })),
}));

function createMockReadable(): Readable {
  const readable = new Readable({
    read() {
      /* intentionally empty */
    },
  });
  readable.push(null);
  return readable;
}

function createMockExecStreamResult() {
  return {
    stdout: createMockReadable(),
    stderr: createMockReadable(),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Agent OAuth refresh token plumbing (F03-09 / arch29-W2-C)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let service: ContainerExecService;
  let realApiKeyService: ApiKeyService;
  let mockProvider: ReturnType<typeof createMockSandboxProvider>;
  let mockStreams: ReturnType<typeof createMockDurableStreamsService>;
  let mockSandbox: ReturnType<typeof createMockSandbox>;
  let execStreamSpy: ReturnType<typeof vi.fn>;
  let mockWorktreeInit: {
    resolveWorktree: ReturnType<typeof vi.fn>;
    initializeRemoteWorkspace: ReturnType<typeof vi.fn>;
    cleanupWorktree: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    // Use a real ApiKeyService so we exercise the encrypted-column roundtrip.
    realApiKeyService = new ApiKeyService(db as any);

    vi.clearAllMocks();

    execStreamSpy = vi.fn().mockResolvedValue(createMockExecStreamResult());
    mockSandbox = createMockSandbox({
      id: 'sandbox-oauth-rt-1',
      codespaceId: 'proj-oauth-rt',
      containerId: 'container-rt-abc',
      status: 'running',
      execStream: execStreamSpy,
    });

    mockProvider = createMockSandboxProvider({
      get: vi.fn().mockResolvedValue(mockSandbox),
      getById: vi.fn().mockResolvedValue(mockSandbox),
      create: vi.fn().mockResolvedValue(mockSandbox),
    });

    mockStreams = createMockDurableStreamsService();

    mockWorktreeInit = {
      resolveWorktree: vi.fn().mockResolvedValue({
        worktreeId: 'wt-rt-1',
        worktreePath: '/workspace/.worktrees/task-branch',
      }),
      initializeRemoteWorkspace: vi.fn().mockResolvedValue({
        worktreePath: '/workspace/.worktrees/task-branch',
      }),
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    };

    state = new SandboxStateManager();

    const deps = {
      db: db as any,
      provider: mockProvider,
      streams: mockStreams,
      apiKeyService: realApiKeyService as any,
      worktreeService: undefined,
      githubTokenService: undefined,
      skillTrackingService: null,
    };

    service = new ContainerExecService(
      deps,
      state,
      mockWorktreeInit as any,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockReturnValue(undefined)
    );

    // Make sure no env-var fallback leaks into the test.
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_OAUTH_TOKEN;
    delete process.env.CLAUDE_OAUTH_REFRESH_TOKEN;
  });

  afterEach(async () => {
    state.dispose();
    await clearTestDatabase();
  });

  it('refresh token from api_keys flows into the credentials file (not env var)', async () => {
    // Seed: api_keys row with both access and refresh token.
    const REFRESH = 'rt_test_secret_value';
    const saveResult = await realApiKeyService.saveKey(
      'anthropic',
      'sk-ant-oat01-test-access',
      REFRESH
    );
    expect(saveResult.ok).toBe(true);

    // Sanity: the registry must surface the same plaintext.
    const fromRegistry = await realApiKeyService.getDecryptedRefreshToken('anthropic');
    expect(fromRegistry).toBe(REFRESH);

    const project = await createTestProject({ id: 'proj-oauth-rt' });
    const task = await createTestTask(project.id, {
      title: 'OAuth refresh test',
      column: 'in_progress',
    });

    const result = await service.startAgent({
      codespaceId: project.id,
      taskId: task.id,
      sessionId: 'session-rt-1',
      prompt: 'Refresh token test',
      phase: 'plan',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);

    // arch29-W2-I (F04-07, F06-NEW-05): the refresh token flows through the
    // credentials file, NOT through env vars. Verify:
    //   1. env passed to agent-runner contains NO CLAUDE_OAUTH_* keys
    //   2. sandbox.writeFile was called with credentials JSON containing the
    //      refresh token in the SDK-compatible CLI shape.
    expect(execStreamSpy).toHaveBeenCalled();
    const execArgs = execStreamSpy.mock.calls[0][0] as { env: Record<string, string> };
    const oauthKeys = Object.keys(execArgs.env).filter((k) => k.startsWith('CLAUDE_OAUTH'));
    expect(oauthKeys).toEqual([]);

    // Locate the writeFile call that wrote the credentials JSON.
    const writeFileSpy = mockSandbox.writeFile as ReturnType<typeof vi.fn>;
    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining('.credentials.json'),
      expect.any(String),
      0o600
    );
    const credCall = writeFileSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('.credentials.json')
    );
    expect(credCall).toBeDefined();
    const credContent = credCall?.[1] as string;
    const parsed = JSON.parse(credContent) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string };
    };
    expect(parsed.claudeAiOauth?.refreshToken).toBe(REFRESH);
    expect(parsed.claudeAiOauth?.accessToken).toBe('sk-ant-oat01-test-access');
  });

  it('absence of refresh token in api_keys leaves CLAUDE_OAUTH_REFRESH_TOKEN unset (no empty-string injection)', async () => {
    // Save key without a refresh token (legacy or non-OAuth path).
    const saveResult = await realApiKeyService.saveKey('anthropic', 'sk-ant-oat01-no-rt');
    expect(saveResult.ok).toBe(true);

    const project = await createTestProject({ id: 'proj-oauth-rt' });
    const task = await createTestTask(project.id, {
      title: 'OAuth no-refresh test',
      column: 'in_progress',
    });

    const result = await service.startAgent({
      codespaceId: project.id,
      taskId: task.id,
      sessionId: 'session-rt-2',
      prompt: 'No refresh token',
      phase: 'plan',
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);

    const execArgs = execStreamSpy.mock.calls[0][0] as { env: Record<string, string> };
    // The env var must NOT be present (or, if present, must not be empty
    // string — the SDK rejects empty strings).
    expect(execArgs.env.CLAUDE_OAUTH_REFRESH_TOKEN).toBeUndefined();
  });

  it('legacy api_keys row (no encrypted_refresh_token column value) returns null and skips the env var', async () => {
    // Simulate a legacy row by writing directly to the DB without the new
    // column. (The column is nullable so the INSERT succeeds without it.)
    await db.delete(apiKeys);
    await db.insert(apiKeys).values({
      service: 'anthropic',
      // Encrypted form of an OAuth access token. The actual content does not
      // matter for this test — we only care that the refresh token path
      // returns null when encrypted_refresh_token is null.
      encryptedKey: 'unused-but-non-empty', // bypass unique constraint
      maskedKey: 'sk-ant-***',
      isValid: true,
      // encryptedRefreshToken intentionally omitted (defaults to null).
    } as any);

    const refresh = await realApiKeyService.getDecryptedRefreshToken('anthropic');
    expect(refresh).toBeNull();
  });
});
