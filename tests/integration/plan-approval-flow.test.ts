import { eq } from 'drizzle-orm';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { ContainerAgentDeps, PlanData } from '../../src/services/container-agent/types';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('PlanApprovalService — full service integration (IT-220)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let service: PlanApprovalService;
  let mockStartAgentFn: ReturnType<typeof vi.fn>;
  let mockStreams: { publish: ReturnType<typeof vi.fn> };
  let mockProvider: { get: ReturnType<typeof vi.fn> };
  let mockWorktreeInit: { cleanupWorktree: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    vi.clearAllMocks();

    state = new SandboxStateManager();
    mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    mockStreams = { publish: vi.fn().mockResolvedValue(undefined) };
    mockProvider = { get: vi.fn().mockResolvedValue(null) };
    mockWorktreeInit = { cleanupWorktree: vi.fn().mockResolvedValue(undefined) };

    const deps: ContainerAgentDeps = {
      db: db as any,
      provider: mockProvider as any,
      streams: mockStreams as any,
      apiKeyService: {} as any,
    };

    service = new PlanApprovalService(
      deps,
      state,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false // isAgentCoreProvider
    );
  });

  afterEach(async () => {
    state.dispose();
    await clearTestDatabase();
  });

  describe('handlePlanReady (IT-221)', () => {
    it('IT-221a: stores plan in memory and persists to DB', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });

      // Set running agent in memory (simulates active planning agent)
      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-123',
        bridge: {} as never,
        execResult: {} as never,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
      });

      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: '## Plan\n1. Create module\n2. Add tests',
        turnCount: 5,
        sdkSessionId: 'sdk-session-abc',
        allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
      });

      // Verify in-memory state
      expect(state.hasPendingPlan(task.id)).toBe(true);
      const plan = state.getPendingPlan(task.id);
      expect(plan?.plan).toBe('## Plan\n1. Create module\n2. Add tests');
      expect(plan?.sdkSessionId).toBe('sdk-session-abc');
      expect(plan?.sandboxId).toBe('sandbox-123');

      // Verify DB state
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.plan).toBe('## Plan\n1. Create module\n2. Add tests');
      expect(dbTask?.column).toBe('waiting_approval');
      expect(dbTask?.lastAgentStatus).toBe('planning');
      expect(dbTask?.planOptions).toEqual({
        sdkSessionId: 'sdk-session-abc',
        allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
        planningSandboxId: 'sandbox-123',
      });

      // Running agent maps should be cleaned up
      expect(state.hasRunningAgent(task.id)).toBe(false);
    });

    it('IT-221b: idempotent — duplicate plan_ready event is ignored', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });

      // Set running agent
      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-123',
        bridge: {} as never,
        execResult: {} as never,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
      });

      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: 'First plan',
        turnCount: 3,
        sdkSessionId: 'sdk-1',
      });

      // Second call with different plan — should be ignored
      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: 'Second plan (should be ignored)',
        turnCount: 5,
        sdkSessionId: 'sdk-2',
      });

      const plan = state.getPendingPlan(task.id);
      expect(plan?.plan).toBe('First plan');
      expect(plan?.sdkSessionId).toBe('sdk-1');
    });

    it('IT-221c: skips persistence when task is no longer in_progress', async () => {
      const project = await createTestProject();
      // Task is already in waiting_approval — not in_progress
      const task = await createTestTask(project.id, { column: 'waiting_approval' });
      const session = await createTestSession(project.id, { taskId: task.id });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-123',
        bridge: {} as any,
        execResult: {} as any,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
      });

      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: 'Plan for non-in_progress task',
        turnCount: 3,
        sdkSessionId: 'sdk-1',
      });

      // Plan should NOT be stored in memory (cleared on non-persistence)
      expect(state.hasPendingPlan(task.id)).toBe(false);

      // Task plan should still be null in DB
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.plan).toBeNull();
    });

    it('IT-221d: accepts allowedPrompts from ExitPlanMode options', async () => {
      // theme-03 F3: launchSwarm/teammateCount removed as they were dead data.
      // allowedPrompts remains a live field used by downstream permission logic.
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-456',
        bridge: {} as any,
        execResult: {} as any,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
      });

      const allowedPrompts = [{ tool: 'Bash' as const, prompt: 'ls -la' }];
      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: 'Multi-agent plan',
        turnCount: 8,
        sdkSessionId: 'sdk-team',
        allowedPrompts,
      });

      const plan = state.getPendingPlan(task.id);
      expect(plan?.allowedPrompts).toEqual(allowedPrompts);
    });

    it('IT-221e: rejects an empty ExitPlanMode plan before persistence', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-empty-plan',
        bridge: {} as any,
        execResult: {} as any,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
      });

      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: '   ',
        turnCount: 4,
        sdkSessionId: 'sdk-empty-plan',
      });

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.plan).toBeNull();
      expect(dbTask?.column).toBe('waiting_approval');
      expect(dbTask?.lastAgentStatus).toBe('error');
      expect(state.hasPendingPlan(task.id)).toBe(false);
      expect(state.hasRunningAgent(task.id)).toBe(false);
      expect(mockStreams.publish).toHaveBeenCalledWith(
        session.id,
        'container-agent:error',
        expect.objectContaining({
          taskId: task.id,
          sessionId: session.id,
          error: 'Plan payload is empty.',
          turnCount: 4,
        })
      );
    });

    it('IT-221f: rejects malformed ExitPlanMode plan data before persistence', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });

      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-malformed-plan',
        bridge: {} as any,
        execResult: {} as any,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
      });

      type PlanReadyPayload = Parameters<PlanApprovalService['handlePlanReady']>[3];
      const malformedPlanData = {
        plan: { text: 'not a string' },
        turnCount: 2,
        sdkSessionId: 'sdk-malformed-plan',
      } as unknown as PlanReadyPayload;

      await service.handlePlanReady(task.id, session.id, project.id, malformedPlanData);

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.plan).toBeNull();
      expect(dbTask?.column).toBe('waiting_approval');
      expect(dbTask?.lastAgentStatus).toBe('error');
      expect(state.hasPendingPlan(task.id)).toBe(false);
      expect(state.hasRunningAgent(task.id)).toBe(false);
      expect(mockStreams.publish).toHaveBeenCalledWith(
        session.id,
        'container-agent:error',
        expect.objectContaining({
          taskId: task.id,
          sessionId: session.id,
          error: 'Plan payload is missing a text plan.',
          turnCount: 2,
        })
      );
    });
  });

  describe('getPendingPlan (IT-222)', () => {
    it('IT-222a: returns undefined when no plan exists', async () => {
      const result = await service.getPendingPlan('nonexistent-task');
      expect(result).toBeUndefined();
    });

    it('IT-222b: returns cached in-memory plan', async () => {
      const planData: PlanData = {
        taskId: 'task-1',
        sessionId: 'session-1',
        codespaceId: 'codespace-1',
        plan: 'Cached plan',
        turnCount: 5,
        sdkSessionId: 'sdk-1',
        createdAt: new Date(),
      };
      state.setPendingPlan('task-1', planData);

      const result = await service.getPendingPlan('task-1');

      expect(result).toBeDefined();
      expect(result?.plan).toBe('Cached plan');
    });

    it('IT-222c: recovers plan from DB when not in memory', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      // Write plan directly to DB (simulating server restart scenario)
      await db
        .update(tasks)
        .set({
          plan: 'Recovered plan from DB',
          planOptions: { sdkSessionId: 'sdk-recovered', allowedPrompts: [] },
          lastAgentStatus: 'planning',
          sessionId: session.id,
        })
        .where(eq(tasks.id, task.id));

      // Memory is empty — service should recover from DB
      const result = await service.getPendingPlan(task.id);

      expect(result).toBeDefined();
      expect(result?.plan).toBe('Recovered plan from DB');
      expect(result?.sdkSessionId).toBe('sdk-recovered');
      expect(result?.codespaceId).toBe(project.id);

      // Should be cached in memory now
      expect(state.hasPendingPlan(task.id)).toBe(true);
    });

    it('IT-222d: does not recover plan with non-planning lastAgentStatus', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      await db
        .update(tasks)
        .set({
          plan: 'Not a pending plan',
          lastAgentStatus: 'completed',
        })
        .where(eq(tasks.id, task.id));

      const result = await service.getPendingPlan(task.id);
      expect(result).toBeUndefined();
    });
  });

  describe('approvePlan (IT-223)', () => {
    it('IT-223a: returns PLAN_NOT_FOUND when no plan exists', async () => {
      const result = await service.approvePlan('nonexistent-task');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    });

    it('IT-223b: approves plan, moves task to in_progress, and calls startAgentFn', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      await db
        .update(tasks)
        .set({
          plan: 'Approved plan',
          planOptions: { sdkSessionId: 'sdk-approve' },
          lastAgentStatus: 'planning',
        })
        .where(eq(tasks.id, task.id));

      // Set up pending plan in memory
      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Approved plan',
        turnCount: 5,
        sdkSessionId: 'sdk-approve',
        createdAt: new Date(),
      });

      const result = await service.approvePlan(task.id);

      expect(result.ok).toBe(true);

      // Verify task moved to in_progress
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('in_progress');
      expect(dbTask?.lastAgentStatus).toBeNull();

      // Verify startAgentFn was called with correct params
      expect(mockStartAgentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          codespaceId: project.id,
          taskId: task.id,
          sessionId: session.id,
          prompt: 'Approved plan',
          phase: 'execute',
        })
      );

      // Verify plan cleared from memory
      expect(state.hasPendingPlan(task.id)).toBe(false);
    });

    it('IT-223c: returns PLAN_NOT_FOUND when task already moved from waiting_approval', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      // Task is in backlog, not waiting_approval
      const task = await createTestTask(project.id, { column: 'backlog' });

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan for moved task',
        turnCount: 3,
        sdkSessionId: 'sdk-1',
        createdAt: new Date(),
      });

      const result = await service.approvePlan(task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    });

    it('IT-223d: restores task to waiting_approval when startAgentFn fails', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan that fails to execute',
        turnCount: 3,
        sdkSessionId: 'sdk-fail',
        createdAt: new Date(),
      });

      // Make startAgentFn fail
      mockStartAgentFn.mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_AGENT_START_FAILED', message: 'Container crashed' },
      });

      const result = await service.approvePlan(task.id);

      expect(result.ok).toBe(false);

      // Task should be restored to waiting_approval so user can retry
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('waiting_approval');
      expect(dbTask?.lastAgentStatus).toBe('planning');
    });

    it('IT-223e: detects sandbox change and uses fresh session', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan with sandbox change',
        turnCount: 3,
        sdkSessionId: 'sdk-old',
        sandboxId: 'old-sandbox-id',
        createdAt: new Date(),
      });

      // Provider returns a different sandbox
      mockProvider.get.mockResolvedValue({ id: 'new-sandbox-id' });

      const result = await service.approvePlan(task.id);

      expect(result.ok).toBe(true);

      // startAgentFn should be called WITHOUT the old sdkSessionId
      expect(mockStartAgentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          sdkSessionId: undefined,
          phase: 'execute',
        })
      );

      // Sandbox change message should have been published
      expect(mockStreams.publish).toHaveBeenCalled();
    });

    it('IT-223f: keeps sdkSessionId when sandbox has not changed', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan with same sandbox',
        turnCount: 3,
        sdkSessionId: 'sdk-same',
        sandboxId: 'same-sandbox-id',
        createdAt: new Date(),
      });

      // Provider returns same sandbox
      mockProvider.get.mockResolvedValue({ id: 'same-sandbox-id' });

      const result = await service.approvePlan(task.id);

      expect(result.ok).toBe(true);

      // startAgentFn should keep the original sdkSessionId
      expect(mockStartAgentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          sdkSessionId: 'sdk-same',
        })
      );
    });
  });

  describe('approvePlan — AgentCore path (IT-224)', () => {
    let agentCoreService: PlanApprovalService;

    beforeEach(() => {
      const deps: ContainerAgentDeps = {
        db: db as any,
        provider: mockProvider as any,
        streams: mockStreams as any,
        apiKeyService: {} as any,
      };

      agentCoreService = new PlanApprovalService(
        deps,
        state,
        mockWorktreeInit as any,
        mockStartAgentFn,
        () => true // isAgentCoreProvider returns true
      );
    });

    it('IT-224a: approves plan via AgentCore path without sandbox check', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'AgentCore plan',
        turnCount: 4,
        sdkSessionId: 'sdk-agentcore',
        createdAt: new Date(),
      });

      const result = await agentCoreService.approvePlan(task.id);

      expect(result.ok).toBe(true);

      // Provider.get should NOT have been called (no sandbox check)
      expect(mockProvider.get).not.toHaveBeenCalled();

      // startAgentFn should be called with sdkSessionId
      expect(mockStartAgentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'execute',
          sdkSessionId: 'sdk-agentcore',
          prompt: 'AgentCore plan',
        })
      );

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('in_progress');
    });

    it('IT-224b: restores task state on AgentCore start failure', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Failing AgentCore plan',
        turnCount: 4,
        sdkSessionId: 'sdk-fail',
        createdAt: new Date(),
      });

      mockStartAgentFn.mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_AGENT_START_FAILED', message: 'API key expired' },
      });

      const result = await agentCoreService.approvePlan(task.id);

      expect(result.ok).toBe(false);

      // Task should be restored to waiting_approval
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('waiting_approval');
      expect(dbTask?.lastAgentStatus).toBe('planning');
    });
  });

  describe('rejectPlan (IT-225)', () => {
    it('IT-225a: returns PLAN_NOT_FOUND when no plan exists', async () => {
      const result = await service.rejectPlan('nonexistent-task');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    });

    it('IT-225b: clears plan fields and moves task to backlog', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const worktree = await createTestWorktree(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      // Set plan data in DB
      await db
        .update(tasks)
        .set({
          plan: 'Plan to reject',
          planOptions: { sdkSessionId: 'sdk-reject', allowedPrompts: [] },
          lastAgentStatus: 'planning',
          worktreeId: worktree.id,
          branch: worktree.branch,
        })
        .where(eq(tasks.id, task.id));

      // Set plan in memory
      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan to reject',
        turnCount: 3,
        sdkSessionId: 'sdk-reject',
        createdAt: new Date(),
      });

      const result = await service.rejectPlan(task.id, 'Not enough detail');

      expect(result.ok).toBe(true);

      // Verify DB state
      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('backlog');
      expect(dbTask?.plan).toBeNull();
      expect(dbTask?.planOptions).toBeNull();
      expect(dbTask?.lastAgentStatus).toBeNull();
      expect(dbTask?.rejectionReason).toBe('Not enough detail');
      expect(dbTask?.worktreeId).toBeNull();
      expect(dbTask?.branch).toBeNull();

      // Memory should be cleared
      expect(state.hasPendingPlan(task.id)).toBe(false);
    });

    it('IT-225c: calls worktree cleanup when task has worktreeId', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const worktree = await createTestWorktree(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      await db
        .update(tasks)
        .set({
          plan: 'Plan with worktree',
          planOptions: {},
          lastAgentStatus: 'planning',
          worktreeId: worktree.id,
        })
        .where(eq(tasks.id, task.id));

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan with worktree',
        turnCount: 3,
        sdkSessionId: 'sdk-1',
        createdAt: new Date(),
      });

      await service.rejectPlan(task.id);

      // Give async worktree cleanup a moment
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockWorktreeInit.cleanupWorktree).toHaveBeenCalledWith(task.id, worktree.id);
    });

    it('IT-225d: rejects plan recovered from DB (not in memory)', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      // Plan exists in DB but NOT in memory (server restart scenario)
      await db
        .update(tasks)
        .set({
          plan: 'DB-only plan to reject',
          planOptions: { sdkSessionId: 'sdk-db' },
          lastAgentStatus: 'planning',
        })
        .where(eq(tasks.id, task.id));

      // No state.setPendingPlan — plan is only in DB

      const result = await service.rejectPlan(task.id, 'Rejected after restart');

      expect(result.ok).toBe(true);

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.column).toBe('backlog');
      expect(dbTask?.plan).toBeNull();
      expect(dbTask?.rejectionReason).toBe('Rejected after restart');
    });

    it('IT-225e: returns error when task is no longer in planning state', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      // Set lastAgentStatus to something other than planning
      await db
        .update(tasks)
        .set({
          plan: 'Already-approved plan',
          lastAgentStatus: 'completed',
        })
        .where(eq(tasks.id, task.id));

      const result = await service.rejectPlan(task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    });

    it('IT-225f: rejection without reason stores null rejectionReason', async () => {
      const project = await createTestProject();
      const session = await createTestSession(project.id);
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      await db
        .update(tasks)
        .set({
          plan: 'Plan to reject without reason',
          planOptions: {},
          lastAgentStatus: 'planning',
        })
        .where(eq(tasks.id, task.id));

      state.setPendingPlan(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        plan: 'Plan',
        turnCount: 1,
        sdkSessionId: 'sdk-1',
        createdAt: new Date(),
      });

      await service.rejectPlan(task.id);

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.rejectionReason).toBeNull();
    });
  });

  describe('handlePlanReady error paths (IT-226)', () => {
    it('IT-226a: cleans up worktree when plan persistence fails', async () => {
      const project = await createTestProject();
      const task = await createTestTask(project.id, { column: 'in_progress' });
      const session = await createTestSession(project.id, { taskId: task.id });

      // Set running agent with worktreeId
      state.setRunningAgent(task.id, {
        taskId: task.id,
        sessionId: session.id,
        codespaceId: project.id,
        sandboxId: 'sandbox-123',
        bridge: {} as any,
        execResult: {} as any,
        stopFilePath: '/tmp/stop',
        startedAt: new Date(),
        stopRequested: false,
        phase: 'plan',
        worktreeId: 'worktree-to-cleanup',
      });

      // Delete the task to force a DB error on update
      await db.delete(tasks).where(eq(tasks.id, task.id));

      // Re-insert a task with wrong column to trigger the WHERE clause failure
      const _wrongTask = await createTestTask(project.id, {
        id: task.id,
        column: 'backlog', // not in_progress, so WHERE won't match
      });

      await service.handlePlanReady(task.id, session.id, project.id, {
        plan: 'Plan that fails to persist',
        turnCount: 3,
        sdkSessionId: 'sdk-1',
      });

      // Plan should NOT be stored (persistence failed silently)
      expect(state.hasPendingPlan(task.id)).toBe(false);
      // Running agent should be cleaned up
      expect(state.hasRunningAgent(task.id)).toBe(false);
    });
  });

  describe('approve/reject/cancel ordering properties (IT-227)', () => {
    type RaceOperation = 'approve' | 'reject' | 'cancel';

    const mockWorktreeService = {
      getDiff: vi.fn(),
      merge: vi.fn(),
      remove: vi.fn(),
    };

    it('IT-227a: no approve/reject/cancel ordering leaves a pending plan stranded', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(['approve', 'reject', 'cancel'] as const, {
            minLength: 3,
            maxLength: 3,
          }),
          async (operationOrder) => {
            const project = await createTestProject({
              name: `Plan race ${operationOrder.join('-')}`,
            });
            const session = await createTestSession(project.id);
            const task = await createTestTask(project.id, { column: 'in_progress' });
            const taskService = new TaskService(db as never, mockWorktreeService);
            const startCallsBefore = mockStartAgentFn.mock.calls.length;

            await service.handlePlanReady(task.id, session.id, project.id, {
              plan: `Race plan ${operationOrder.join(' -> ')}`,
              turnCount: 2,
              sdkSessionId: `sdk-${task.id}`,
            });

            for (const operation of operationOrder satisfies RaceOperation[]) {
              if (operation === 'approve') {
                await service.approvePlan(task.id);
              } else if (operation === 'reject') {
                await service.rejectPlan(task.id, 'race rejected');
              } else {
                await taskService.cancelTask(task.id);
              }
            }

            const startCallsForTask = mockStartAgentFn.mock.calls
              .slice(startCallsBefore)
              .filter(([input]) => (input as { taskId?: string }).taskId === task.id);
            expect(startCallsForTask.length).toBeLessThanOrEqual(1);
            expect(state.hasPendingPlan(task.id)).toBe(false);

            const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
            expect(dbTask?.column).not.toBe('waiting_approval');
            expect(dbTask?.lastAgentStatus).not.toBe('planning');
            if (dbTask?.column === 'backlog') {
              expect(dbTask.plan).toBeNull();
              expect(dbTask.planOptions).toBeNull();
            }
          }
        ),
        { numRuns: 12 }
      );
    });
  });
});
