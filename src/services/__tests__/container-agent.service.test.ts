import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { err } from '../../lib/utils/result.js';

import type { AgentCoreBridgeService } from '../container-agent/agentcore-bridge.service.js';
import { ContainerAgentService } from '../container-agent/container-agent.service.js';
import type { ContainerExecService } from '../container-agent/container-exec.service.js';
import type { PlanApprovalService } from '../container-agent/plan-approval.service.js';
import type { SandboxStateManager } from '../container-agent/sandbox-state.js';

/**
 * ContainerAgentService tests
 *
 * Tests the facade pattern: methods should delegate to correct sub-services,
 * handle state properly, and propagate errors from sub-services.
 */

// ---------------------------------------------------------------------------
// Mock sub-service modules so the facade constructor receives controllable
// instances. We mock the modules at import level, then override per-test.
// ---------------------------------------------------------------------------

vi.mock('../container-agent/sandbox-state.js', () => {
  const SandboxStateManager = vi.fn();
  SandboxStateManager.prototype.hasAnyRunningAgent = vi.fn().mockReturnValue(false);
  SandboxStateManager.prototype.isStarting = vi.fn().mockReturnValue(false);
  SandboxStateManager.prototype.markStarting = vi.fn();
  SandboxStateManager.prototype.clearStarting = vi.fn();
  SandboxStateManager.prototype.getRunningAgentCoreAgent = vi.fn().mockReturnValue(undefined);
  SandboxStateManager.prototype.getRunningAgent = vi.fn().mockReturnValue(undefined);
  SandboxStateManager.prototype.getAnyRunningAgent = vi.fn().mockReturnValue(null);
  SandboxStateManager.prototype.getAllRunningAgents = vi.fn().mockReturnValue([]);
  SandboxStateManager.prototype.getAllRunningAgentCoreAgents = vi.fn().mockReturnValue([]);
  SandboxStateManager.prototype.getPendingPlan = vi.fn().mockReturnValue(undefined);
  SandboxStateManager.prototype.setPendingPlan = vi.fn();
  SandboxStateManager.prototype.deletePendingPlan = vi.fn();
  SandboxStateManager.prototype.dispose = vi.fn();
  return { SandboxStateManager };
});

vi.mock('../container-agent/worktree-init.service.js', () => {
  const WorktreeInitService = vi.fn();
  return { WorktreeInitService };
});

vi.mock('../container-agent/container-exec.service.js', () => {
  const ContainerExecService = vi.fn();
  ContainerExecService.prototype.startAgent = vi
    .fn()
    .mockResolvedValue({ ok: true, value: undefined });
  ContainerExecService.prototype.stopAgent = vi
    .fn()
    .mockResolvedValue({ ok: true, value: undefined });
  return { ContainerExecService };
});

vi.mock('../container-agent/agentcore-bridge.service.js', () => {
  const AgentCoreBridgeService = vi.fn();
  AgentCoreBridgeService.prototype.startAgentCoreAgent = vi
    .fn()
    .mockResolvedValue({ ok: true, value: undefined });
  AgentCoreBridgeService.prototype.stopAgentCoreAgent = vi
    .fn()
    .mockResolvedValue({ ok: true, value: undefined });
  return { AgentCoreBridgeService };
});

vi.mock('../container-agent/plan-approval.service.js', () => {
  const PlanApprovalService = vi.fn();
  PlanApprovalService.prototype.approvePlan = vi
    .fn()
    .mockResolvedValue({ ok: true, value: undefined });
  PlanApprovalService.prototype.rejectPlan = vi
    .fn()
    .mockResolvedValue({ ok: true, value: undefined });
  PlanApprovalService.prototype.getPendingPlan = vi.fn().mockResolvedValue(undefined);
  PlanApprovalService.prototype.handlePlanReady = vi.fn().mockResolvedValue(undefined);
  return { PlanApprovalService };
});

