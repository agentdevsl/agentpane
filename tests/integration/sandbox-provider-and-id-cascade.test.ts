import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { ContainerAgentDeps } from '../../src/services/container-agent/types';
import type { WorktreeInitService } from '../../src/services/container-agent/worktree-init.service';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import {
  createInMemoryStreams,
  createMockWorktreeInit,
  type InMemoryStreamsServer,
} from '../helpers/mocks';

describe('Sandbox provider and id cascade integration', () => {
  let db: ReturnType<typeof getTestDb>;
  let state: SandboxStateManager;
  let streams: InMemoryStreamsServer;
  let providerGet: ReturnType<typeof vi.fn>;
  let startAgentFn: ReturnType<typeof vi.fn>;
  let service: PlanApprovalService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    state = new SandboxStateManager();
    streams = createInMemoryStreams();
    providerGet = vi.fn();
    startAgentFn = vi.fn().mockResolvedValue(ok(undefined));

    const deps: ContainerAgentDeps = {
      db,
      provider: { get: providerGet } as unknown as ContainerAgentDeps['provider'],
      streams: streams as unknown as DurableStreamsService,
      apiKeyService: {} as unknown as ContainerAgentDeps['apiKeyService'],
    };

    service = new PlanApprovalService(
      deps,
      state,
      createMockWorktreeInit() as unknown as WorktreeInitService,
      startAgentFn,
      () => false
    );
  });

  afterEach(async () => {
    state.dispose();
    await clearTestDatabase();
  });

  it('approving one codespace plan only checks and starts that codespace sandbox', async () => {
    const codespaceA = await createTestProject({ name: 'Isolation A' });
    const codespaceB = await createTestProject({ name: 'Isolation B' });
    const sessionA = await createTestSession(codespaceA.id);
    const sessionB = await createTestSession(codespaceB.id);
    const taskA = await createTestTask(codespaceA.id, { column: 'waiting_approval' });
    const taskB = await createTestTask(codespaceB.id, { column: 'waiting_approval' });

    state.setPendingPlan(taskA.id, {
      taskId: taskA.id,
      sessionId: sessionA.id,
      codespaceId: codespaceA.id,
      plan: 'Plan A',
      turnCount: 2,
      sdkSessionId: 'sdk-a',
      sandboxId: 'sandbox-a',
      createdAt: new Date(),
    });
    state.setPendingPlan(taskB.id, {
      taskId: taskB.id,
      sessionId: sessionB.id,
      codespaceId: codespaceB.id,
      plan: 'Plan B',
      turnCount: 2,
      sdkSessionId: 'sdk-b',
      sandboxId: 'sandbox-b',
      createdAt: new Date(),
    });

    providerGet.mockResolvedValue({ id: 'sandbox-a' });

    const result = await service.approvePlan(taskA.id);

    expect(result.ok).toBe(true);
    expect(providerGet).toHaveBeenCalledOnce();
    expect(providerGet).toHaveBeenCalledWith(codespaceA.id);
    expect(startAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        codespaceId: codespaceA.id,
        taskId: taskA.id,
        sessionId: sessionA.id,
        sdkSessionId: 'sdk-a',
      })
    );

    const dbTaskA = await db.query.tasks.findFirst({ where: eq(tasks.id, taskA.id) });
    const dbTaskB = await db.query.tasks.findFirst({ where: eq(tasks.id, taskB.id) });
    expect(dbTaskA?.column).toBe('in_progress');
    expect(dbTaskB?.column).toBe('waiting_approval');
    expect(state.hasPendingPlan(taskA.id)).toBe(false);
    expect(state.hasPendingPlan(taskB.id)).toBe(true);
  });

  it('provider lookup failure drops stale sdkSessionId but still starts execution from the approved plan', async () => {
    const codespace = await createTestProject({ name: 'Provider failure' });
    const session = await createTestSession(codespace.id);
    const task = await createTestTask(codespace.id, { column: 'waiting_approval' });

    state.setPendingPlan(task.id, {
      taskId: task.id,
      sessionId: session.id,
      codespaceId: codespace.id,
      plan: 'Execute after provider lookup failure',
      turnCount: 3,
      sdkSessionId: 'sdk-stale',
      sandboxId: 'sandbox-before-failure',
      createdAt: new Date(),
    });

    providerGet.mockRejectedValue(new Error('provider registry unavailable'));

    const result = await service.approvePlan(task.id);

    expect(result.ok).toBe(true);
    expect(startAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        codespaceId: codespace.id,
        taskId: task.id,
        sessionId: session.id,
        prompt: 'Execute after provider lookup failure',
        phase: 'execute',
        sdkSessionId: undefined,
      })
    );

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('in_progress');
    expect(streams.getEvents(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'container-agent:message',
          data: expect.objectContaining({
            taskId: task.id,
            role: 'approval',
          }),
        }),
      ])
    );
  });
});
