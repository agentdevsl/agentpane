/**
 * Integration coverage for AgentExecutionService.sweepOrphanedAgents and
 * stopAll — paths not exercised by the existing happy-path lifecycle tests.
 *
 * Run: npx vitest run --project integration tests/integration/agent-execution-orphan-sweep-paths.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../../src/db/schema';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function buildService(db: ReturnType<typeof getTestDb>): AgentExecutionService {
  return new AgentExecutionService(
    db,
    {
      remove: vi.fn(async () => ({ ok: true, value: undefined })),
    } as never,
    {} as never, // taskService (unused)
    {} as never // sessionService (unused for sweep paths)
  );
}

describe('AgentExecutionService — orphan sweep + stopAll paths', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  it('sweepOrphanedAgents leaves recently-started agents alone', async () => {
    const db = getTestDb();
    const project = await createTestProject({ name: 'sweep-fresh' });
    const agent = await createTestAgent(project.id, { status: 'running' });

    const service = buildService(db);
    // Inject a "running" agent with a recent startTime via private field access
    const controller = new AbortController();
    (service as unknown as { runningAgents: Map<string, AbortController> }).runningAgents.set(
      agent.id,
      controller
    );
    (service as unknown as { agentStartTimes: Map<string, number> }).agentStartTimes.set(
      agent.id,
      Date.now() // just started
    );

    (service as unknown as { sweepOrphanedAgents: () => void }).sweepOrphanedAgents();
    // Agent should still be tracked
    expect(
      (service as unknown as { runningAgents: Map<string, AbortController> }).runningAgents.has(
        agent.id
      )
    ).toBe(true);
    // DB unchanged
    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(dbAgent?.status).toBe('running');
    // Cleanup
    controller.abort();
    service.stopAll();
  });

  it('sweepOrphanedAgents aborts agents whose runtime exceeds maxAgentRuntimeMs and updates DB to error', async () => {
    const db = getTestDb();
    const project = await createTestProject({ name: 'sweep-stale' });
    const agent = await createTestAgent(project.id, { status: 'running' });

    const service = buildService(db);
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    (service as unknown as { runningAgents: Map<string, AbortController> }).runningAgents.set(
      agent.id,
      controller
    );
    // Started 5 hours ago — exceeds default 4h max runtime
    (service as unknown as { agentStartTimes: Map<string, number> }).agentStartTimes.set(
      agent.id,
      Date.now() - 5 * 60 * 60 * 1000
    );
    // Cap maxAgentRuntimeMs explicitly so we don't depend on settings lookup
    (service as unknown as { maxAgentRuntimeMs: number }).maxAgentRuntimeMs = 4 * 60 * 60 * 1000;

    (service as unknown as { sweepOrphanedAgents: () => void }).sweepOrphanedAgents();

    expect(abortSpy).toHaveBeenCalled();
    expect(
      (service as unknown as { runningAgents: Map<string, AbortController> }).runningAgents.has(
        agent.id
      )
    ).toBe(false);
    // Allow the fire-and-forget DB update to flush
    await new Promise((r) => setImmediate(r));
    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(dbAgent?.status).toBe('error');
  });

  it('stopAll() aborts every running controller and clears the maps', async () => {
    const db = getTestDb();
    const project = await createTestProject({ name: 'stopAll' });
    const agent1 = await createTestAgent(project.id, { name: 'a1', status: 'running' });
    const agent2 = await createTestAgent(project.id, { name: 'a2', status: 'running' });

    const service = buildService(db);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a1 = vi.spyOn(c1, 'abort');
    const a2 = vi.spyOn(c2, 'abort');
    const runningAgents = (service as unknown as { runningAgents: Map<string, AbortController> })
      .runningAgents;
    runningAgents.set(agent1.id, c1);
    runningAgents.set(agent2.id, c2);
    (service as unknown as { agentStartTimes: Map<string, number> }).agentStartTimes.set(
      agent1.id,
      Date.now()
    );
    (service as unknown as { agentStartTimes: Map<string, number> }).agentStartTimes.set(
      agent2.id,
      Date.now()
    );

    service.stopAll();
    expect(a1).toHaveBeenCalled();
    expect(a2).toHaveBeenCalled();
    expect(runningAgents.size).toBe(0);
  });

  it('isRunning returns true when agent is in the map and false otherwise', () => {
    const db = getTestDb();
    const service = buildService(db);
    const controller = new AbortController();
    (service as unknown as { runningAgents: Map<string, AbortController> }).runningAgents.set(
      'live-agent',
      controller
    );
    expect(service.isRunning('live-agent')).toBe(true);
    expect(service.isRunning('not-here')).toBe(false);
    controller.abort();
    service.stopAll();
  });

  it('sweepOrphanedAgents with no running agents is a no-op', () => {
    const db = getTestDb();
    const service = buildService(db);
    expect(() =>
      (service as unknown as { sweepOrphanedAgents: () => void }).sweepOrphanedAgents()
    ).not.toThrow();
  });
});
