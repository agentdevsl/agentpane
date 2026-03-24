/**
 * Functional E2E Test: Task Creation → Skill → Planning → Approval → Execution
 *
 * Every state transition uses REAL service code. Only external I/O is mocked:
 * - Claude Agent SDK (no real API calls)
 * - Sandbox providers (no Docker/K8s)
 * - Git operations (no real filesystem)
 * - DurableStreams (in-memory publish)
 *
 * Run separately: npx vitest run --project functional
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, tasks } from '../../src/db/schema';
import { createContainerBridge } from '../../src/lib/agents/container-bridge';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import {
  updateTaskOnAgentComplete,
  updateTaskOnAgentError,
} from '../../src/services/container-agent/shared-helpers';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------- helpers ----------

function jsonLinesToStream(events: Array<Record<string, unknown>>): Readable {
  const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  return Readable.from([lines]);
}

function createMockStreams(): DurableStreamsService {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    createStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as DurableStreamsService;
}

function createMockWorktreeService() {
  return {
    getDiff: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        files: [
          { path: 'src/feature.ts', additions: 42, deletions: 5, status: 'modified' },
          { path: 'src/feature.test.ts', additions: 28, deletions: 0, status: 'added' },
        ],
        stats: { filesChanged: 2, additions: 70, deletions: 5 },
      },
    }),
    merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

// ---------- test suite ----------

describe('Functional E2E: Real Service Transitions', () => {
  const CODESPACE_ID = 'func-codespace-1';
  const TASK_ID = 'func-task-1';
  const SESSION_ID = 'func-session-1';
  const AGENT_ID = 'func-agent-1';
  const WORKTREE_ID = 'func-worktree-1';

  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let mockWorktreeService: ReturnType<typeof createMockWorktreeService>;
  let taskService: TaskService;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createMockStreams();
    mockWorktreeService = createMockWorktreeService();
    taskService = new TaskService(db, mockWorktreeService);
    stateManager = new SandboxStateManager();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  it('full lifecycle: every transition through real service code', async () => {
    // ═══════════════════════════════════════════════════════════════════
    // Phase 1: TaskService.create() — task with skill in backlog
    // ═══════════════════════════════════════════════════════════════════

    const codespace = await createTestProject({
      id: CODESPACE_ID,
      name: 'E2E Project',
      path: '/tmp/e2e-project',
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        maxTurns: 50,
      },
    });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Implement user authentication',
      description: 'Add JWT-based authentication to the API layer',
      skillId: 'auth-toolkit',
      skillName: 'Authentication Toolkit',
      labels: ['feature', 'security'],
      priority: 'high',
    });
    expect(createResult.ok).toBe(true);
    const createdTask = createResult.ok ? createResult.value : null;
    expect(createdTask).toBeTruthy();
    expect(createdTask!.column).toBe('backlog');
    expect(createdTask!.skillId).toBe('auth-toolkit');
    expect(createdTask!.skillName).toBe('Authentication Toolkit');
    const taskId = createdTask!.id;

    // ═══════════════════════════════════════════════════════════════════
    // Phase 2: TaskService.moveColumn() — backlog → in_progress
    //          Triggers container agent with skill in prompt
    // ═══════════════════════════════════════════════════════════════════

    let capturedStartInput: Record<string, unknown> | null = null;
    const mockContainerAgent = {
      providerName: 'docker',
      startAgent: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
        capturedStartInput = input;
        return { ok: true, value: undefined };
      }),
      stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn(),
      rejectPlan: vi.fn(),
    };
    taskService.setContainerAgentService(mockContainerAgent);

    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true, mode: 'shared' }),
    });

    const moveResult = await taskService.moveColumn(taskId, 'in_progress');
    expect(moveResult.ok).toBe(true);
    const movedTask = moveResult.ok ? moveResult.value.task : null;
    expect(movedTask!.column).toBe('in_progress');
    expect(movedTask!.startedAt).toBeTruthy();
    expect(movedTask!.sessionId).toBeTruthy();

    // Verify the real agent prompt includes skill, title, labels, priority
    expect(mockContainerAgent.startAgent).toHaveBeenCalledOnce();
    const prompt = capturedStartInput!.prompt as string;
    expect(prompt).toContain('use skill auth-toolkit');
    expect(prompt).toContain('Implement user authentication');
    expect(prompt).toContain('Labels: feature, security');
    expect(prompt).toContain('Priority: high');

    // ═══════════════════════════════════════════════════════════════════
    // Phase 3: Container bridge routes plan_ready event →
    //          REAL PlanApprovalService.handlePlanReady() stores plan
    //          and moves task to waiting_approval
    // ═══════════════════════════════════════════════════════════════════

    const worktree = await createTestWorktree(codespace.id, {
      id: WORKTREE_ID,
      taskId: taskId,
      branch: 'agent/implement-user-auth',
      status: 'active',
    });

    // Wire up a real PlanApprovalService
    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const planApprovalService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false // not AgentCore
    );

    // Process the plan_ready event through the real container bridge.
    // Note: The bridge calls onPlanReady synchronously (no await), so we capture
    // the returned promise to await it after processStream completes.
    let planReadyPromise: Promise<void> | undefined;
    const onPlanReady = vi.fn().mockImplementation(async (planData: Record<string, unknown>) => {
      // This is what the container-agent service does when it receives plan_ready:
      // delegates to PlanApprovalService.handlePlanReady()
      await planApprovalService.handlePlanReady(
        taskId,
        movedTask!.sessionId!,
        codespace.id,
        planData as any
      );
    });
    // Wrap to capture the promise
    const onPlanReadyWrapper = (data: Record<string, unknown>) => {
      planReadyPromise = onPlanReady(data);
    };

    const bridge = createContainerBridge({
      taskId: taskId,
      sessionId: movedTask!.sessionId!,
      codespaceId: CODESPACE_ID,
      streams,
      onComplete: vi.fn(),
      onError: vi.fn(),
      onPlanReady: onPlanReadyWrapper,
    });

    await bridge.processStream(
      jsonLinesToStream([
        {
          type: 'agent:plan_ready',
          timestamp: Date.now(),
          taskId: taskId,
          sessionId: movedTask!.sessionId!,
          data: {
            plan: '## Plan\n\n1. Create JWT middleware\n2. Add login/register endpoints\n3. Write tests',
            turnCount: 5,
            sdkSessionId: 'sdk-session-auth-plan',
            allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
          },
        },
      ])
    );

    // Await the async handlePlanReady callback (bridge does not await it)
    await planReadyPromise;

    // Verify handlePlanReady was called via the bridge
    expect(onPlanReady).toHaveBeenCalledOnce();

    // Verify REAL PlanApprovalService wrote to DB
    const plannedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(plannedTask!.column).toBe('waiting_approval');
    expect(plannedTask!.plan).toContain('Create JWT middleware');
    expect(plannedTask!.lastAgentStatus).toBe('planning');
    expect(plannedTask!.skillId).toBe('auth-toolkit'); // skill preserved

    const planOptions = plannedTask!.planOptions as { sdkSessionId?: string } | null;
    expect(planOptions?.sdkSessionId).toBe('sdk-session-auth-plan');

    // Verify REAL SandboxStateManager has the pending plan
    expect(stateManager.hasPendingPlan(taskId)).toBe(true);
    const pendingPlan = stateManager.getPendingPlan(taskId);
    expect(pendingPlan!.plan).toContain('Create JWT middleware');
    expect(pendingPlan!.sdkSessionId).toBe('sdk-session-auth-plan');

    // ═══════════════════════════════════════════════════════════════════
    // Phase 4: REAL PlanApprovalService.approvePlan() →
    //          moves task to in_progress, calls startAgent with
    //          phase: 'execute' and plan as prompt
    // ═══════════════════════════════════════════════════════════════════

    const approveResult = await planApprovalService.approvePlan(taskId);
    expect(approveResult.ok).toBe(true);

    // Verify startAgentFn was called with execution parameters
    expect(mockStartAgentFn).toHaveBeenCalledOnce();
    const executionInput = mockStartAgentFn.mock.calls[0][0];
    expect(executionInput.phase).toBe('execute');
    expect(executionInput.prompt).toContain('Create JWT middleware');
    expect(executionInput.sdkSessionId).toBe('sdk-session-auth-plan');
    expect(executionInput.codespaceId).toBe(CODESPACE_ID);
    expect(executionInput.taskId).toBe(taskId);

    // Verify task moved to in_progress for execution
    const executingTask = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(executingTask!.column).toBe('in_progress');
    expect(executingTask!.plan).toContain('Create JWT middleware'); // plan text preserved

    // Verify pending plan was cleaned up from memory
    expect(stateManager.hasPendingPlan(taskId)).toBe(false);

    // ═══════════════════════════════════════════════════════════════════
    // Phase 5: REAL updateTaskOnAgentComplete() →
    //          moves task to waiting_approval with 'completed' status
    // ═══════════════════════════════════════════════════════════════════

    const completionOk = await updateTaskOnAgentComplete(
      db,
      taskId,
      'completed',
      streams,
      movedTask!.sessionId!
    );
    expect(completionOk).toBe(true);

    const completedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(completedTask!.column).toBe('waiting_approval');
    expect(completedTask!.lastAgentStatus).toBe('completed');
    expect(completedTask!.completedAt).toBeTruthy();
    expect(completedTask!.agentId).toBeNull();
    expect(completedTask!.sessionId).toBeNull();
    expect(completedTask!.skillId).toBe('auth-toolkit');
    expect(completedTask!.plan).toContain('Create JWT middleware'); // plan still there

    // ═══════════════════════════════════════════════════════════════════
    // Phase 6: REAL TaskService.approve() →
    //          getDiff → merge → move to verified → remove worktree
    // ═══════════════════════════════════════════════════════════════════

    // Re-link worktree (cleared by updateTaskOnAgentComplete)
    await db
      .update(tasks)
      .set({ worktreeId: WORKTREE_ID, branch: worktree.branch })
      .where(eq(tasks.id, taskId));

    const finalApprove = await taskService.approve(taskId, {
      approvedBy: 'test-user',
      createMergeCommit: true,
    });
    expect(finalApprove.ok).toBe(true);

    if (finalApprove.ok) {
      const verified = finalApprove.value;
      expect(verified.column).toBe('verified');
      expect(verified.approvedAt).toBeTruthy();
      expect(verified.approvedBy).toBe('test-user');
      expect(verified.completedAt).toBeTruthy();
      expect(verified.diffSummary).toEqual({ filesChanged: 2, additions: 70, deletions: 5 });
      expect(verified.skillId).toBe('auth-toolkit');
      expect(verified.skillName).toBe('Authentication Toolkit');
    }

    expect(mockWorktreeService.getDiff).toHaveBeenCalledWith(WORKTREE_ID);
    expect(mockWorktreeService.merge).toHaveBeenCalledWith(WORKTREE_ID);
    expect(mockWorktreeService.remove).toHaveBeenCalledWith(WORKTREE_ID);
  });

  it('plan rejection through real PlanApprovalService cleans up all state', async () => {
    const codespace = await createTestProject({ id: CODESPACE_ID });
    await createTestWorktree(codespace.id, { id: WORKTREE_ID, status: 'active' });

    await createTestTask(codespace.id, {
      id: TASK_ID,
      column: 'in_progress',
      skillId: 'auth-toolkit',
    });

    // Wire up real PlanApprovalService
    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };

    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      vi.fn().mockResolvedValue({ ok: true }),
      () => false
    );

    // Store plan via real handlePlanReady
    await planService.handlePlanReady(TASK_ID, SESSION_ID, CODESPACE_ID, {
      plan: 'Bad plan that needs rejection',
      turnCount: 3,
      sdkSessionId: 'sdk-reject',
    });

    // Verify plan was stored
    const planned = await db.query.tasks.findFirst({ where: eq(tasks.id, TASK_ID) });
    expect(planned!.column).toBe('waiting_approval');
    expect(planned!.plan).toBe('Bad plan that needs rejection');
    expect(stateManager.hasPendingPlan(TASK_ID)).toBe(true);

    // Reject via real rejectPlan
    const rejectResult = await planService.rejectPlan(TASK_ID, 'Does not address security');
    expect(rejectResult.ok).toBe(true);

    // Verify all state cleaned up
    const rejected = await db.query.tasks.findFirst({ where: eq(tasks.id, TASK_ID) });
    expect(rejected!.column).toBe('backlog');
    expect(rejected!.plan).toBeNull();
    expect(rejected!.planOptions).toBeNull();
    expect(rejected!.lastAgentStatus).toBeNull();
    expect(rejected!.worktreeId).toBeNull();
    expect(rejected!.branch).toBeNull();
    expect(rejected!.rejectionReason).toBe('Does not address security');
    expect(rejected!.skillId).toBe('auth-toolkit'); // skill preserved

    // Verify memory state cleaned up
    expect(stateManager.hasPendingPlan(TASK_ID)).toBe(false);
  });

  it('agent error through real shared-helpers cleans up correctly', async () => {
    const codespace = await createTestProject({ id: CODESPACE_ID });
    await createTestAgent(codespace.id, { id: AGENT_ID, status: 'running' });
    await createTestTask(codespace.id, {
      id: TASK_ID,
      column: 'in_progress',
      skillId: 'auth-toolkit',
      agentId: AGENT_ID,
    });

    // Real shared helper
    const ok = await updateTaskOnAgentError(db, TASK_ID, streams, SESSION_ID);
    expect(ok).toBe(true);

    const errorTask = await db.query.tasks.findFirst({ where: eq(tasks.id, TASK_ID) });
    expect(errorTask!.lastAgentStatus).toBe('error');
    expect(errorTask!.agentId).toBeNull();
    expect(errorTask!.sessionId).toBeNull();
    expect(errorTask!.skillId).toBe('auth-toolkit');
  });

  it('multi-round: reject → re-plan → approve → execute → verify (real services)', async () => {
    const codespace = await createTestProject({ id: CODESPACE_ID });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Fix auth bug',
      skillId: 'debug-toolkit',
      skillName: 'Debug Toolkit',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Wire real PlanApprovalService
    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false
    );

    // ── Round 1: Move → Plan → Reject ──

    const move1 = await taskService.moveColumn(taskId, 'in_progress');
    expect(move1.ok).toBe(true);

    await planService.handlePlanReady(taskId, 'session-r1', codespace.id, {
      plan: 'Round 1: narrow fix',
      turnCount: 2,
      sdkSessionId: 'sdk-r1',
    });

    const afterPlan1 = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterPlan1!.column).toBe('waiting_approval');

    const reject1 = await planService.rejectPlan(taskId, 'Too narrow');
    expect(reject1.ok).toBe(true);

    const afterReject = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterReject!.column).toBe('backlog');
    expect(afterReject!.plan).toBeNull();

    // ── Round 2: Move → Plan → Approve → Execute → Complete ──

    const move2 = await taskService.moveColumn(taskId, 'in_progress');
    expect(move2.ok).toBe(true);

    await planService.handlePlanReady(taskId, 'session-r2', codespace.id, {
      plan: 'Round 2: comprehensive fix with refresh token',
      turnCount: 4,
      sdkSessionId: 'sdk-r2',
    });

    const afterPlan2 = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterPlan2!.column).toBe('waiting_approval');
    expect(afterPlan2!.plan).toContain('comprehensive fix');

    // Approve via real service
    mockStartAgentFn.mockClear();
    const approve2 = await planService.approvePlan(taskId);
    expect(approve2.ok).toBe(true);
    expect(mockStartAgentFn).toHaveBeenCalledOnce();
    expect(mockStartAgentFn.mock.calls[0][0].phase).toBe('execute');
    expect(mockStartAgentFn.mock.calls[0][0].prompt).toContain('comprehensive fix');

    // Agent completes
    await updateTaskOnAgentComplete(db, taskId, 'completed');

    const afterExec = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterExec!.column).toBe('waiting_approval');
    expect(afterExec!.lastAgentStatus).toBe('completed');

    // Final approval
    const wt = await createTestWorktree(codespace.id, { taskId, status: 'active' });
    await db
      .update(tasks)
      .set({ worktreeId: wt.id, branch: wt.branch })
      .where(eq(tasks.id, taskId));

    const finalApprove = await taskService.approve(taskId, { approvedBy: 'lead-dev' });
    expect(finalApprove.ok).toBe(true);
    if (finalApprove.ok) {
      expect(finalApprove.value.column).toBe('verified');
      expect(finalApprove.value.skillId).toBe('debug-toolkit');
      // rejectionReason preserved from round 1 rejection
      expect(finalApprove.value.rejectionReason).toBe('Too narrow');
    }
  });

  it('turn limit through real shared-helpers preserves plan context', async () => {
    const codespace = await createTestProject({ id: CODESPACE_ID });
    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Large refactor',
      skillId: 'refactor-toolkit',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const move = await taskService.moveColumn(taskId, 'in_progress');
    expect(move.ok).toBe(true);

    // Store plan via DB (simulating handlePlanReady → approve → executing)
    await db
      .update(tasks)
      .set({ plan: 'Refactoring plan text', planOptions: { sdkSessionId: 'sdk-turns' } })
      .where(eq(tasks.id, taskId));

    // Real turn limit handler
    const ok = await updateTaskOnAgentComplete(db, taskId, 'turn_limit', streams, SESSION_ID);
    expect(ok).toBe(true);

    const paused = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(paused!.column).toBe('waiting_approval');
    expect(paused!.lastAgentStatus).toBe('turn_limit');
    expect(paused!.skillId).toBe('refactor-toolkit');
    expect(paused!.plan).toBe('Refactoring plan text');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BUG DETECTION: Prevent skipping execution by approving during planning
  // ═══════════════════════════════════════════════════════════════════════

  it('FIXED: approve() rejects task with lastAgentStatus=planning (prevents skipping execution)', async () => {
    const codespace = await createTestProject({ id: CODESPACE_ID });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Feature X',
    });
    const taskId = createResult.ok ? createResult.value.id : '';

    await taskService.moveColumn(taskId, 'in_progress');

    const worktree = await createTestWorktree(codespace.id, { taskId, status: 'active' });

    const mockWorktreeInit = {
      cleanupWorktree: vi.fn(),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      vi.fn().mockResolvedValue({ ok: true }),
      () => false
    );

    await planService.handlePlanReady(taskId, 'session-bug', codespace.id, {
      plan: 'Plan that should not be merged directly',
      turnCount: 3,
      sdkSessionId: 'sdk-bug',
    });

    const planned = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(planned!.column).toBe('waiting_approval');
    expect(planned!.lastAgentStatus).toBe('planning');

    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, taskId));

    // approve() must block — task is pending plan approval, not execution completion
    const approveResult = await taskService.approve(taskId, { approvedBy: 'user' });
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('TASK_PLAN_NOT_EXECUTED');
    }

    // Task stays in waiting_approval
    const afterAttempt = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterAttempt!.column).toBe('waiting_approval');
  });

  it('FIXED: moveColumn to verified rejects when lastAgentStatus=planning (prevents Kanban bypass)', async () => {
    const codespace = await createTestProject({ id: CODESPACE_ID });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Feature Y',
    });
    const taskId = createResult.ok ? createResult.value.id : '';

    await taskService.moveColumn(taskId, 'in_progress');

    const mockWorktreeInit = {
      cleanupWorktree: vi.fn(),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      vi.fn().mockResolvedValue({ ok: true }),
      () => false
    );

    await planService.handlePlanReady(taskId, 'session-bug2', codespace.id, {
      plan: 'Plan text',
      turnCount: 2,
      sdkSessionId: 'sdk-bug2',
    });

    const planned = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(planned!.column).toBe('waiting_approval');
    expect(planned!.lastAgentStatus).toBe('planning');

    // moveColumn to verified must be blocked — plan not executed yet
    const moveResult = await taskService.moveColumn(taskId, 'verified');
    expect(moveResult.ok).toBe(false);
    if (!moveResult.ok) {
      expect(moveResult.error.code).toBe('TASK_PLAN_NOT_EXECUTED');
    }

    // Task stays in waiting_approval
    const afterAttempt = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterAttempt!.column).toBe('waiting_approval');
  });
});
