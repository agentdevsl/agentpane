import { Readable } from 'node:stream';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, sessionEvents, sessions, tasks, worktrees } from '../../src/db/schema';
import type { Sandbox, SandboxProvider } from '../../src/lib/sandbox/providers/sandbox-provider';
import type { ApiKeyService } from '../../src/services/api-key.service';
import { createContainerAgentService } from '../../src/services/container-agent.service';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import type { Database } from '../../src/types/database';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams } from '../helpers/mocks';

function createRunningSandbox(codespaceId: string, overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    id: `sandbox-${codespaceId}`,
    codespaceId,
    containerId: `container-${codespaceId}`,
    status: 'running',
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    execAsRoot: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    createTmuxSession: vi.fn(async (sessionName: string) => ({
      name: sessionName,
      sandboxId: `sandbox-${codespaceId}`,
      createdAt: new Date().toISOString(),
      windowCount: 1,
      attached: false,
    })),
    listTmuxSessions: vi.fn(async () => []),
    killTmuxSession: vi.fn(async () => undefined),
    sendKeysToTmux: vi.fn(async () => undefined),
    captureTmuxPane: vi.fn(async () => ''),
    stop: vi.fn(async () => undefined),
    getMetrics: vi.fn(async () => ({
      cpuUsagePercent: 0,
      memoryUsageMb: 0,
      memoryLimitMb: 8192,
      diskUsageMb: 0,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptime: 0,
    })),
    touch: vi.fn(),
    getLastActivity: vi.fn(() => new Date()),
    execStream: vi.fn(async () => ({
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      wait: async () => ({ exitCode: 0 }),
      kill: vi.fn(),
    })),
    writeFile: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createNoopProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    name: 'test-provider',
    create: vi.fn(async (config) => createRunningSandbox(config.codespaceId)),
    get: vi.fn(async () => null),
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    recover: vi.fn(async () => ({ recovered: 0, removed: 0 })),
    pullImage: vi.fn(async () => undefined),
    isImageAvailable: vi.fn(async () => true),
    healthCheck: vi.fn(async () => ({ healthy: true })),
    cleanup: vi.fn(async () => 0),
    ...overrides,
  };
}

function createNoopApiKeyService(): Pick<
  ApiKeyService,
  'getDecryptedKey' | 'getDecryptedRefreshToken'
> {
  return {
    getDecryptedKey: vi.fn(async () => null),
    getDecryptedRefreshToken: vi.fn(async () => null),
  };
}

function createService(params: {
  db: ReturnType<typeof getTestDb>;
  provider?: SandboxProvider;
  streams?: DurableStreamsService;
  apiKeyService?: Pick<ApiKeyService, 'getDecryptedKey' | 'getDecryptedRefreshToken'>;
}) {
  return createContainerAgentService(
    params.db as unknown as Database,
    params.provider ?? createNoopProvider(),
    params.streams ?? createInMemoryStreams(),
    (params.apiKeyService ?? createNoopApiKeyService()) as unknown as ApiKeyService
  );
}

function clearAnthropicEnv(): () => void {
  const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;

  return () => {
    if (previousAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
    }
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  };
}

