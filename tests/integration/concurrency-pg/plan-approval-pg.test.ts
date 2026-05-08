import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../../src/db/schema';
import { PlanApprovalService } from '../../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../../src/services/container-agent/sandbox-state';
import type { DurableStreamsService } from '../../../src/services/durable-streams.service';
import { createTestProject } from '../../factories/project.factory';
import { createTestTask } from '../../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../../helpers/database';
import { createInMemoryStreams, createMockWorktreeInit } from '../../helpers/mocks';

const hasPostgresHarness = process.env.DB_MODE === 'postgres' && !!process.env.DATABASE_URL;

describe.skipIf(!hasPostgresHarness)('Postgres semantic concurrency: plan approval', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createInMemoryStreams() as unknown as DurableStreamsService;
    stateManager = new SandboxStateManager();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  function createPlanService(
    startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  ) {
    return new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      createMockWorktreeInit() as any,
      startAgentFn,
      () => false
    );
  }

  it('concurrent approve and reject are mutually exclusive under Postgres transactions', async () => {
    const codespace = await createTestProject({ name: 'PG approve reject race' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Race approve and reject',
    });
    const startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const planService = createPlanService(startAgentFn);

    await planService.handlePlanReady(task.id, 'session-pg-race', codespace.id, {
      plan: 'Postgres race plan',
      turnCount: 2,
      sdkSessionId: 'sdk-pg-race',
    });

    const [approve, reject] = await Promise.all([
      planService.approvePlan(task.id),
      planService.rejectPlan(task.id, 'reject raced approve'),
    ]);

    expect(approve.ok !== reject.ok).toBe(true);
    expect(startAgentFn).toHaveBeenCalledTimes(approve.ok ? 1 : 0);

    const finalTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    if (approve.ok) {
      expect(finalTask?.column).toBe('in_progress');
      expect(finalTask?.plan).toBe('Postgres race plan');
    } else {
      expect(finalTask?.column).toBe('backlog');
      expect(finalTask?.plan).toBeNull();
      expect(finalTask?.rejectionReason).toBe('reject raced approve');
    }
  });

  it('two concurrent approvePlan calls start execution exactly once under Postgres transactions', async () => {
    const codespace = await createTestProject({ name: 'PG double approve race' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Double approve',
    });
    const startAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const planService = createPlanService(startAgentFn);

    await planService.handlePlanReady(task.id, 'session-pg-double', codespace.id, {
      plan: 'Postgres double approve plan',
      turnCount: 2,
      sdkSessionId: 'sdk-pg-double',
    });

    const [first, second] = await Promise.all([
      planService.approvePlan(task.id),
      planService.approvePlan(task.id),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toHaveLength(1);
    expect(startAgentFn).toHaveBeenCalledOnce();
  });
});
