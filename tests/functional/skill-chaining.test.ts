import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams, createMockWorktreeInit } from '../helpers/mocks';

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

describe('Skill chaining', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createInMemoryStreams() as unknown as DurableStreamsService;
    stateManager = new SandboxStateManager();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  it('approvePlan swaps task.skillId from planning skill to executionSkillId atomically', async () => {
    const codespace = await createTestProject({ name: 'Skill Chaining Success' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task with execution skill',
      skillId: 'planning-skill',
      skillName: 'Planning Skill',
      executionSkillId: 'execution-skill',
      executionSkillName: 'Execution Skill',
    });
    const { planService, startAgentFn } = createPlanService(db, streams, stateManager);

    await planService.handlePlanReady(task.id, 'session-skill-chain', codespace.id, {
      plan: 'Approved skill-chain plan',
      turnCount: 3,
      sdkSessionId: 'sdk-skill-chain',
    });

    const result = await planService.approvePlan(task.id);
    expect(result.ok).toBe(true);
    expect(startAgentFn).toHaveBeenCalledOnce();

    const startInput = startAgentFn.mock.calls[0]?.[0] as StartAgentInput | undefined;
    expect(startInput?.prompt).toContain('.claude/skills/execution-skill/SKILL.md');
    expect(startInput?.prompt).toContain('Approved skill-chain plan');

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter?.column).toBe('in_progress');
    expect(taskAfter?.skillId).toBe('execution-skill');
    expect(taskAfter?.skillName).toBe('Execution Skill');
    expect(stateManager.hasPendingPlan(task.id)).toBe(false);
  });

  it('approvePlan restores planning skill when execution start fails', async () => {
    const codespace = await createTestProject({ name: 'Skill Chaining Rollback' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task with rollback skill',
      skillId: 'planning-skill',
      skillName: 'Planning Skill',
      executionSkillId: 'execution-skill',
      executionSkillName: 'Execution Skill',
    });
    const startAgentFn = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'AGENT_START_FAILED', message: 'start failed', status: 500 },
    });
    const { planService } = createPlanService(db, streams, stateManager, startAgentFn);

    await planService.handlePlanReady(task.id, 'session-skill-rollback', codespace.id, {
      plan: 'Rollback skill-chain plan',
      turnCount: 3,
      sdkSessionId: 'sdk-skill-rollback',
    });

    const result = await planService.approvePlan(task.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_START_FAILED');
    }

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter?.column).toBe('waiting_approval');
    expect(taskAfter?.lastAgentStatus).toBe('planning');
    expect(taskAfter?.skillId).toBe('planning-skill');
    expect(taskAfter?.skillName).toBe('Planning Skill');
    expect(stateManager.hasPendingPlan(task.id)).toBe(true);
  });
});
