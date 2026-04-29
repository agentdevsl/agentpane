/**
 * F10-14 — MetricsService wire-up integration tests.
 *
 * Verifies that real service code paths populate the metrics surface so the
 * `/api/metrics` endpoint is no longer a hollow shell. Each test exercises
 * the actual production call site (not direct metricsService method calls)
 * and asserts the snapshot reflects the change.
 *
 * Test bar (red→green):
 *  - Without the wire-up: counters return 0.
 *  - With the wire-up: counters increment as side effects of normal flow.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../../src/db/schema';
import {
  __resetEventRouterForTests,
  acquireSseSlot,
  releaseSseSlot,
} from '../../src/lib/events/event-router';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { __resetMetricsService, getMetricsService } from '../../src/services/metrics.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock external I/O boundaries so async background execution does not race
// with assertions. Mirrors the pattern from agent-execution-service.test.ts.
vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: vi.fn().mockReturnValue(new Promise(() => {})),
  runAgentExecution: vi.fn().mockReturnValue(new Promise(() => {})),
}));
vi.mock('../../src/lib/agents/recovery.js', () => ({
  handleAgentError: vi.fn().mockReturnValue({ action: 'stop', retry: false }),
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
const mockTaskService = {
  moveColumn: vi.fn().mockResolvedValue({ ok: true }),
};

describe('F10-14 — MetricsService wire-up', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentExecutionService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();

    // Reset the in-memory metrics + SSE counters so each test starts at zero.
    __resetMetricsService();
    __resetEventRouterForTests();

    service = new AgentExecutionService(
      db as any,
      mockWorktreeService as any,
      mockTaskService as any,
      mockSessionService as any
    );
  });

  afterEach(async () => {
    await clearTestDatabase();
    service.stopAll();
  });

  describe('agent_started counter', () => {
    it('reports zero before any agent has started (baseline)', () => {
      const snap = getMetricsService().snapshot();
      expect(snap.agent.started).toBe(0);
      expect(snap.agent.completed).toBe(0);
      expect(snap.agent.errored).toBe(0);
      expect(snap.agent.running).toBe(0);
    });

    it('increments after AgentExecutionService.start() succeeds', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
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

      // Baseline: zero before start.
      expect(getMetricsService().snapshot().agent.started).toBe(0);

      const result = await service.start(agent.id, task.id);
      expect(result.ok).toBe(true);

      // The wire-up bumps the counter immediately after the controller is
      // registered; the gauge refresh is fire-and-forget so we await a
      // microtask flush before reading.
      await new Promise((resolve) => setImmediate(resolve));

      const snap = getMetricsService().snapshot();
      expect(snap.agent.started).toBeGreaterThanOrEqual(1);
      expect(snap.agent.running).toBeGreaterThanOrEqual(1);
    });

    it('increments multiple times across multiple successful starts', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 5 });

      // Two independent agent+task pairs, both started successfully.
      for (let i = 0; i < 2; i++) {
        const agent = await createTestAgent(codespace.id, {
          status: 'idle',
          name: `Agent ${i}`,
        });
        const task = await createTestTask(codespace.id, {
          column: 'backlog',
          title: `Task ${i}`,
        });
        const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
        const session = await createTestSession(codespace.id, {
          taskId: task.id,
          agentId: agent.id,
        });

        mockWorktreeService.create.mockResolvedValueOnce({ ok: true, value: worktree });
        mockSessionService.create.mockResolvedValueOnce({
          ok: true,
          value: { ...session, presence: {} },
        });

        const result = await service.start(agent.id, task.id);
        expect(result.ok).toBe(true);
      }

      await new Promise((resolve) => setImmediate(resolve));

      const snap = getMetricsService().snapshot();
      expect(snap.agent.started).toBe(2);
    });

    it('does not increment when start() fails (NOT_FOUND)', async () => {
      const result = await service.start('nonexistent-agent-id');
      expect(result.ok).toBe(false);

      const snap = getMetricsService().snapshot();
      expect(snap.agent.started).toBe(0);
    });
  });

  describe('agent gauge (running/idle)', () => {
    it('reflects running agents after start()', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
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

      await service.start(agent.id, task.id);

      // The gauge refresh is async; wait for it to land.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const snap = getMetricsService().snapshot();
      expect(snap.agent.running).toBe(1);
    });

    it('returns running back to zero after stop()', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
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

      await service.start(agent.id, task.id);
      await new Promise((resolve) => setImmediate(resolve));

      // Force agent into a state that allows ABORT (stop()'s state-machine
      // check rejects 'starting'/'planning' transitions). Mirroring the
      // production path: planning → running via approval, then stop.
      await db.update(agents).set({ status: 'running' }).where(eq(agents.id, agent.id));

      const stopResult = await service.stop(agent.id);
      expect(stopResult.ok).toBe(true);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const snap = getMetricsService().snapshot();
      expect(snap.agent.running).toBe(0);
    });
  });

  describe('SSE active-connections gauge', () => {
    it('increments on acquireSseSlot() and decrements on releaseSseSlot()', () => {
      // Baseline.
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(0);

      // Acquire two slots on different routes.
      const a = acquireSseSlot('/api/events', 'user-1');
      expect(a.ok).toBe(true);
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(1);

      const b = acquireSseSlot('/api/cli-monitor/stream', 'user-2');
      expect(b.ok).toBe(true);
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(2);

      // Release one — gauge drops by one.
      releaseSseSlot('/api/events', 'user-1');
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(1);

      // Release the other.
      releaseSseSlot('/api/cli-monitor/stream', 'user-2');
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(0);
    });

    it('does not decrement on a stale release (no matching acquire)', () => {
      // No active slots; releasing should be a no-op.
      releaseSseSlot('/api/events', 'phantom-user');
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(0);

      // Now acquire one and try to release a different route — also no-op
      // because the route side guard refuses unmatched releases.
      const a = acquireSseSlot('/api/events', 'user-1');
      expect(a.ok).toBe(true);
      releaseSseSlot('/api/cli-monitor/stream', 'user-1');
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(1);

      // Cleanup.
      releaseSseSlot('/api/events', 'user-1');
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(0);
    });

    it('gauge clamps at zero on over-release (parity with metrics service)', () => {
      const a = acquireSseSlot('/api/events', 'user-1');
      expect(a.ok).toBe(true);
      releaseSseSlot('/api/events', 'user-1');
      // Second release is stale (router guard returns early).
      releaseSseSlot('/api/events', 'user-1');
      expect(getMetricsService().snapshot().sse.activeConnections).toBe(0);
    });
  });

  describe('DB latency histogram', () => {
    it('records select_agent latency on AgentExecutionService.start() lookup', async () => {
      // Cold call: agent does not exist. The lookup still goes through
      // withDbLatency('select_agent'), so a sample should be recorded.
      const result = await service.start('nonexistent-agent-id');
      expect(result.ok).toBe(false);

      const snap = getMetricsService().snapshot();
      const selectAgent = snap.db.byQueryType.find((q) => q.queryType === 'select_agent');
      expect(selectAgent).toBeDefined();
      expect(selectAgent?.count).toBeGreaterThanOrEqual(1);
    });

    it('aggregates samples across multiple start() calls', async () => {
      // Three failed starts → three select_agent samples.
      for (let i = 0; i < 3; i++) {
        await service.start(`nonexistent-${i}`);
      }

      const snap = getMetricsService().snapshot();
      const selectAgent = snap.db.byQueryType.find((q) => q.queryType === 'select_agent');
      expect(selectAgent?.count).toBe(3);
      expect(selectAgent?.totalMs).toBeGreaterThanOrEqual(0);
      expect(selectAgent?.maxMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('end-to-end: /api/metrics surfaces non-zero values', () => {
    it('a successful start() produces a non-zero agent_started count in the snapshot', async () => {
      const codespace = await createTestProject({ maxConcurrentAgents: 3 });
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

      await service.start(agent.id, task.id);
      await new Promise((resolve) => setImmediate(resolve));

      // This is the contract enforced by the F10-14 fix:
      // /api/metrics → MetricsService.snapshot() → agent.started > 0.
      // Without the wire-up this assertion would fail because the counter
      // would still be 0.
      const snap = getMetricsService().snapshot();
      expect(snap.agent.started).toBeGreaterThanOrEqual(1);
    });
  });
});
