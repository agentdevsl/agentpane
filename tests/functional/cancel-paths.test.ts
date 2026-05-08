import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { ContainerExecService } from '../../src/services/container-agent/container-exec.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams, type InMemoryStreamsServer } from '../helpers/mocks';

function createReadable(): Readable {
  const readable = new Readable({
    read() {
      this.push(null);
    },
  });
  return readable;
}

describe('Container cancel paths', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService & InMemoryStreamsServer;
  let stateManager: SandboxStateManager;
  let sandbox: { status: 'running'; exec: ReturnType<typeof vi.fn> };
  let cleanupWorktree: ReturnType<typeof vi.fn>;
  let service: ContainerExecService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createInMemoryStreams() as DurableStreamsService & InMemoryStreamsServer;
    stateManager = new SandboxStateManager();
    sandbox = {
      status: 'running',
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    };
    cleanupWorktree = vi.fn().mockResolvedValue(undefined);
    service = new ContainerExecService(
      {
        db,
        streams,
        provider: {
          name: 'docker',
          getById: vi.fn().mockResolvedValue(sandbox),
        },
      } as any,
      stateManager,
      {
        cleanupWorktree,
        resolveWorktree: vi.fn(),
        initializeWorkspace: vi.fn(),
      } as any,
      vi.fn()
    );
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  async function registerRunningAgent(phase: 'plan' | 'execute') {
    const codespace = await createTestProject({ name: `Cancel ${phase}` });
    const agent = await createTestAgent(codespace.id, {
      status: phase === 'plan' ? 'planning' : 'running',
    });
    await createTestSession(codespace.id, {
      id: `session-cancel-${phase}`,
      agentId: agent.id,
      status: 'active',
    });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      agentId: agent.id,
      sessionId: `session-cancel-${phase}`,
      title: `Cancel ${phase}`,
    });
    const execResult = {
      stdout: createReadable(),
      stderr: createReadable(),
      wait: vi.fn().mockResolvedValue({ exitCode: 143 }),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    stateManager.setRunningAgent(task.id, {
      taskId: task.id,
      sessionId: `session-cancel-${phase}`,
      codespaceId: codespace.id,
      sandboxId: `sandbox-cancel-${phase}`,
      bridge: { processStream: vi.fn(), processStderr: vi.fn() } as any,
      execResult,
      stopFilePath: `/tmp/.agent-stop-${task.id}`,
      startedAt: new Date(),
      stopRequested: false,
      phase,
      worktreeId: `worktree-cancel-${phase}`,
    });

    return { task, execResult };
  }

  it('stopAgent during planning writes sentinel, kills exec, cleans worktree, and finalizes cancellation', async () => {
    const { task, execResult } = await registerRunningAgent('plan');

    const stop = await service.stopAgent(task.id);
    expect(stop.ok).toBe(true);
    expect(sandbox.exec).toHaveBeenCalledWith('touch', [`/tmp/.agent-stop-${task.id}`]);
    expect(execResult.kill).toHaveBeenCalledOnce();
    expect(cleanupWorktree).toHaveBeenCalledWith(task.id, 'worktree-cancel-plan');
    expect(streams.getEvents('session-cancel-plan').map((event) => event.type)).toContain(
      'container-agent:cancelled'
    );

    await service.handleAgentComplete(task.id, 'cancelled', 0);

    const cancelled = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(cancelled?.lastAgentStatus).toBe('cancelled');
    expect(cancelled?.agentId).toBeNull();
    expect(stateManager.hasRunningAgent(task.id)).toBe(false);
  });

  it('stopAgent during execution after approval finalizes cancellation without completing the task', async () => {
    const { task, execResult } = await registerRunningAgent('execute');

    const stop = await service.stopAgent(task.id);
    expect(stop.ok).toBe(true);
    expect(sandbox.exec).toHaveBeenCalledWith('touch', [`/tmp/.agent-stop-${task.id}`]);
    expect(execResult.kill).toHaveBeenCalledOnce();
    expect(cleanupWorktree).toHaveBeenCalledWith(task.id, 'worktree-cancel-execute');

    await service.handleAgentComplete(task.id, 'cancelled', 0);

    const cancelled = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(cancelled?.column).toBe('in_progress');
    expect(cancelled?.lastAgentStatus).toBe('cancelled');
    expect(cancelled?.completedAt).toBeNull();
    expect(stateManager.hasRunningAgent(task.id)).toBe(false);
  });
});
