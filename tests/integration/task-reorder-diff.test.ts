import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
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

describe('IT-036–040: Task Reorder, Diff, Sandbox Config, and Prompt', () => {
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

  // IT-036: task-reorder-position (P0)
  describe('IT-036: task-reorder-position', () => {
    it('clamps reorder target beyond the column bounds and preserves dense positions', async () => {
      const codespace = await createTestProject();
      const task0 = await createTestTask(codespace.id, { title: 'Task 0', position: 0 });
      const task1 = await createTestTask(codespace.id, { title: 'Task 1', position: 1 });
      const task2 = await createTestTask(codespace.id, { title: 'Task 2', position: 2 });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const result = await taskService.reorder(task2.id, 5);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.position).toBe(2);

      // Verify the column still has unique dense positions.
      const t0Result = await taskService.getById(task0.id);
      const t1Result = await taskService.getById(task1.id);
      expect(t0Result.ok).toBe(true);
      expect(t1Result.ok).toBe(true);
      if (t0Result.ok) expect(t0Result.value.position).toBe(0);
      if (t1Result.ok) expect(t1Result.value.position).toBe(1);
    });
  });

  // IT-037: task-get-diff-with-worktree (P0)
  describe('IT-037: task-get-diff-with-worktree', () => {
    it('returns diff data when task has a worktreeId and branch', async () => {
      const codespace = await createTestProject();
      const worktree = await createTestWorktree(codespace.id);
      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        worktreeId: worktree.id,
        branch: worktree.branch,
      });

      const worktreeService = createMockWorktreeService();
      worktreeService.getDiff.mockResolvedValue({
        ok: true,
        value: {
          files: [
            { path: 'src/index.ts', additions: 10, deletions: 3 },
            { path: 'src/utils.ts', additions: 5, deletions: 0 },
          ],
          stats: { filesChanged: 2, additions: 15, deletions: 3 },
        },
      });

      const taskService = new TaskService(db as any, worktreeService);

      const result = await taskService.getDiff(task.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.taskId).toBe(task.id);
      expect(result.value.branch).toBe(worktree.branch);
      expect(result.value.baseBranch).toBe('main');
      expect(result.value.files).toHaveLength(2);
      expect(result.value.summary.filesChanged).toBe(2);
      expect(result.value.summary.additions).toBe(15);
      expect(result.value.summary.deletions).toBe(3);

      expect(worktreeService.getDiff).toHaveBeenCalledWith(worktree.id);
    });
  });

  // IT-038: task-get-diff-no-worktree (P1)
  describe('IT-038: task-get-diff-no-worktree', () => {
    it('returns TASK_NO_DIFF when task has no worktreeId', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        worktreeId: null,
        branch: null,
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const result = await taskService.getDiff(task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('TASK_NO_DIFF');
    });
  });

  // IT-039: task-move-sandbox-config-resolution (P0)
  describe('IT-039: task-move-sandbox-config-resolution', () => {
    it('triggers container agent when codespace has sandbox enabled', async () => {
      const codespace = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read'],
          maxTurns: 50,
          sandbox: { enabled: true, mode: 'shared' },
        },
      });
      const task = await createTestTask(codespace.id, { column: 'backlog' });

      const worktreeService = createMockWorktreeService();
      const containerAgent = createMockContainerAgent();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setContainerAgentService(containerAgent);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      expect(containerAgent.startAgent).toHaveBeenCalledTimes(1);
    });

    it('triggers container agent via global sandbox defaults when codespace has no sandbox config', async () => {
      const codespace = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read'],
          maxTurns: 50,
          // No sandbox config on codespace
        },
      });

      // Set global sandbox defaults
      await db.insert(settings).values({
        key: 'sandbox.defaults',
        value: JSON.stringify({ enabled: true, mode: 'shared' }),
      });

      const task = await createTestTask(codespace.id, { column: 'backlog' });

      const worktreeService = createMockWorktreeService();
      const containerAgent = createMockContainerAgent();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setContainerAgentService(containerAgent);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      expect(containerAgent.startAgent).toHaveBeenCalledTimes(1);
    });

    it('does NOT trigger container agent when neither codespace nor global sandbox is enabled', async () => {
      const codespace = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read'],
          maxTurns: 50,
          // No sandbox config
        },
      });
      // No global setting either

      const task = await createTestTask(codespace.id, { column: 'backlog' });

      const worktreeService = createMockWorktreeService();
      const containerAgent = createMockContainerAgent();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setContainerAgentService(containerAgent);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      expect(containerAgent.startAgent).not.toHaveBeenCalled();
    });
  });

  // IT-040: task-build-prompt-content (P0)
  describe('IT-040: task-build-prompt-content', () => {
    it('builds a prompt containing skill, labels, priority, and title', async () => {
      const codespace = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read'],
          maxTurns: 50,
          sandbox: { enabled: true, mode: 'shared' },
        },
      });

      const worktreeService = createMockWorktreeService();
      const containerAgent = createMockContainerAgent();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setContainerAgentService(containerAgent);

      // Use TaskService.create to set priority correctly (factory ignores priority option)
      const createResult = await taskService.create({
        codespaceId: codespace.id,
        title: 'Fix authentication bug',
        description: 'Users cannot log in after password reset',
        skillId: 'my-skill',
        skillName: 'My Skill',
        labels: ['bug', 'urgent'],
        priority: 'high',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const task = createResult.value;

      await taskService.moveColumn(task.id, 'in_progress');

      expect(containerAgent.startAgent).toHaveBeenCalledTimes(1);
      const callArgs = (containerAgent.startAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const prompt: string = callArgs.prompt;

      expect(prompt).toContain('.claude/skills/my-skill/SKILL.md');
      expect(prompt).toContain('Labels: bug, urgent');
      expect(prompt).toContain('Priority: high');
      expect(prompt).toContain('Fix authentication bug');
      expect(prompt).toContain('Users cannot log in after password reset');
    });
  });
});