describe('ContainerAgentService — DB-level integration tests', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-101: tracks task in_progress and agent running state via DB', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const task = await createTestTask(project.id, { column: 'in_progress' });
    const agent = await createTestAgent(project.id, {
      status: 'running',
      currentTaskId: task.id,
    });

    // Update task with agent reference
    await db.update(tasks).set({ agentId: agent.id }).where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });

    expect(dbTask?.column).toBe('in_progress');
    expect(dbTask?.agentId).toBe(agent.id);
    expect(dbAgent?.status).toBe('running');
    expect(dbAgent?.currentTaskId).toBe(task.id);
  });

  it('IT-102: simulates worktree creation and updates task.worktreeId', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });
    const worktree = await createTestWorktree(project.id, { taskId: task.id });

    // Simulate worktree assignment on task
    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.worktreeId).toBe(worktree.id);
    expect(dbTask?.branch).toBe(worktree.branch);

    const dbWorktree = await db.query.worktrees.findFirst({ where: eq(worktrees.id, worktree.id) });
    expect(dbWorktree?.taskId).toBe(task.id);
    expect(dbWorktree?.status).toBe('active');
  });

  it('IT-103: differentiates sandbox providers via session sandboxProvider field', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const task1 = await createTestTask(project.id, { column: 'in_progress' });
    const task2 = await createTestTask(project.id, { column: 'in_progress' });

    const session1 = await createTestSession(project.id, { taskId: task1.id });
    const session2 = await createTestSession(project.id, { taskId: task2.id });

    // Simulate setting sandbox provider on sessions
    await db
      .update(sessions)
      .set({ sandboxProvider: 'docker' })
      .where(eq(sessions.id, session1.id));
    await db
      .update(sessions)
      .set({ sandboxProvider: 'agentcore' })
      .where(eq(sessions.id, session2.id));

    const dbSession1 = await db.query.sessions.findFirst({ where: eq(sessions.id, session1.id) });
    const dbSession2 = await db.query.sessions.findFirst({ where: eq(sessions.id, session2.id) });

    expect(dbSession1?.sandboxProvider).toBe('docker');
    expect(dbSession2?.sandboxProvider).toBe('agentcore');
  });

  it('IT-104: simulates agent stop — clears currentTaskId and sets status to idle', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });
    const agent = await createTestAgent(project.id, {
      status: 'running',
      currentTaskId: task.id,
    });

    // Simulate agent stop
    await db
      .update(agents)
      .set({ currentTaskId: null, currentSessionId: null, status: 'idle', currentTurn: 0 })
      .where(eq(agents.id, agent.id));

    const dbAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(dbAgent?.status).toBe('idle');
    expect(dbAgent?.currentTaskId).toBeNull();
    expect(dbAgent?.currentSessionId).toBeNull();
    expect(dbAgent?.currentTurn).toBe(0);
  });

  it('IT-105: identifies running agents via status check (starting, planning, running)', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    await createTestAgent(project.id, { status: 'starting' });
    await createTestAgent(project.id, { status: 'planning' });
    await createTestAgent(project.id, { status: 'running' });
    await createTestAgent(project.id, { status: 'idle' });
    await createTestAgent(project.id, { status: 'error' });
    await createTestAgent(project.id, { status: 'completed' });

    const allAgents = await db.query.agents.findMany({
      where: eq(agents.codespaceId, project.id),
    });

    const runningStatuses = new Set(['starting', 'planning', 'running']);
    const isRunning = allAgents.filter((a) => runningStatuses.has(a.status));

    expect(isRunning).toHaveLength(3);
    expect(isRunning.map((a) => a.status).sort()).toEqual(['planning', 'running', 'starting']);
  });

  it('IT-106: simulates plan approval — task moves from waiting_approval to in_progress', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
    });

    // Set plan data on the task
    await db
      .update(tasks)
      .set({
        plan: 'Step 1: Implement feature\nStep 2: Write tests',
        planOptions: { allowedPrompts: [] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Simulate approval: move to in_progress
    await db.update(tasks).set({ column: 'in_progress' }).where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('in_progress');
    expect(dbTask?.plan).toBeTruthy();
    expect(dbTask?.planOptions).toBeTruthy();
  });

  it('IT-107: simulates plan rejection — clears plan data and moves to backlog', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
    });

    await db
      .update(tasks)
      .set({
        plan: 'Some plan content',
        planOptions: { allowedPrompts: [] },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id));

    // Simulate rejection
    await db
      .update(tasks)
      .set({
        column: 'backlog',
        plan: null,
        planOptions: null,
        lastAgentStatus: null,
        rejectionReason: 'Plan was insufficient',
        rejectionCount: 1,
      })
      .where(eq(tasks.id, task.id));

    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask?.column).toBe('backlog');
    expect(dbTask?.plan).toBeNull();
    expect(dbTask?.planOptions).toBeNull();
    expect(dbTask?.lastAgentStatus).toBeNull();
    expect(dbTask?.rejectionReason).toBe('Plan was insufficient');
    expect(dbTask?.rejectionCount).toBe(1);
  });

  it('IT-108: reconciles orphaned in_progress tasks — moves those without healthy agents to backlog', async () => {
    const db = getTestDb();
    const project = await createTestProject();

    const agentHealthy = await createTestAgent(project.id, { status: 'running' });
    const agentDead = await createTestAgent(project.id, { status: 'error' });

    const session1 = await createTestSession(project.id, { agentId: agentHealthy.id });
    const session2 = await createTestSession(project.id, { agentId: agentDead.id });

    const task1 = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agentHealthy.id,
      sessionId: session1.id,
    });
    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agentDead.id,
      sessionId: session2.id,
    });
    await createTestTask(project.id, {
      column: 'in_progress',
      agentId: null,
    });

    // Reconcile: find orphaned tasks
    const inProgressTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.column, 'in_progress'), eq(tasks.codespaceId, project.id)),
    });
    expect(inProgressTasks).toHaveLength(3);

    const taskAgentIds = inProgressTasks.map((t) => t.agentId).filter(Boolean) as string[];
    const taskAgents =
      taskAgentIds.length > 0
        ? await db.query.agents.findMany({ where: inArray(agents.id, taskAgentIds) })
        : [];

    const healthyIds = new Set(
      taskAgents.filter((a) => a.status === 'running' || a.status === 'planning').map((a) => a.id)
    );

    const orphaned = inProgressTasks.filter((t) => !t.agentId || !healthyIds.has(t.agentId));
    expect(orphaned).toHaveLength(2); // task2 (dead agent) + task3 (no agent)

    for (const o of orphaned) {
      await db
        .update(tasks)
        .set({ column: 'backlog', agentId: null, sessionId: null })
        .where(eq(tasks.id, o.id));
    }

    const remaining = await db.query.tasks.findMany({
      where: and(eq(tasks.column, 'in_progress'), eq(tasks.codespaceId, project.id)),
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(task1.id);
  });

  it('IT-108b: reconcile flushes orphaned tool starts through the real container-agent service', async () => {
    const db = getTestDb();
    const streams = createInMemoryStreams();
    const project = await createTestProject();
    const task = await createTestTask(project.id, {
      column: 'in_progress',
      lastAgentStatus: 'running',
    });
    const session = await createTestSession(project.id, { taskId: task.id });

    await db.insert(sessionEvents).values([
      {
        sessionId: session.id,
        streamKind: 'session',
        offset: 0,
        type: 'container-agent:tool:start',
        channel: 'toolCalls',
        data: { toolId: 'tool-orphaned', toolName: 'Bash' },
        timestamp: 1_000,
      },
      {
        sessionId: session.id,
        streamKind: 'session',
        offset: 1,
        type: 'container-agent:tool:start',
        channel: 'toolCalls',
        data: { toolId: 'tool-finished', toolName: 'Read' },
        timestamp: 2_000,
      },
      {
        sessionId: session.id,
        streamKind: 'session',
        offset: 2,
        type: 'container-agent:tool:result',
        channel: 'toolCalls',
        data: { toolId: 'tool-finished', result: 'ok', isError: false },
        timestamp: 2_100,
      },
    ]);

    const service = createContainerAgentService(
      db as unknown as Database,
      createNoopProvider(),
      streams as unknown as DurableStreamsService,
      createNoopApiKeyService() as unknown as ApiKeyService
    );

    await service.reconcile();

    const reconciledTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(reconciledTask?.column).toBe('backlog');
    expect(reconciledTask?.lastAgentStatus).toBeNull();

    const syntheticResults = streams
      .getEvents(session.id)
      .filter((event) => event.type === 'container-agent:tool:result');
    expect(syntheticResults).toHaveLength(1);
    expect(syntheticResults[0]?.data).toMatchObject({
      taskId: task.id,
      sessionId: session.id,
      toolId: 'tool-orphaned',
      toolName: 'Bash',
      isError: true,
      durationMs: 0,
    });

    service.dispose();
  });

  it('IT-109: deleting agents sets null on dangling task references', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'running' });
    const task = await createTestTask(project.id, {
      column: 'in_progress',
      agentId: agent.id,
    });

    // Delete the agent
    await db.delete(agents).where(eq(agents.id, agent.id));

    // Task's agentId should be set null via FK onDelete: 'set null'
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask).toBeTruthy();
    expect(dbTask?.agentId).toBeNull();
  });

  it('IT-110: detects existing agent assignment when starting a second time', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const agent1 = await createTestAgent(project.id, {
      status: 'running',
      currentTaskId: task.id,
    });
    await db.update(tasks).set({ agentId: agent1.id }).where(eq(tasks.id, task.id));

    // Second start attempt: check if task already has an agent
    const existingTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(existingTask?.agentId).toBe(agent1.id);

    // Verify the existing agent is still running
    const existingAgent = existingTask?.agentId
      ? await db.query.agents.findFirst({ where: eq(agents.id, existingTask.agentId) })
      : null;
    expect(existingAgent?.status).toBe('running');
    expect(existingAgent?.currentTaskId).toBe(task.id);
  });

  it('IT-111: tracks error state via lastAgentStatus on the task', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const errorStatuses = ['error', 'turn_limit', 'cancelled'] as const;
    for (const status of errorStatuses) {
      await db.update(tasks).set({ lastAgentStatus: status }).where(eq(tasks.id, task.id));

      const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(dbTask?.lastAgentStatus).toBe(status);
    }
  });

  it('IT-112: stores sandbox provider name on the session record', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const agent = await createTestAgent(project.id, { status: 'running' });
    const task = await createTestTask(project.id, { column: 'in_progress', agentId: agent.id });

    const session = await createTestSession(project.id, {
      taskId: task.id,
      agentId: agent.id,
    });

    // Store provider and container ID on session
    await db
      .update(sessions)
      .set({
        sandboxProvider: 'docker',
        sandboxContainerId: 'container-abc123',
      })
      .where(eq(sessions.id, session.id));

    const dbSession = await db.query.sessions.findFirst({ where: eq(sessions.id, session.id) });
    expect(dbSession?.sandboxProvider).toBe('docker');
    expect(dbSession?.sandboxContainerId).toBe('container-abc123');
    expect(dbSession?.taskId).toBe(task.id);
    expect(dbSession?.agentId).toBe(agent.id);
  });

  it('IT-113: startAgent persists session and status events before failing at missing OAuth boundary', async () => {
    const restoreEnv = clearAnthropicEnv();
    const db = getTestDb();
    const streams = createInMemoryStreams();
    const project = await createTestProject({ path: '/workspace/project' });
    const task = await createTestTask(project.id, {
      title: 'Run real facade path',
      column: 'in_progress',
    });
    const sandbox = createRunningSandbox(project.id);
    const provider = createNoopProvider({
      get: vi.fn(async () => sandbox),
    });
    const service = createService({
      db,
      provider,
      streams: streams as unknown as DurableStreamsService,
    });

    try {
      const result = await service.startAgent({
        codespaceId: project.id,
        taskId: task.id,
        sessionId: 'session-real-start',
        prompt: 'Implement the thing',
        phase: 'plan',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_API_KEY_NOT_CONFIGURED');
      }

      const dbSession = await db.query.sessions.findFirst({
        where: eq(sessions.id, 'session-real-start'),
      });
      expect(dbSession).toMatchObject({
        codespaceId: project.id,
        taskId: task.id,
        agentId: `agent-${task.id}`,
        sandboxProvider: 'test-provider',
        sandboxContainerId: sandbox.containerId,
      });

      const dbAgent = await db.query.agents.findFirst({
        where: eq(agents.id, `agent-${task.id}`),
      });
      expect(dbAgent).toMatchObject({
        codespaceId: project.id,
        currentTaskId: task.id,
        currentSessionId: 'session-real-start',
        status: 'starting',
      });

      expect(streams.getEvents('session-real-start').map((event) => event.type)).toEqual([
        'container-agent:status',
        'container-agent:status',
        'container-agent:message',
        'container-agent:message',
        'container-agent:status',
        'container-agent:message',
        'container-agent:message',
      ]);
      expect(service.isAgentRunning(task.id)).toBe(false);
    } finally {
      service.dispose();
      restoreEnv();
    }
  });

  it('IT-114: approvePlan recovers DB-backed plan and rolls task back when execution cannot start', async () => {
    const restoreEnv = clearAnthropicEnv();
    const db = getTestDb();
    const streams = createInMemoryStreams();
    const project = await createTestProject({ path: '/workspace/project' });
    await createTestSession(project.id, { id: 'session-plan-recovered' });
    const task = await createTestTask(project.id, {
      column: 'waiting_approval',
      plan: 'Approved plan from a previous process',
      planOptions: {
        sdkSessionId: 'sdk-recovered',
        allowedPrompts: [{ tool: 'Bash', prompt: 'bun test' }],
      },
      lastAgentStatus: 'planning',
      sessionId: 'session-plan-recovered',
    });
    const provider = createNoopProvider({
      get: vi.fn(async () => createRunningSandbox(project.id)),
    });
    const service = createService({
      db,
      provider,
      streams: streams as unknown as DurableStreamsService,
    });

    try {
      const recovered = await service.getPendingPlan(task.id);
      expect(recovered).toMatchObject({
        taskId: task.id,
        sessionId: 'session-plan-recovered',
        codespaceId: project.id,
        plan: 'Approved plan from a previous process',
        sdkSessionId: 'sdk-recovered',
        allowedPrompts: [{ tool: 'Bash', prompt: 'bun test' }],
      });

      const result = await service.approvePlan(task.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_API_KEY_NOT_CONFIGURED');
      }

      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter).toMatchObject({
        column: 'waiting_approval',
        lastAgentStatus: 'planning',
        plan: 'Approved plan from a previous process',
      });
      expect(streams.getEvents('session-plan-recovered')).toContainEqual(
        expect.objectContaining({
          type: 'container-agent:message',
          data: expect.objectContaining({
            role: 'approval',
            content: 'Plan approved by user. Starting execution phase.',
          }),
        })
      );
      expect(await service.getPendingPlan(task.id)).toMatchObject({
        sdkSessionId: 'sdk-recovered',
      });
    } finally {
      service.dispose();
      restoreEnv();
    }
  });
});
