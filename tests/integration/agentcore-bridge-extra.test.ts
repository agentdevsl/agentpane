/**
 * Additional integration coverage for AgentCoreBridgeService.
 *
 * Targets uncovered paths in the existing IT-1650..IT-1659 suite:
 *   - stopAgentCoreAgent catch block (lines 553-556) — the bridge.stop()
 *     or instance.stop() throws; verify the result is AGENT_STOP_FAILED
 *     and the agent is still cleaned up via the finally{} branch.
 *   - handleAgentCoreComplete onCompleteCallback rejection swallowing
 *     (line 621) — auto-dequeue callback rejects; the error is logged but
 *     the helper still returns normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCoreBridgeService } from '../../src/services/container-agent/agentcore-bridge.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

vi.mock('../../src/lib/agents/agentcore-bridge.js', () => ({
  createAgentCoreBridge: vi.fn(() => ({
    processStream: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  })),
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
  SettingsService: class MockSettings {
    constructor(private _db: unknown) {}
    getValue = vi.fn().mockResolvedValue(true);
  },
}));

vi.mock('../../src/services/container-agent/shared-helpers.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/container-agent/shared-helpers.js')>();
  return {
    ...original,
    resolveOAuthToken: vi.fn().mockResolvedValue('mock-oauth-token'),
    resolveOAuthExpiresAtMs: vi.fn().mockResolvedValue(null),
    updateAgentStatus: vi.fn().mockResolvedValue(undefined),
    updateTaskOnAgentComplete: vi.fn().mockResolvedValue(true),
    updateTaskOnAgentError: vi.fn().mockResolvedValue(undefined),
  };
});

function buildStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    deleteStream: vi.fn().mockResolvedValue(undefined),
  };
}

function buildProvider() {
  const instance = {
    invoke: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    provider: {
      get: vi.fn().mockReturnValue(instance),
      create: vi.fn().mockReturnValue(instance),
      getOrCreateSession: vi.fn().mockReturnValue('rt-1'),
      removeSession: vi.fn(),
    },
    instance,
  };
}

function buildApiKey() {
  return {
    getApiKey: vi.fn().mockResolvedValue('test-api-key'),
    getDecryptedKey: vi.fn().mockResolvedValue('sk-ant-oat01-tok'),
    getDecryptedRefreshToken: vi.fn().mockResolvedValue(null),
  };
}

describe('AgentCoreBridgeService — extra coverage (IT-AC-EXTRA)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let streams: ReturnType<typeof buildStreams>;
  let provider: ReturnType<typeof buildProvider>;
  let mockContainerExec: {
    handleAgentComplete: ReturnType<typeof vi.fn>;
    handleAgentError: ReturnType<typeof vi.fn>;
  };
  let service: AgentCoreBridgeService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    state = new SandboxStateManager();
    streams = buildStreams();
    provider = buildProvider();
    mockContainerExec = {
      handleAgentComplete: vi.fn().mockResolvedValue(undefined),
      handleAgentError: vi.fn().mockResolvedValue(undefined),
    };

    const deps = {
      db,
      provider: {} as never,
      streams: streams as never,
      apiKeyService: buildApiKey() as never,
    };
    service = new AgentCoreBridgeService(
      deps,
      state,
      mockContainerExec as never,
      () => provider.provider as never,
      vi.fn().mockResolvedValue(undefined),
      () => undefined
    );
  });

  afterEach(async () => {
    state.dispose();
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  it('stopAgentCoreAgent returns AGENT_STOP_FAILED when instance.stop throws', async () => {
    const failingInstance = {
      invoke: vi.fn(),
      stop: vi.fn().mockRejectedValue(new Error('runtime crashed')),
    };
    const agent = {
      taskId: 'task-stop-fail',
      sessionId: 'sess-stop-fail',
      codespaceId: 'cs-stop',
      sandboxId: 'sb-stop',
      bridge: { processStream: vi.fn(), stop: vi.fn() },
      instance: failingInstance,
      runtimeSessionId: 'rt-stop-fail',
      startedAt: new Date(),
      stopRequested: false,
      phase: 'plan' as const,
    };
    state.setRunningAgentCoreAgent('task-stop-fail', agent as never);

    const result = await service.stopAgentCoreAgent(agent as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_AGENT_STOP_FAILED');
      expect(result.error.message).toContain('runtime crashed');
    }

    // The finally{} branch should still clean up
    expect(state.hasRunningAgentCoreAgent('task-stop-fail')).toBe(false);
  });

  it('handleAgentCoreComplete swallows onAgentCompleteCallback rejection', async () => {
    const rejectingCallback = vi.fn().mockRejectedValue(new Error('dequeue gone'));
    const deps = {
      db,
      provider: {} as never,
      streams: streams as never,
      apiKeyService: buildApiKey() as never,
    };
    const serviceWithBadCallback = new AgentCoreBridgeService(
      deps,
      state,
      mockContainerExec as never,
      () => provider.provider as never,
      vi.fn().mockResolvedValue(undefined),
      () => rejectingCallback
    );

    const agent = {
      taskId: 'task-cb-fail',
      sessionId: 'sess-cb-fail',
      codespaceId: 'cs-cb-fail',
      sandboxId: 'sb-cb-fail',
      bridge: { processStream: vi.fn(), stop: vi.fn() },
      instance: { invoke: vi.fn(), stop: vi.fn() },
      runtimeSessionId: 'rt-cb-fail',
      startedAt: new Date(),
      stopRequested: false,
      phase: 'execute' as const,
    };
    state.setRunningAgentCoreAgent('task-cb-fail', agent as never);

    // Should not throw despite the callback rejection
    await expect(
      serviceWithBadCallback.handleAgentCoreComplete('task-cb-fail', 'completed', 1)
    ).resolves.toBeUndefined();

    expect(rejectingCallback).toHaveBeenCalledWith('cs-cb-fail', 'task-cb-fail');
    // Allow the catch handler microtask to flush
    await new Promise((r) => setTimeout(r, 10));

    // State still cleaned up
    expect(state.hasRunningAgentCoreAgent('task-cb-fail')).toBe(false);
  });
});