vi.mock('../../lib/sandbox/providers/agentcore-sandbox-provider.js', () => ({
  createAgentCoreProvider: vi.fn(() => ({
    name: 'agentcore',
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  return {
    query: {
      projects: {
        findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Test', path: '/tmp' }),
      },
    },
  } as any;
}

function createMockProvider() {
  return { name: 'docker' } as any;
}

function createMockStreams() {
  return { publish: vi.fn().mockResolvedValue(undefined) } as any;
}

function createMockApiKeyService() {
  return { getDecryptedKey: vi.fn().mockResolvedValue('sk-test') } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContainerAgentService', () => {
  let service: ContainerAgentService;
  let db: ReturnType<typeof createMockDb>;
  let provider: ReturnType<typeof createMockProvider>;
  let streams: ReturnType<typeof createMockStreams>;
  let apiKeyService: ReturnType<typeof createMockApiKeyService>;

  beforeEach(() => {
    vi.clearAllMocks();

    db = createMockDb();
    provider = createMockProvider();
    streams = createMockStreams();
    apiKeyService = createMockApiKeyService();

    service = new ContainerAgentService(db, provider, streams, apiKeyService);

    // After clearAllMocks, re-establish default mock return values on the new
    // instance's state manager so the startAgent guard checks pass by default.
    const state = (service as any).state as SandboxStateManager;
    vi.mocked(state.hasAnyRunningAgent).mockReturnValue(false);
    vi.mocked(state.isStarting).mockReturnValue(false);
    vi.mocked(state.getRunningAgentCoreAgent).mockReturnValue(undefined);
    vi.mocked(state.getAnyRunningAgent).mockReturnValue(null);
    vi.mocked(state.getAllRunningAgents).mockReturnValue([]);
    vi.mocked(state.getAllRunningAgentCoreAgents).mockReturnValue([]);

    // Re-establish default mock return values on sub-service methods
    const containerExec = (service as any).containerExec as ContainerExecService;
    vi.mocked(containerExec.startAgent).mockResolvedValue({ ok: true, value: undefined } as any);
    vi.mocked(containerExec.stopAgent).mockResolvedValue({ ok: true, value: undefined } as any);

    const agentCoreBridge = (service as any).agentCoreBridge as AgentCoreBridgeService;
    vi.mocked(agentCoreBridge.startAgentCoreAgent).mockResolvedValue({
      ok: true,
      value: undefined,
    } as any);
    vi.mocked(agentCoreBridge.stopAgentCoreAgent).mockResolvedValue({
      ok: true,
      value: undefined,
    } as any);

    const planApproval = (service as any).planApproval as PlanApprovalService;
    vi.mocked(planApproval.approvePlan).mockResolvedValue({ ok: true, value: undefined } as any);
    vi.mocked(planApproval.rejectPlan).mockResolvedValue({ ok: true, value: undefined } as any);
    vi.mocked(planApproval.getPendingPlan).mockResolvedValue(undefined);
  });

  // =========================================================================
  // startAgent delegation
  // =========================================================================

  describe('startAgent() delegation', () => {
    const baseInput = {
      projectId: 'proj-1',
      taskId: 'task-1',
      sessionId: 'sess-1',
      prompt: 'Build feature X',
    };

    it('delegates to ContainerExecService when no AgentCore provider is set', async () => {
      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(true);

      // ContainerExecService.startAgent should have been called
      const containerExec = (service as any).containerExec as ContainerExecService;
      expect(containerExec.startAgent).toHaveBeenCalledWith(baseInput);
    });

    it('delegates to AgentCoreBridgeService when AgentCore provider is set', async () => {
      service.setAgentCoreProvider({
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        runtimeArn: 'arn:aws:agentcore:test',
      });

      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(true);

      const agentCoreBridge = (service as any).agentCoreBridge as AgentCoreBridgeService;
      expect(agentCoreBridge.startAgentCoreAgent).toHaveBeenCalledWith(
        baseInput,
        expect.objectContaining({ id: 'proj-1' })
      );
    });

    it('returns AGENT_ALREADY_RUNNING when agent is already running for task', async () => {
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.hasAnyRunningAgent).mockReturnValue(true);

      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_ALREADY_RUNNING');
      }
    });

    it('returns AGENT_ALREADY_RUNNING when task is in the starting set', async () => {
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.isStarting).mockReturnValue(true);

      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_ALREADY_RUNNING');
      }
    });

    it('marks starting before delegation and clears after', async () => {
      const stateManager = (service as any).state as SandboxStateManager;

      await service.startAgent(baseInput);

      expect(stateManager.markStarting).toHaveBeenCalledWith('task-1');
      expect(stateManager.clearStarting).toHaveBeenCalledWith('task-1');
    });

    it('clears starting guard even when sub-service rejects', async () => {
      const containerExec = (service as any).containerExec as ContainerExecService;
      vi.mocked(containerExec.startAgent).mockRejectedValueOnce(new Error('Container blew up'));

      // The facade doesn't catch -- the rejection propagates through the finally block
      await expect(service.startAgent(baseInput)).rejects.toThrow('Container blew up');

      const stateManager = (service as any).state as SandboxStateManager;
      expect(stateManager.clearStarting).toHaveBeenCalledWith('task-1');
    });

    it('returns PROJECT_NOT_FOUND for AgentCore path when project missing', async () => {
      // Ensure state checks pass (not already running)
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.hasAnyRunningAgent).mockReturnValue(false);
      vi.mocked(stateManager.isStarting).mockReturnValue(false);

      service.setAgentCoreProvider({
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        runtimeArn: 'arn:aws:agentcore:test',
      });

      db.query.projects.findFirst.mockResolvedValue(null);

      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PROJECT_NOT_FOUND');
      }
    });
  });

  // =========================================================================
  // stopAgent delegation
  // =========================================================================

  describe('stopAgent() delegation', () => {
    it('delegates to ContainerExecService when no AgentCore agent is running', async () => {
      const result = await service.stopAgent('task-1');

      expect(result.ok).toBe(true);

      const containerExec = (service as any).containerExec as ContainerExecService;
      expect(containerExec.stopAgent).toHaveBeenCalledWith('task-1');
    });

    it('delegates to AgentCoreBridgeService when AgentCore agent is running', async () => {
      const agentCoreAgent = {
        taskId: 'task-1',
        sessionId: 'sess-1',
        projectId: 'proj-1',
        sandboxId: 'sb-1',
        startedAt: new Date(),
      };
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.getRunningAgentCoreAgent).mockReturnValue(agentCoreAgent as any);

      const result = await service.stopAgent('task-1');

      expect(result.ok).toBe(true);

      const agentCoreBridge = (service as any).agentCoreBridge as AgentCoreBridgeService;
      expect(agentCoreBridge.stopAgentCoreAgent).toHaveBeenCalledWith(agentCoreAgent);
    });

    it('propagates error from ContainerExecService.stopAgent', async () => {
      // Ensure state check returns no AgentCore agent
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.getRunningAgentCoreAgent).mockReturnValue(undefined);

      const containerExec = (service as any).containerExec as ContainerExecService;
      vi.mocked(containerExec.stopAgent).mockResolvedValueOnce(
        err(SandboxErrors.AGENT_NOT_RUNNING('task-1'))
      );

      const result = await service.stopAgent('task-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_NOT_RUNNING');
      }
    });
  });

  // =========================================================================
  // approvePlan delegation
  // =========================================================================

  describe('approvePlan() delegation', () => {
    it('delegates to PlanApprovalService', async () => {
      const result = await service.approvePlan('task-1');

      expect(result.ok).toBe(true);

      const planApproval = (service as any).planApproval as PlanApprovalService;
      expect(planApproval.approvePlan).toHaveBeenCalledWith('task-1');
    });

    it('propagates error from PlanApprovalService', async () => {
      const planApproval = (service as any).planApproval as PlanApprovalService;
      vi.mocked(planApproval.approvePlan).mockResolvedValue(
        err(SandboxErrors.PLAN_NOT_FOUND('task-1'))
      );

      const result = await service.approvePlan('task-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }
    });
  });

  // =========================================================================
  // rejectPlan delegation
  // =========================================================================

  describe('rejectPlan() delegation', () => {
    it('delegates to PlanApprovalService with reason', async () => {
      const result = await service.rejectPlan('task-1', 'Plan is incomplete');

      expect(result.ok).toBe(true);

      const planApproval = (service as any).planApproval as PlanApprovalService;
      expect(planApproval.rejectPlan).toHaveBeenCalledWith('task-1', 'Plan is incomplete');
    });

    it('propagates error from PlanApprovalService', async () => {
      const planApproval = (service as any).planApproval as PlanApprovalService;
      vi.mocked(planApproval.rejectPlan).mockResolvedValue(
        err(SandboxErrors.PLAN_NOT_FOUND('task-1'))
      );

      const result = await service.rejectPlan('task-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }
    });
  });

  // =========================================================================
  // getPendingPlan delegation
  // =========================================================================

  describe('getPendingPlan() delegation', () => {
    it('delegates to PlanApprovalService', async () => {
      const planApproval = (service as any).planApproval as PlanApprovalService;
      vi.mocked(planApproval.getPendingPlan).mockResolvedValue({
        taskId: 'task-1',
        plan: 'Step 1',
        sdkSessionId: 'sdk-1',
      } as any);

      const plan = await service.getPendingPlan('task-1');

      expect(plan).toBeDefined();
      expect(plan?.plan).toBe('Step 1');
      expect(planApproval.getPendingPlan).toHaveBeenCalledWith('task-1');
    });
  });

  // =========================================================================
  // Agent status queries
  // =========================================================================

  describe('agent status queries', () => {
    it('isAgentRunning delegates to state.hasAnyRunningAgent', () => {
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.hasAnyRunningAgent).mockReturnValue(true);

      expect(service.isAgentRunning('task-1')).toBe(true);
      expect(stateManager.hasAnyRunningAgent).toHaveBeenCalledWith('task-1');
    });

    it('getRunningAgent delegates to state.getAnyRunningAgent', () => {
      const info = { projectId: 'proj-1', sessionId: 'sess-1', startedAt: new Date() };
      const stateManager = (service as any).state as SandboxStateManager;
      vi.mocked(stateManager.getAnyRunningAgent).mockReturnValue(info);

      const result = service.getRunningAgent('task-1');

      expect(result).toBe(info);
      expect(stateManager.getAnyRunningAgent).toHaveBeenCalledWith('task-1');
    });

    it('getRunningAgents combines container and AgentCore agents', () => {
      const stateManager = (service as any).state as SandboxStateManager;
      const containerAgent = {
        taskId: 'task-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        startedAt: new Date(),
      };
      const agentCoreAgent = {
        taskId: 'task-2',
        projectId: 'proj-1',
        sessionId: 'sess-2',
        startedAt: new Date(),
      };
      vi.mocked(stateManager.getAllRunningAgents).mockReturnValue([containerAgent] as any);
      vi.mocked(stateManager.getAllRunningAgentCoreAgents).mockReturnValue([agentCoreAgent] as any);
      const running = service.getRunningAgents();

      expect(running).toHaveLength(2);
      expect(running[0]!.taskId).toBe('task-1');
      expect(running[1]!.taskId).toBe('task-2');
    });
  });

  // =========================================================================
  // AgentCore provider management
  // =========================================================================

  describe('AgentCore provider management', () => {
    it('providerName returns "docker" by default', () => {
      expect(service.providerName).toBe('docker');
    });

    it('providerName returns "agentcore" after setAgentCoreProvider', () => {
      service.setAgentCoreProvider({
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        runtimeArn: 'arn:aws:agentcore:test',
      });
      expect(service.providerName).toBe('agentcore');
    });

    it('clearAgentCoreProvider reverts to container provider name', () => {
      service.setAgentCoreProvider({
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        runtimeArn: 'arn:aws:agentcore:test',
      });
      expect(service.providerName).toBe('agentcore');

      service.clearAgentCoreProvider();
      expect(service.providerName).toBe('docker');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose()', () => {
    it('disposes state manager', () => {
      service.dispose();

      const stateManager = (service as any).state as SandboxStateManager;
      expect(stateManager.dispose).toHaveBeenCalled();
    });

    it('cleans up AgentCore provider when set', () => {
      service.setAgentCoreProvider({
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        runtimeArn: 'arn:aws:agentcore:test',
      });

      const agentCoreProvider = (service as any).agentCoreProvider;
      service.dispose();

      expect(agentCoreProvider.cleanup).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // setOnAgentComplete callback
  // =========================================================================

  describe('setOnAgentComplete()', () => {
    it('stores the callback for sub-services to access', () => {
      const callback = vi.fn();
      service.setOnAgentComplete(callback);

      expect((service as any).onAgentCompleteCallback).toBe(callback);
    });
  });
});
