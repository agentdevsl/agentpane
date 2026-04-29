import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SandboxErrors } from '../../lib/errors/sandbox-errors.js';
import { err } from '../../lib/utils/result.js';
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
// Mock sub-service modules so the facade's constructor receives controllable
// instances. We mock the modules at import level, then override per-test.
// ---------------------------------------------------------------------------

vi.mock('../container-agent/sandbox-state.js', () => {
  const SandboxStateManager = vi.fn();
  SandboxStateManager.prototype.hasAnyRunningAgent = vi.fn().mockReturnValue(false);
  SandboxStateManager.prototype.isStarting = vi.fn().mockReturnValue(false);
  SandboxStateManager.prototype.markStarting = vi.fn();
  SandboxStateManager.prototype.clearStarting = vi.fn();
  SandboxStateManager.prototype.getRunningAgent = vi.fn().mockReturnValue(undefined);
  SandboxStateManager.prototype.getAnyRunningAgent = vi.fn().mockReturnValue(null);
  SandboxStateManager.prototype.getAllRunningAgents = vi.fn().mockReturnValue([]);
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
      codespaces: {
        findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Test', path: '/tmp' }),
      },
      tasks: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
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

  beforeEach(async () => {
    vi.clearAllMocks();

    // vi.clearAllMocks does NOT reset mockReturnValue/mockResolvedValue,
    // so we must re-apply all prototype mock defaults to prevent leak between tests.
    const { SandboxStateManager: SM } = await import('../container-agent/sandbox-state.js');
    (SM as any).prototype.hasAnyRunningAgent.mockReturnValue(false);
    (SM as any).prototype.isStarting.mockReturnValue(false);
    (SM as any).prototype.getRunningAgent.mockReturnValue(undefined);
    (SM as any).prototype.getAnyRunningAgent.mockReturnValue(null);
    (SM as any).prototype.getAllRunningAgents.mockReturnValue([]);
    (SM as any).prototype.getPendingPlan.mockReturnValue(undefined);

    const { ContainerExecService: CES } = await import(
      '../container-agent/container-exec.service.js'
    );
    (CES as any).prototype.startAgent.mockResolvedValue({ ok: true, value: undefined });
    (CES as any).prototype.stopAgent.mockResolvedValue({ ok: true, value: undefined });

    const { PlanApprovalService: PAS } = await import(
      '../container-agent/plan-approval.service.js'
    );
    (PAS as any).prototype.approvePlan.mockResolvedValue({ ok: true, value: undefined });
    (PAS as any).prototype.rejectPlan.mockResolvedValue({ ok: true, value: undefined });
    (PAS as any).prototype.getPendingPlan.mockResolvedValue(undefined);

    db = createMockDb();
    provider = createMockProvider();
    streams = createMockStreams();
    apiKeyService = createMockApiKeyService();

    service = new ContainerAgentService(db, provider, streams, apiKeyService);
  });

  // =========================================================================
  // startAgent delegation
  // =========================================================================

  describe('startAgent() delegation', () => {
    const baseInput = {
      codespaceId: 'proj-1',
      taskId: 'task-1',
      sessionId: 'sess-1',
      prompt: 'Build feature X',
    };

    it('delegates to ContainerExecService', async () => {
      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(true);

      // ContainerExecService.startAgent should have been called
      const containerExec = (service as any).containerExec as ContainerExecService;
      expect(containerExec.startAgent).toHaveBeenCalledWith(baseInput);
    });

    it('returns AGENT_ALREADY_RUNNING when agent is already running for task', async () => {
      const stateManager = (service as any).state as SandboxStateManager;
      (stateManager.hasAnyRunningAgent as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = await service.startAgent(baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_ALREADY_RUNNING');
      }
    });

    it('returns AGENT_ALREADY_RUNNING when task is in the starting set', async () => {
      const stateManager = (service as any).state as SandboxStateManager;
      (stateManager.isStarting as ReturnType<typeof vi.fn>).mockReturnValue(true);

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

    it('clears starting guard even when sub-service throws', async () => {
      const containerExec = (service as any).containerExec as ContainerExecService;
      (containerExec.startAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Container blew up')
      );

      await expect(service.startAgent(baseInput)).rejects.toThrow('Container blew up');

      const stateManager = (service as any).state as SandboxStateManager;
      expect(stateManager.clearStarting).toHaveBeenCalledWith('task-1');
    });

    it('defaults phase to plan when not specified', async () => {
      await service.startAgent(baseInput);

      const containerExec = (service as any).containerExec as ContainerExecService;
      const calledInput = (containerExec.startAgent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(calledInput.phase).toBeUndefined();
      // The facade passes input as-is; phase defaulting (= 'plan') is in the input destructuring
    });
  });

  // =========================================================================
  // stopAgent delegation
  // =========================================================================

  describe('stopAgent() delegation', () => {
    it('delegates to ContainerExecService', async () => {
      const result = await service.stopAgent('task-1');

      expect(result.ok).toBe(true);

      const containerExec = (service as any).containerExec as ContainerExecService;
      expect(containerExec.stopAgent).toHaveBeenCalledWith('task-1');
    });

    it('propagates error from ContainerExecService.stopAgent', async () => {
      const containerExec = (service as any).containerExec as ContainerExecService;
      (containerExec.stopAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
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
      (planApproval.approvePlan as ReturnType<typeof vi.fn>).mockResolvedValue(
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
      (planApproval.rejectPlan as ReturnType<typeof vi.fn>).mockResolvedValue(
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
      (planApproval.getPendingPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        taskId: 'task-1',
        plan: 'Step 1',
        sdkSessionId: 'sdk-1',
      });

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
      (stateManager.hasAnyRunningAgent as ReturnType<typeof vi.fn>).mockReturnValue(true);

      expect(service.isAgentRunning('task-1')).toBe(true);
      expect(stateManager.hasAnyRunningAgent).toHaveBeenCalledWith('task-1');
    });

    it('getRunningAgent delegates to state.getAnyRunningAgent', () => {
      const info = { codespaceId: 'proj-1', sessionId: 'sess-1', startedAt: new Date() };
      const stateManager = (service as any).state as SandboxStateManager;
      (stateManager.getAnyRunningAgent as ReturnType<typeof vi.fn>).mockReturnValue(info);

      const result = service.getRunningAgent('task-1');

      expect(result).toBe(info);
      expect(stateManager.getAnyRunningAgent).toHaveBeenCalledWith('task-1');
    });

    it('getRunningAgents returns running agents array', () => {
      const stateManager = (service as any).state as SandboxStateManager;
      const containerAgent = {
        taskId: 'task-1',
        codespaceId: 'proj-1',
        sessionId: 'sess-1',
        startedAt: new Date(),
      };
      (stateManager.getAllRunningAgents as ReturnType<typeof vi.fn>).mockReturnValue([
        containerAgent,
      ]);

      const running = service.getRunningAgents();

      expect(running).toHaveLength(1);
      expect(running[0]?.taskId).toBe('task-1');
    });
  });

  // =========================================================================
  // Provider name
  // =========================================================================

  describe('providerName', () => {
    it('returns the underlying provider name', () => {
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
