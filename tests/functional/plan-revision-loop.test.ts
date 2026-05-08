/**
 * Functional tests for plan revision loops.
 *
 * These tests keep the state transitions on real TaskService and
 * PlanApprovalService paths. The sandbox runner remains mocked because it is
 * the external execution boundary.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createLifecycleHarness, type LifecycleHarness } from '../helpers/lifecycle-harness';

describe('Plan revision loop', () => {
  let db: ReturnType<typeof getTestDb>;
  let harness: LifecycleHarness;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    harness = createLifecycleHarness({ db });
    await harness.enableSandboxDefaults();
  });

  afterEach(async () => {
    harness.teardown();
    await clearTestDatabase();
  });

  it('round-1 rejection feedback is included in the round-2 planning prompt', async () => {
    const codespace = await createTestProject({ name: 'Plan Revision Loop' });
    const task = await harness.createTask({
      codespaceId: codespace.id,
      title: 'Implement token refresh',
      description: 'Add refresh token rotation and tests.',
      skillId: 'auth-toolkit',
    });

    const taskId = task.id;
    await harness.moveTaskToInProgress(taskId);

    await harness.handlePlanReady(taskId, 'session-round-1', codespace.id, {
      plan: 'Round 1 plan',
      turnCount: 2,
      sdkSessionId: 'sdk-round-1',
    });

    const reject = await harness.rejectPlan(taskId, 'Include refresh token rotation coverage.');
    expect(reject.ok).toBe(true);

    harness.containerStartAgent.mockClear();
    await harness.moveTaskToInProgress(taskId);
    expect(harness.containerStartAgent).toHaveBeenCalledOnce();

    const planningInput = harness.containerStartAgent.mock.calls[0]?.[0] as
      | StartAgentInput
      | undefined;
    expect(planningInput?.prompt).toContain('Previous plan feedback:');
    expect(planningInput?.prompt).toContain('Include refresh token rotation coverage.');
    expect(planningInput?.prompt).toContain('Revise the next plan');

    await harness.handlePlanReady(taskId, 'session-round-2', codespace.id, {
      plan: 'Round 2 plan with refresh token rotation',
      turnCount: 4,
      sdkSessionId: 'sdk-round-2',
    });

    const approve = await harness.approvePlan(taskId);
    expect(approve.ok).toBe(true);
    expect(harness.executionStartAgent).toHaveBeenCalledOnce();

    const executionInput = harness.executionStartAgent.mock.calls[0]?.[0] as
      | StartAgentInput
      | undefined;
    expect(executionInput?.sdkSessionId).toBe('sdk-round-2');
    expect(executionInput?.prompt).toContain('Round 2 plan with refresh token rotation');

    const afterApprove = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(afterApprove?.column).toBe('in_progress');
    expect(afterApprove?.rejectionReason).toBe('Include refresh token rotation coverage.');
  });

  it('two parallel approvePlan calls start execution exactly once', async () => {
    const codespace = await createTestProject({ name: 'Double Click Revision' });
    const task = await harness.createTask({
      codespaceId: codespace.id,
      title: 'Approve once',
    });

    const taskId = task.id;
    await harness.moveTaskToInProgress(taskId);

    await harness.handlePlanReady(taskId, 'session-double-click', codespace.id, {
      plan: 'Plan approved once',
      turnCount: 3,
      sdkSessionId: 'sdk-double-click',
    });

    const [first, second] = await Promise.all([
      harness.approvePlan(taskId),
      harness.approvePlan(taskId),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    const failures = [first, second].filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(harness.executionStartAgent).toHaveBeenCalledOnce();
  });
});
