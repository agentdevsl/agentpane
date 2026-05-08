import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createLifecycleHarness, type LifecycleHarness } from '../helpers/lifecycle-harness';

describe('Skill chaining', () => {
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

  it('approvePlan swaps task.skillId from planning skill to executionSkillId atomically', async () => {
    const codespace = await createTestProject({ name: 'Skill Chaining Success' });
    const task = await harness.createTask({
      codespaceId: codespace.id,
      title: 'Task with execution skill',
      skillId: 'planning-skill',
      skillName: 'Planning Skill',
      executionSkillId: 'execution-skill',
      executionSkillName: 'Execution Skill',
    });
    await harness.moveTaskToInProgress(task.id);

    await harness.handlePlanReady(task.id, 'session-skill-chain', codespace.id, {
      plan: 'Approved skill-chain plan',
      turnCount: 3,
      sdkSessionId: 'sdk-skill-chain',
    });

    const result = await harness.approvePlan(task.id);
    expect(result.ok).toBe(true);
    expect(harness.executionStartAgent).toHaveBeenCalledOnce();

    const startInput = harness.executionStartAgent.mock.calls[0]?.[0] as
      | StartAgentInput
      | undefined;
    expect(startInput?.prompt).toContain('.claude/skills/execution-skill/SKILL.md');
    expect(startInput?.prompt).toContain('Approved skill-chain plan');

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter?.column).toBe('in_progress');
    expect(taskAfter?.skillId).toBe('execution-skill');
    expect(taskAfter?.skillName).toBe('Execution Skill');
    expect(harness.stateManager.hasPendingPlan(task.id)).toBe(false);
  });

  it('approvePlan restores planning skill when execution start fails', async () => {
    const codespace = await createTestProject({ name: 'Skill Chaining Rollback' });
    const task = await harness.createTask({
      codespaceId: codespace.id,
      title: 'Task with rollback skill',
      skillId: 'planning-skill',
      skillName: 'Planning Skill',
      executionSkillId: 'execution-skill',
      executionSkillName: 'Execution Skill',
    });
    await harness.moveTaskToInProgress(task.id);
    harness.executionStartAgent.mockResolvedValueOnce({
      ok: false,
      error: { code: 'AGENT_START_FAILED', message: 'start failed', status: 500 },
    });

    await harness.handlePlanReady(task.id, 'session-skill-rollback', codespace.id, {
      plan: 'Rollback skill-chain plan',
      turnCount: 3,
      sdkSessionId: 'sdk-skill-rollback',
    });

    const result = await harness.approvePlan(task.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AGENT_START_FAILED');
    }

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter?.column).toBe('waiting_approval');
    expect(taskAfter?.lastAgentStatus).toBe('planning');
    expect(taskAfter?.skillId).toBe('planning-skill');
    expect(taskAfter?.skillName).toBe('Planning Skill');
    expect(harness.stateManager.hasPendingPlan(task.id)).toBe(true);
  });
});
