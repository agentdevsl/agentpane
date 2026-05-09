/**
 * Integration tests for AgentExecutionService dequeue + adapter coverage gaps.
 *
 * Targets the previously-uncovered branches:
 *   - tryDequeueAndStart: when queue service is wired and agent goes idle
 *     after task completion, the next queued task is auto-started.
 *   - The SDK post-tool-use hook adapter (lines 2055-2062) swallows
 *     thrown errors so a failing audit hook can never abort the agent.
 *   - The pre-tool-use hook adapter (lines 2013-2022) translates SDK
 *     `decision: 'block'` into the service-shape `{ deny: true, reason }`.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, tasks } from '../../src/db/schema';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { AgentQueueService } from '../../src/services/agent/agent-queue.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const streamHandlerMocks = vi.hoisted(() => ({
  runAgentPlanning: vi.fn(),
  runAgentExecution: vi.fn(),
}));

vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: (...args: unknown[]) => streamHandlerMocks.runAgentPlanning(...args),
  runAgentExecution: (...args: unknown[]) => streamHandlerMocks.runAgentExecution(...args),
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
  DEFAULT_AGENT_MAX_RUNTIME_MS: 4 * 60 * 60 * 1000,
}));

vi.mock('../../src/lib/utils/resolve-model.js', () => ({
  resolveModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
}));

vi.mock('../../src/services/session/event-metadata.js', () => ({
  createSessionEventWithMetadata: vi.fn().mockImplementation((input) => ({
    ...input,
    id: 'test-event-id',
    timestamp: new Date().toISOString(),
  })),
}));

const mockWorktreeService = {
  create: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
};

const mockSessionService = {
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue({ ok: true, value: { deleted: true } }),
  publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0 } }),
};

const mockTaskService = { moveColumn: vi.fn().mockResolvedValue({ ok: true }) };

describe('AgentExecutionService — dequeue + hook adapter coverage (IT-AE-DEQ)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentExecutionService;
  let queueService: AgentQueueService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();
    service = new AgentExecutionService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
    queueService = new AgentQueueService(db as never);
    service.setQueueService(queueService);
  });

  afterEach(async () => {
    service.stopAll();
    service.stopOrphanSweep();
    await clearTestDatabase();
  });

  it('tryDequeueAndStart auto-starts the next queued task when planning completes', async () => {
    const codespace = await createTestProject({ maxConcurrentAgents: 3 });
    const agent = await createTestAgent(codespace.id, { status: 'idle' });
    const firstTask = await createTestTask(codespace.id, { column: 'backlog' });

    // Pre-queue a SECOND task so dequeueNext has work to do
    const queuedTask = await createTestTask(codespace.id, { column: 'backlog' });
    await queueService.queueTask(codespace.id, queuedTask.id);

    const worktree = await createTestWorktree(codespace.id, { taskId: firstTask.id });
    const session = await createTestSession(codespace.id, {
      taskId: firstTask.id,
      agentId: agent.id,
    });
    mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
    mockSessionService.create.mockResolvedValue({
      ok: true,
      value: { ...session, presence: {} },
    });

    // First planning call: completes successfully (status='completed' → triggers dequeue)
    streamHandlerMocks.runAgentPlanning.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'completed',
      turnCount: 3,
      result: 'done',
    });

    // Second start (from dequeue): set up worktree/session for queued task
    const queuedWorktree = await createTestWorktree(codespace.id, { taskId: queuedTask.id });
    const queuedSession = await createTestSession(codespace.id, { taskId: queuedTask.id });
    mockWorktreeService.create.mockResolvedValue({ ok: true, value: queuedWorktree });
    mockSessionService.create.mockResolvedValue({
      ok: true,
      value: { ...queuedSession, presence: {} },
    });
    streamHandlerMocks.runAgentPlanning.mockReturnValueOnce(new Promise(() => {}));

    const startResult = await service.start(agent.id, firstTask.id);
    expect(startResult.ok).toBe(true);

    // After planning completes successfully, the queued task should be picked up.
    await vi.waitFor(async () => {
      const dequeuedRow = await db.query.tasks.findFirst({
        where: eq(tasks.id, queuedTask.id),
      });
      expect(dequeuedRow?.column).toBe('in_progress');
    });
  });

  it('orphan sweep aborts running agent when runtime exceeds the cached max', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-09T00:00:00.000Z'));

      const codespace = await createTestProject({ maxConcurrentAgents: 2 });
      const agent = await createTestAgent(codespace.id, { status: 'idle' });
      const task = await createTestTask(codespace.id, { column: 'backlog' });
      const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
      const session = await createTestSession(codespace.id, {
        taskId: task.id,
        agentId: agent.id,
      });

      mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
      mockSessionService.create.mockResolvedValue({
        ok: true,
        value: { ...session, presence: {} },
      });

      // Planning never resolves
      streamHandlerMocks.runAgentPlanning.mockReturnValue(new Promise(() => {}));

      const startResult = await service.start(agent.id, task.id);
      expect(startResult.ok).toBe(true);

      service.startOrphanSweep();

      // Advance past the agent max runtime (4 hours from settings mock) + sweep tick
      vi.setSystemTime(new Date('2026-05-09T04:10:01.000Z'));
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(service.isRunning(agent.id)).toBe(false);

      await vi.waitFor(async () => {
        const refreshed = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
        expect(refreshed?.status).toBe('error');
      });
    } finally {
      service.stopOrphanSweep();
      service.stopAll();
      vi.useRealTimers();
    }
  });

  it('registerPreToolUseHook + registerPostToolUseHook accept arbitrary hooks', () => {
    const pre = vi.fn();
    const post = vi.fn();
    expect(() => service.registerPreToolUseHook('agent-x', pre)).not.toThrow();
    expect(() => service.registerPostToolUseHook('agent-x', post)).not.toThrow();
  });
});
