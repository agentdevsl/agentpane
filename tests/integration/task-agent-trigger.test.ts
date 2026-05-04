import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions, settings } from '../../src/db/schema';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockWorktreeService() {
  return {
    getDiff: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };
}

function createMockContainerAgent(): ContainerAgentTrigger {
  return {
    providerName: 'docker',
    startAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    rejectPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

describe('IT-001: Task Agent Trigger on moveColumn', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
    try {
      execRawSql('DELETE FROM settings');
    } catch {
      // settings may already be clean
    }
  });

  it('atomically creates a session and triggers container agent when moving to in_progress', async () => {
    const codespace = await createTestProject({
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read'],
        maxTurns: 50,
        sandbox: { enabled: true, mode: 'shared' },
      },
    });

    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true }),
    });

    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const containerAgent = createMockContainerAgent();
    const taskService = new TaskService(db as any, worktreeService);
    taskService.setContainerAgentService(containerAgent);

    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { task: movedTask } = result.value;
    expect(movedTask.column).toBe('in_progress');
    expect(movedTask.sessionId).toBeTruthy();
    expect(movedTask.startedAt).toBeTruthy();

    // Verify session record was created in DB
    const sessionRecord = await db.query.sessions.findFirst({
      where: eq(sessions.id, movedTask.sessionId!),
    });
    expect(sessionRecord).toBeTruthy();
    expect(sessionRecord!.status).toBe('active');
    expect(sessionRecord!.codespaceId).toBe(codespace.id);
    expect(sessionRecord!.taskId).toBe(task.id);
    expect(sessionRecord!.sandboxProvider).toBe('docker');

    // Verify containerAgentService.startAgent was called
    expect(containerAgent.startAgent).toHaveBeenCalledTimes(1);
    const callArgs = (containerAgent.startAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.sessionId).toBe(movedTask.sessionId);
    expect(callArgs.codespaceId).toBe(codespace.id);
    expect(callArgs.taskId).toBe(task.id);
  });

  it('rejects move to in_progress with EXECUTION_NOT_READY when containerAgentService is NOT set', async () => {
    // MAY-04: moving to in_progress is an execution request — without an agent
    // runner wired up there is no one to pick the task up, so the move must
    // fail with a typed retryable error instead of silently succeeding.
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);
    // No containerAgentService set

    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TASK_EXECUTION_NOT_READY');

    // Task must remain in backlog and gain no session.
    const reread = await db.query.tasks.findFirst({
      where: (tasks, { eq }) => eq(tasks.id, task.id),
    });
    expect(reread?.column).toBe('backlog');
    expect(reread?.sessionId).toBeNull();
  });

  it('returns agentError when containerAgentService.startAgent fails', async () => {
    const codespace = await createTestProject({
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read'],
        maxTurns: 50,
        sandbox: { enabled: true, mode: 'shared' },
      },
    });

    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true }),
    });

    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const containerAgent = createMockContainerAgent();
    (containerAgent.startAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { message: 'Docker daemon not running' },
    });

    const taskService = new TaskService(db as any, worktreeService);
    taskService.setContainerAgentService(containerAgent);

    const result = await taskService.moveColumn(task.id, 'in_progress');

    // Task move still succeeds
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.task.column).toBe('backlog');
    expect(result.value.agentError).toBe('Docker daemon not running');
  });
});
