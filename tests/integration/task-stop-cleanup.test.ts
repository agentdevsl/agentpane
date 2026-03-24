import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-022: TaskService.stopAgent Cleanup', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('cleans up task state when agent is not running in memory', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'running' });
    const session = await createTestSession(codespace.id, {
      agentId: agent.id,
      status: 'active',
    });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      agentId: agent.id,
      sessionId: session.id,
    });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const mockContainerAgent: ContainerAgentTrigger = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue(ok(undefined)),
      stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
      rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgent);

    const result = await taskService.stopAgent(task.id);
    expect(result.ok).toBe(true);

    const updated = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(updated!.agentId).toBeNull();
    expect(updated!.sessionId).toBeNull();
    expect(updated!.lastAgentStatus).toBe('cancelled');
    expect(mockContainerAgent.stopAgent).not.toHaveBeenCalled();
  });

  it('delegates to containerAgentService.stopAgent when agent is running', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const agent = await createTestAgent(codespace.id, { status: 'running' });
    const session = await createTestSession(codespace.id, {
      agentId: agent.id,
      status: 'active',
    });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      agentId: agent.id,
      sessionId: session.id,
    });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const mockContainerAgent: ContainerAgentTrigger = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue(ok(undefined)),
      stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
      isAgentRunning: vi.fn().mockReturnValue(true),
      approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
      rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgent);

    const result = await taskService.stopAgent(task.id);
    expect(result.ok).toBe(true);
    expect(mockContainerAgent.stopAgent).toHaveBeenCalledWith(task.id);
  });

  it('succeeds as no-op when task has no agentId', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
    });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const mockContainerAgent: ContainerAgentTrigger = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue(ok(undefined)),
      stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
      rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgent);

    const result = await taskService.stopAgent(task.id);
    expect(result.ok).toBe(true);

    const unchanged = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });

    expect(unchanged!.agentId).toBeNull();
    expect(unchanged!.sessionId).toBeNull();
    expect(unchanged!.lastAgentStatus).toBeNull();
  });
});
