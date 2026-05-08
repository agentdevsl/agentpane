/**
 * Functional tests for plan revision loops.
 *
 * These tests keep the state transitions on real TaskService and
 * PlanApprovalService paths. The sandbox runner remains mocked because it is
 * the external execution boundary.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { enableSandboxDefaults } from '../factories/settings.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createInMemoryStreams,
  createMockContainerAgent,
  createMockWorktreeInit,
  createMockWorktreeService,
} from '../helpers/mocks';

function createPlanService(
  db: ReturnType<typeof getTestDb>,
  streams: DurableStreamsService,
  stateManager: SandboxStateManager,
  startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined })
): { planService: PlanApprovalService; startAgentFn: typeof startAgentFn } {
  return {
    planService: new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      createMockWorktreeInit() as any,
      startAgentFn,
      () => false
    ),
    startAgentFn,
  };
}

describe('Plan revision loop', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let stateManager: SandboxStateManager;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createInMemoryStreams() as unknown as DurableStreamsService;
    stateManager = new SandboxStateManager();
    taskService = new TaskService(db, createMockWorktreeService());
    await enableSandboxDefaults();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  it('round-1 rejection feedback is included in the round-2 planning prompt', async () => {
    const codespace = await createTestProject({ name: 'Plan Revision Loop' });
    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Implement token refresh',
      description: 'Add refresh token rotation and tests.',
      skillId: 'auth-toolkit',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const startAgent = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    taskService.setContainerAgentService(
      createMockContainerAgent({
        startAgent,
        isAgentRunning: vi.fn().mockReturnValue(false),
      })
    );
    const { planService, startAgentFn } = createPlanService(db, streams, stateManager);

    const taskId = createResult.value.id;
    const round1Move = await taskService.moveColumn(taskId, 'in_progress');
    expect(round1Move.ok).toBe(true);

    await planService.handlePlanReady(taskId, 'session-round-1', codespace.id, {
      plan: 'Round 1 plan',
      turnCount: 2,
      sdkSessionId: 'sdk-round-1',
    });

    const reject = await planService.rejectPlan(taskId, 'Include refresh token rotation coverage.');
    expect(reject.ok).toBe(true);

    startAgent.mockClear();
    const round2Move = await taskService.moveColumn(taskId, 'in_progress');
    expect(round2Move.ok).toBe(true);
    expect(startAgent).toHaveBeenCalledOnce();

    const planningInput = startAgent.mock.calls[0]?.[0] as StartAgentInput | undefined;
    expect(planningInput?.prompt).toContain('Previous plan feedback:');
    expect(planningInput?.prompt).toContain('Include refresh token rotation coverage.');
    expect(planningInput?.prompt).toContain('Revise the next plan');

    await planService.handlePlanReady(taskId, 'session-round-2', codespace.id, {
      plan: 'Round 2 plan with refresh token rotation',
      turnCount: 4,
      sdkSessionId: 'sdk-round-2',
    });

    const approve = await planService.approvePlan(taskId);
    expect(approve.ok).toBe(true);
    expect(startAgentFn).toHaveBeenCalledOnce();

    const executionInput = startAgentFn.mock.calls[0]?.[0] as StartAgentInput | undefined;
    expect(executionInput?.sdkSessionId).toBe('sdk-round-2');
    expect(executionInput?.prompt).toContain('Round 2 plan with refresh token rotation');

    const afterApprove = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterApprove?.column).toBe('in_progress');
    expect(afterApprove?.rejectionReason).toBe('Include refresh token rotation coverage.');
  });

  it('two parallel approvePlan calls start execution exactly once', async () => {
    const codespace = await createTestProject({ name: 'Double Click Revision' });
    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Approve once',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    taskService.setContainerAgentService(createMockContainerAgent());
    const taskId = createResult.value.id;
    const move = await taskService.moveColumn(taskId, 'in_progress');
    expect(move.ok).toBe(true);

    const startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const { planService } = createPlanService(db, streams, stateManager, startAgentFn);
    await planService.handlePlanReady(taskId, 'session-double-click', codespace.id, {
      plan: 'Plan approved once',
      turnCount: 3,
      sdkSessionId: 'sdk-double-click',
    });

    const [first, second] = await Promise.all([
      planService.approvePlan(taskId),
      planService.approvePlan(taskId),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    const failures = [first, second].filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(startAgentFn).toHaveBeenCalledOnce();
  });
});
