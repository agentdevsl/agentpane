import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createMockContainerAgent } from '../factories/container-agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Task Workflow Integration', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('creates a project and adds tasks', async () => {
    const project = await createTestProject({ name: 'Integration Test Project' });
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('Integration Test Project');

    const task1 = await createTestTask(project.id, { title: 'Task 1', column: 'backlog' });
    const task2 = await createTestTask(project.id, { title: 'Task 2', column: 'backlog' });
    const task3 = await createTestTask(project.id, { title: 'Task 3', column: 'backlog' });

    expect(task1.column).toBe('backlog');
    expect(task2.column).toBe('backlog');
    expect(task3.column).toBe('backlog');
  });

  it('moves task through workflow columns', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Workflow Task', column: 'backlog' });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    // Move from backlog to in_progress
    const moveResult1 = await taskService.moveColumn(task.id, 'in_progress');
    expect(moveResult1.ok).toBe(true);
    if (moveResult1.ok) {
      expect(moveResult1.value.task.column).toBe('in_progress');
      expect(moveResult1.value.task.startedAt).toBeTruthy();
    }

    // Move from in_progress to waiting_approval
    const moveResult2 = await taskService.moveColumn(task.id, 'waiting_approval');
    expect(moveResult2.ok).toBe(true);
    if (moveResult2.ok) {
      expect(moveResult2.value.task.column).toBe('waiting_approval');
    }
  });

  it('creates agent and session for task', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Agent Task' });
    const agent = await createTestAgent(project.id, { name: 'Test Agent' });
    const session = await createTestSession(project.id, {
      taskId: task.id,
      agentId: agent.id,
    });

    expect(agent.codespaceId).toBe(project.id);
    expect(session.codespaceId).toBe(project.id);
    expect(session.taskId).toBe(task.id);
    expect(session.agentId).toBe(agent.id);
  });

  it('creates worktree for task', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, { title: 'Worktree Task' });
    const worktree = await createTestWorktree(project.id, {
      taskId: task.id,
      branch: 'agent/test/task',
    });

    expect(worktree.codespaceId).toBe(project.id);
    expect(worktree.taskId).toBe(task.id);
    expect(worktree.branch).toBe('agent/test/task');
    expect(worktree.status).toBe('active');
  });

  it('tracks task with agent, session, and worktree', async () => {
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { name: 'Full Stack Agent' });
    const session = await createTestSession(project.id, { agentId: agent.id });
    const worktree = await createTestWorktree(project.id, {
      branch: 'agent/fullstack/task',
    });

    const task = await createTestTask(project.id, {
      title: 'Full Stack Task',
      column: 'in_progress',
      agentId: agent.id,
      sessionId: session.id,
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    expect(task.agentId).toBe(agent.id);
    expect(task.sessionId).toBe(session.id);
    expect(task.worktreeId).toBe(worktree.id);
    expect(task.branch).toBe(worktree.branch);
  });

  it('rejects task with reason', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const worktree = await createTestWorktree(project.id);
    const task = await createTestTask(project.id, {
      title: 'Rejection Test',
      column: 'waiting_approval',
      worktreeId: worktree.id,
    });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    const rejectResult = await taskService.reject(task.id, { reason: 'Needs more tests' });

    expect(rejectResult.ok).toBe(true);
    if (rejectResult.ok) {
      expect(rejectResult.value.column).toBe('backlog');
      expect(rejectResult.value.rejectionCount).toBe(1);
      expect(rejectResult.value.rejectionReason).toBe('Needs more tests');
    }
  });

  it('lists tasks by column', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    await createTestTask(project.id, { title: 'Backlog 1', column: 'backlog', position: 0 });
    await createTestTask(project.id, { title: 'Backlog 2', column: 'backlog', position: 1 });
    await createTestTask(project.id, { title: 'In Progress', column: 'in_progress', position: 0 });
    await createTestTask(project.id, { title: 'Waiting', column: 'waiting_approval', position: 0 });
    await createTestTask(project.id, { title: 'Done', column: 'verified', position: 0 });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    const backlogTasks = await taskService.getByColumn(project.id, 'backlog');
    const inProgressTasks = await taskService.getByColumn(project.id, 'in_progress');

    expect(backlogTasks.ok).toBe(true);
    if (backlogTasks.ok) {
      expect(backlogTasks.value.length).toBe(2);
    }

    expect(inProgressTasks.ok).toBe(true);
    if (inProgressTasks.ok) {
      expect(inProgressTasks.value.length).toBe(1);
    }
  });
});
