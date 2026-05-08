/**
 * Integration tests for PlanApprovalService skill-chaining and error paths.
 *
 * Targets coverage gaps in approvePlan() and rejectPlan() that the existing
 * IT-220..IT-227 suite does not exercise:
 *   - Skill chaining: executionSkillId differs from skillId; the in_progress
 *     transition swaps the skill in the same CAS update.
 *   - rejectPlan: the database update catch path returns
 *     SANDBOX_PLAN_REJECTION_FAILED (lines 674-678).
 *   - rejectPlan: cleanupWorktree error path (line 687).
 *
 * No production bugs are claimed in this file — the assertions document
 * existing contract boundaries and lock them in as regression guards.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams } from '../helpers/mocks';

function buildDeps(db: ReturnType<typeof getTestDb>) {
  return {
    db,
    provider: {
      get: vi.fn().mockResolvedValue(null),
    } as never,
    streams: createInMemoryStreams(),
    apiKeyService: {
      getDecryptedKey: vi.fn().mockResolvedValue(null),
    } as never,
    worktreeService: undefined,
    githubTokenService: undefined,
    skillTrackingService: null,
    sandboxService: undefined,
  };
}

describe('PlanApprovalService — skill chaining & error paths (IT-PAS-EXT)', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let worktreeInit: { cleanupWorktree: ReturnType<typeof vi.fn> };
  let startAgentFn: ReturnType<typeof vi.fn>;
  let service: PlanApprovalService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    state = new SandboxStateManager();
    worktreeInit = { cleanupWorktree: vi.fn().mockResolvedValue(undefined) };
    startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    service = new PlanApprovalService(
      buildDeps(db),
      state,
      worktreeInit as never,
      startAgentFn,
      () => false // not AgentCore
    );
  });

  afterEach(async () => {
    state.dispose();
    await clearTestDatabase();
  });

  it('approvePlan swaps skillId/skillName when executionSkillId differs', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      skillId: 'plan-skill',
      skillName: 'Plan Skill',
    });
    // Set executionSkillId via direct update — TaskService doesn't expose this seam
    await db
      .update(tasks)
      .set({
        executionSkillId: 'execute-skill',
        executionSkillName: 'Execute Skill',
        plan: 'Approved plan body',
        planOptions: { sdkSessionId: 'sdk-x' },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    state.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: 'sess-1',
      codespaceId: codespace.id,
      plan: 'Approved plan body',
      turnCount: 1,
      sdkSessionId: 'sdk-x',
      createdAt: new Date(),
    });

    const result = await service.approvePlan(task.id, 'agent-review');
    expect(result.ok).toBe(true);

    const refreshed = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(refreshed?.column).toBe('in_progress');
    expect(refreshed?.skillId).toBe('execute-skill');
    expect(refreshed?.skillName).toBe('Execute Skill');

    // Verify startAgentFn received the chained skill prompt
    expect(startAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        codespaceId: codespace.id,
        taskId: task.id,
        phase: 'execute',
        prompt: expect.stringContaining('.claude/skills/execute-skill/SKILL.md'),
      })
    );
  });

  it('approvePlan rolls task + skill back to original when startAgent fails', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      skillId: 'plan-skill',
      skillName: 'Plan Skill',
    });
    await db
      .update(tasks)
      .set({
        executionSkillId: 'execute-skill',
        executionSkillName: 'Execute Skill',
        plan: 'Plan body',
        planOptions: { sdkSessionId: 'sdk-y' },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    state.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: 'sess-2',
      codespaceId: codespace.id,
      plan: 'Plan body',
      turnCount: 1,
      sdkSessionId: 'sdk-y',
      createdAt: new Date(),
    });

    startAgentFn.mockResolvedValue({
      ok: false,
      error: { code: 'AGENT_START_FAILED', message: 'docker dead', status: 500 },
    });

    const result = await service.approvePlan(task.id);
    expect(result.ok).toBe(false);

    // Rollback: task back to waiting_approval, original skill restored
    const refreshed = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(refreshed?.column).toBe('waiting_approval');
    expect(refreshed?.lastAgentStatus).toBe('planning');
    expect(refreshed?.skillId).toBe('plan-skill');
    expect(refreshed?.skillName).toBe('Plan Skill');
  });

  it('rejectPlan returns PLAN_REJECTION_FAILED when DB update throws', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id);
    await db
      .update(tasks)
      .set({
        column: 'waiting_approval' as const,
        plan: 'Plan',
        planOptions: {},
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Mark plan in memory so the rejectPlan codepath progresses past the
    // initial DB lookup; then poison db.update via a spy to throw.
    state.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: 'sess-3',
      codespaceId: codespace.id,
      plan: 'Plan',
      turnCount: 0,
      sdkSessionId: '',
      createdAt: new Date(),
    });

    const realUpdate = db.update.bind(db);
    let didFail = false;
    const updateSpy = vi.spyOn(db, 'update').mockImplementation(((arg: unknown) => {
      if (!didFail) {
        didFail = true;
        // Build a chain that throws on returning() to simulate a DB failure
        // partway through the update pipeline.
        return {
          set: () => ({
            where: () => ({
              returning: () => {
                throw new Error('disk full');
              },
            }),
          }),
        } as never;
      }
      return realUpdate(arg as never);
    }) as never);

    const result = await service.rejectPlan(task.id, 'because');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_PLAN_REJECTION_FAILED');
    }
    updateSpy.mockRestore();
  });

  it('rejectPlan triggers cleanupWorktree when worktreeId was set', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });
    await db
      .update(tasks)
      .set({ plan: 'Plan', planOptions: {}, lastAgentStatus: 'planning' })
      .where(eq(tasks.id, task.id));

    state.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: 'sess-4',
      codespaceId: codespace.id,
      plan: 'Plan',
      turnCount: 0,
      sdkSessionId: '',
      createdAt: new Date(),
    });

    const result = await service.rejectPlan(task.id, 'reject me');
    expect(result.ok).toBe(true);

    // Cleanup is fire-and-forget; allow the microtask queue to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(worktreeInit.cleanupWorktree).toHaveBeenCalledWith(task.id, worktree.id);
  });

  it('rejectPlan cleanupWorktree rejection is swallowed (best-effort)', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });
    await db
      .update(tasks)
      .set({ plan: 'Plan', planOptions: {}, lastAgentStatus: 'planning' })
      .where(eq(tasks.id, task.id));

    state.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: 'sess-5',
      codespaceId: codespace.id,
      plan: 'Plan',
      turnCount: 0,
      sdkSessionId: '',
      createdAt: new Date(),
    });

    worktreeInit.cleanupWorktree.mockRejectedValueOnce(new Error('git error'));

    const result = await service.rejectPlan(task.id);
    expect(result.ok).toBe(true);

    // Wait for the catch handler to run (best-effort + logged)
    await new Promise((r) => setTimeout(r, 30));

    const refreshed = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(refreshed?.column).toBe('backlog');
    expect(refreshed?.worktreeId).toBeNull();
  });
});
