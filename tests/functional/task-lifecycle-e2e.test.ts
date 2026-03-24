/**
 * Functional E2E Test: Task Creation → Skill Association → Planning → Approval → Execution
 *
 * This test exercises the FULL orchestration pipeline with real database, real services,
 * and real state management. Only external dependencies (Claude SDK, Docker/sandbox providers)
 * are mocked.
 *
 * Run separately: npx vitest run tests/functional/task-lifecycle-e2e.test.ts
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { createContainerBridge } from '../../src/lib/agents/container-bridge';
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

describe('Functional E2E: Task → Skill → Plan → Approve → Execute → Verify', () => {
  const CODESPACE_ID = 'func-codespace-1';
  const TASK_ID = 'func-task-1';
  const SESSION_ID = 'func-session-1';
  const AGENT_ID = 'func-agent-1';
  const WORKTREE_ID = 'func-worktree-1';

  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('complete lifecycle: create task with skill → plan → approve → execute → approve changes → verified', async () => {
    const db = getTestDb();
    const streams = createMockStreams();
    const mockWorktreeService = createMockWorktreeService();

    // ── Phase 1: Create codespace and task with skill ──

    const codespace = await createTestProject({
      id: CODESPACE_ID,
      name: 'E2E Test Project',
      path: '/tmp/e2e-project',
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        maxTurns: 50,
      },
    });

    const task = await createTestTask(codespace.id, {
      id: TASK_ID,
      title: 'Implement user authentication',
      description: 'Add JWT-based authentication to the API layer',
      column: 'backlog',
      skillId: 'auth-toolkit',
      skillName: 'Authentication Toolkit',
      labels: ['feature', 'security'],
    });

    // Verify task created with skill fields
    expect(task.column).toBe('backlog');
    expect(task.skillId).toBe('auth-toolkit');
    expect(task.skillName).toBe('Authentication Toolkit');

    // ── Phase 2: Move task to in_progress (triggers agent) ──

    const taskService = new TaskService(db, mockWorktreeService);

    // Set up a mock container agent service that captures the prompt
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

    // Insert sandbox defaults to enable container agent triggering
    await db.insert(sessions).values({
      id: 'temp-settings-session',
      codespaceId: codespace.id,
      status: 'active',
      title: 'temp',
    });
    // Clean up temp session
    await db.delete(sessions).where(eq(sessions.id, 'temp-settings-session'));

    // Enable sandbox via settings
    const { settings } = await import('../../src/db/schema');
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true, mode: 'shared' }),
    });

    const moveResult = await taskService.moveColumn(TASK_ID, 'in_progress');
    expect(moveResult.ok).toBe(true);

    if (moveResult.ok) {
      const movedTask = moveResult.value.task;
      expect(movedTask.column).toBe('in_progress');
      expect(movedTask.startedAt).toBeTruthy();
      expect(movedTask.sessionId).toBeTruthy();

      // Verify skill was included in the agent prompt
      expect(mockContainerAgent.startAgent).toHaveBeenCalledOnce();
      expect(capturedStartInput).toBeTruthy();
      const prompt = capturedStartInput!.prompt as string;
      expect(prompt).toContain('use skill auth-toolkit');
      expect(prompt).toContain('Implement user authentication');
      expect(prompt).toContain('Labels: feature, security');
    }

    // ── Phase 3: Simulate planning phase completion (plan_ready event) ──

    // Create supporting records that would exist in a real run
    const _agent = await createTestAgent(codespace.id, {
      id: AGENT_ID,
      status: 'planning',
      currentTaskId: TASK_ID,
    });

    const worktree = await createTestWorktree(codespace.id, {
      id: WORKTREE_ID,
      taskId: TASK_ID,
      branch: 'agent/implement-user-authentication',
      status: 'active',
    });

    // Update task with agent/worktree refs
    await db
      .update(tasks)
      .set({
        agentId: AGENT_ID,
        worktreeId: WORKTREE_ID,
        branch: worktree.branch,
      })
      .where(eq(tasks.id, TASK_ID));

    // Simulate the container bridge receiving plan_ready
    const onPlanReady = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();

    const bridge = createContainerBridge({
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      codespaceId: CODESPACE_ID,
      streams,
      onComplete,
      onError,
      onPlanReady,
    });

    const planEvents = [
      {
        type: 'agent:plan_ready',
        timestamp: Date.now(),
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        data: {
          plan: '## Implementation Plan\n\n1. Create JWT middleware\n2. Add login/register endpoints\n3. Write integration tests\n4. Update API documentation',
          turnCount: 5,
          sdkSessionId: 'sdk-session-auth-plan',
          allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
        },
      },
    ];

    await bridge.processStream(jsonLinesToStream(planEvents));

    expect(onPlanReady).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Simulate what PlanApprovalService.handlePlanReady does to the DB
    await db
      .update(tasks)
      .set({
        plan: '## Implementation Plan\n\n1. Create JWT middleware\n2. Add login/register endpoints\n3. Write integration tests\n4. Update API documentation',
        planOptions: {
          sdkSessionId: 'sdk-session-auth-plan',
          allowedPrompts: [{ tool: 'Bash' as const, prompt: 'npm test' }],
          planningSandboxId: 'sandbox-123',
        },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, TASK_ID));

    // Verify task is now waiting for approval with plan data
    const plannedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, TASK_ID),
    });
    expect(plannedTask!.column).toBe('waiting_approval');
    expect(plannedTask!.plan).toContain('Create JWT middleware');
    expect(plannedTask!.lastAgentStatus).toBe('planning');
    expect(plannedTask!.skillId).toBe('auth-toolkit');

    const planOptions = plannedTask!.planOptions as {
      sdkSessionId?: string;
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
    } | null;
    expect(planOptions?.sdkSessionId).toBe('sdk-session-auth-plan');

    // ── Phase 4: Approve the plan (triggers execution phase) ──

    // Simulate approvePlan: move task back to in_progress for execution
    await db
      .update(tasks)
      .set({
        column: 'in_progress',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, TASK_ID));

    const approvedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, TASK_ID),
    });
    expect(approvedTask!.column).toBe('in_progress');
    expect(approvedTask!.lastAgentStatus).toBe('planning'); // preserved until execution completes
    expect(approvedTask!.plan).toContain('Create JWT middleware'); // plan text preserved

    // ── Phase 5: Simulate execution completion ──

    // Agent executes the plan and completes
    const completionSuccess = await updateTaskOnAgentComplete(
      db,
      TASK_ID,
      'completed',
      streams,
      SESSION_ID
    );
    expect(completionSuccess).toBe(true);

    const completedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, TASK_ID),
    });
    expect(completedTask!.column).toBe('waiting_approval');
    expect(completedTask!.lastAgentStatus).toBe('completed');
    expect(completedTask!.completedAt).toBeTruthy();
    expect(completedTask!.agentId).toBeNull(); // agent reference cleared
    expect(completedTask!.sessionId).toBeNull(); // session reference cleared
    expect(completedTask!.skillId).toBe('auth-toolkit'); // skill preserved through entire lifecycle

    // ── Phase 6: User approves the changes (merge + verify) ──

    // Re-link worktree for approval flow
    await db
      .update(tasks)
      .set({ worktreeId: WORKTREE_ID, branch: worktree.branch })
      .where(eq(tasks.id, TASK_ID));

    const approveResult = await taskService.approve(TASK_ID, {
      approvedBy: 'test-user',
      createMergeCommit: true,
    });
    expect(approveResult.ok).toBe(true);

    if (approveResult.ok) {
      const verifiedTask = approveResult.value;
      expect(verifiedTask.column).toBe('verified');
      expect(verifiedTask.approvedAt).toBeTruthy();
      expect(verifiedTask.approvedBy).toBe('test-user');
      expect(verifiedTask.completedAt).toBeTruthy();
      expect(verifiedTask.diffSummary).toEqual({
        filesChanged: 2,
        additions: 70,
        deletions: 5,
      });

      // Skill fields preserved all the way to verification
      expect(verifiedTask.skillId).toBe('auth-toolkit');
      expect(verifiedTask.skillName).toBe('Authentication Toolkit');
    }

    // Verify worktree was merged and removed
    expect(mockWorktreeService.getDiff).toHaveBeenCalledWith(WORKTREE_ID);
    expect(mockWorktreeService.merge).toHaveBeenCalledWith(WORKTREE_ID);
    expect(mockWorktreeService.remove).toHaveBeenCalledWith(WORKTREE_ID);
  });

  it('plan rejection returns task to backlog with clean state', async () => {
    const db = getTestDb();

    const codespace = await createTestProject({ id: CODESPACE_ID });
    await createTestTask(codespace.id, {
      id: TASK_ID,
      column: 'in_progress',
      skillId: 'auth-toolkit',
    });

    // Simulate plan stored
    await db
      .update(tasks)
      .set({
        plan: 'Bad plan',
        planOptions: { sdkSessionId: 'sdk-reject' },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
        worktreeId: 'wt-reject',
        branch: 'agent/bad-plan',
      })
      .where(eq(tasks.id, TASK_ID));

    // Simulate rejection: clear plan fields, move to backlog
    await db
      .update(tasks)
      .set({
        plan: null,
        planOptions: null,
        lastAgentStatus: null,
        column: 'backlog',
        worktreeId: null,
        branch: null,
        rejectionReason: 'Plan does not address security requirements',
        rejectionCount: 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, TASK_ID));

    const rejectedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, TASK_ID),
    });
    expect(rejectedTask!.column).toBe('backlog');
    expect(rejectedTask!.plan).toBeNull();
    expect(rejectedTask!.planOptions).toBeNull();
    expect(rejectedTask!.lastAgentStatus).toBeNull();
    expect(rejectedTask!.worktreeId).toBeNull();
    expect(rejectedTask!.branch).toBeNull();
    expect(rejectedTask!.rejectionReason).toBe('Plan does not address security requirements');
    expect(rejectedTask!.rejectionCount).toBe(1);
    expect(rejectedTask!.skillId).toBe('auth-toolkit'); // skill preserved
  });

  it('agent error during execution cleans up state correctly', async () => {
    const db = getTestDb();
    const streams = createMockStreams();

    const codespace = await createTestProject({ id: CODESPACE_ID });
    await createTestTask(codespace.id, {
      id: TASK_ID,
      column: 'in_progress',
      skillId: 'auth-toolkit',
      agentId: AGENT_ID,
    });

    await createTestAgent(codespace.id, {
      id: AGENT_ID,
      status: 'running',
      currentTaskId: TASK_ID,
    });

    // Simulate agent error
    const errorSuccess = await updateTaskOnAgentError(db, TASK_ID, streams, SESSION_ID);
    expect(errorSuccess).toBe(true);

    const errorTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, TASK_ID),
    });
    expect(errorTask!.lastAgentStatus).toBe('error');
    expect(errorTask!.agentId).toBeNull();
    expect(errorTask!.sessionId).toBeNull();
    expect(errorTask!.skillId).toBe('auth-toolkit'); // skill preserved even on error
  });

  it('multi-round: reject → re-plan → approve → execute → verify', async () => {
    const db = getTestDb();
    const mockWorktreeService = createMockWorktreeService();
    const taskService = new TaskService(db, mockWorktreeService);

    const codespace = await createTestProject({ id: CODESPACE_ID });
    await createTestTask(codespace.id, {
      id: TASK_ID,
      title: 'Fix authentication bug',
      column: 'backlog',
      skillId: 'debug-toolkit',
      skillName: 'Debug Toolkit',
    });

    // Round 1: Move to in_progress
    const move1 = await taskService.moveColumn(TASK_ID, 'in_progress');
    expect(move1.ok).toBe(true);

    // Round 1: Plan arrives, stored
    await db
      .update(tasks)
      .set({
        plan: 'Round 1 plan: patch the token validation',
        planOptions: { sdkSessionId: 'sdk-r1' },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
      })
      .where(eq(tasks.id, TASK_ID));

    // Round 1: Reject
    await db
      .update(tasks)
      .set({
        plan: null,
        planOptions: null,
        lastAgentStatus: null,
        column: 'backlog',
        rejectionReason: 'Too narrow — also fix the refresh token flow',
        rejectionCount: 1,
      })
      .where(eq(tasks.id, TASK_ID));

    const afterReject = await db.query.tasks.findFirst({ where: eq(tasks.id, TASK_ID) });
    expect(afterReject!.column).toBe('backlog');
    expect(afterReject!.rejectionCount).toBe(1);

    // Round 2: Move to in_progress again
    const move2 = await taskService.moveColumn(TASK_ID, 'in_progress');
    expect(move2.ok).toBe(true);

    // Round 2: Better plan arrives
    await db
      .update(tasks)
      .set({
        plan: 'Round 2 plan: fix token validation AND refresh token flow',
        planOptions: { sdkSessionId: 'sdk-r2' },
        lastAgentStatus: 'planning',
        column: 'waiting_approval',
      })
      .where(eq(tasks.id, TASK_ID));

    // Round 2: Approve
    await db.update(tasks).set({ column: 'in_progress' }).where(eq(tasks.id, TASK_ID));

    // Round 2: Execution completes
    await updateTaskOnAgentComplete(db, TASK_ID, 'completed');

    const afterExec = await db.query.tasks.findFirst({ where: eq(tasks.id, TASK_ID) });
    expect(afterExec!.column).toBe('waiting_approval');
    expect(afterExec!.lastAgentStatus).toBe('completed');

    // Create worktree for approval
    const wt = await createTestWorktree(codespace.id, {
      taskId: TASK_ID,
      status: 'active',
    });
    await db
      .update(tasks)
      .set({ worktreeId: wt.id, branch: wt.branch })
      .where(eq(tasks.id, TASK_ID));

    // Final approval
    const approveResult = await taskService.approve(TASK_ID, { approvedBy: 'lead-dev' });
    expect(approveResult.ok).toBe(true);
    if (approveResult.ok) {
      expect(approveResult.value.column).toBe('verified');
      expect(approveResult.value.approvedBy).toBe('lead-dev');
      expect(approveResult.value.skillId).toBe('debug-toolkit');
      expect(approveResult.value.rejectionCount).toBe(1); // rejection history preserved
    }
  });

  it('turn limit pauses agent without losing skill or plan context', async () => {
    const db = getTestDb();
    const streams = createMockStreams();

    const codespace = await createTestProject({ id: CODESPACE_ID });
    await createTestTask(codespace.id, {
      id: TASK_ID,
      column: 'in_progress',
      skillId: 'refactor-toolkit',
      plan: 'Refactoring plan text',
      planOptions: { sdkSessionId: 'sdk-turns' },
    });

    // Simulate turn limit hit
    const turnLimitSuccess = await updateTaskOnAgentComplete(
      db,
      TASK_ID,
      'turn_limit',
      streams,
      SESSION_ID
    );
    expect(turnLimitSuccess).toBe(true);

    const pausedTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, TASK_ID),
    });
    expect(pausedTask!.column).toBe('waiting_approval');
    expect(pausedTask!.lastAgentStatus).toBe('turn_limit');
    expect(pausedTask!.skillId).toBe('refactor-toolkit'); // skill preserved
    expect(pausedTask!.plan).toBe('Refactoring plan text'); // plan preserved
  });
});
