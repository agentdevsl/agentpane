import { vi } from 'vitest';
import { createContainerBridge } from '../../src/lib/agents/container-bridge';
import type { SandboxError } from '../../src/lib/errors/sandbox-errors';
import type { Result } from '../../src/lib/utils/result';
import { ok } from '../../src/lib/utils/result';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { StartAgentInput } from '../../src/services/container-agent/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { type CreateTaskInput, TaskService } from '../../src/services/task.service';
import type { Database } from '../../src/types/database';
import { createTestProject } from '../factories/project.factory';
import { enableSandboxDefaults } from '../factories/settings.factory';
import { getTestDb } from './database';
import {
  createInMemoryStreams,
  createMockContainerAgent,
  createMockWorktreeInit,
  createMockWorktreeService,
  type InMemoryStreamsServer,
  type MockWorktreeService,
} from './mocks';
import type { AgentRunnerStreamBuilder } from './streams';

type Db = ReturnType<typeof getTestDb>;
type StartAgentMock = ReturnType<
  typeof vi.fn<(input: StartAgentInput) => Promise<Result<void, SandboxError>>>
>;

export type PlanReadyData = {
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
};

export type LifecycleHarness = {
  db: Db;
  streams: DurableStreamsService & InMemoryStreamsServer;
  taskService: TaskService;
  planService: PlanApprovalService;
  stateManager: SandboxStateManager;
  worktreeService: MockWorktreeService;
  containerStartAgent: StartAgentMock;
  executionStartAgent: StartAgentMock;
  enableSandboxDefaults: () => Promise<void>;
  createCodespace: typeof createTestProject;
  createTask: (
    input: CreateTaskInput
  ) => Promise<Awaited<ReturnType<TaskService['create']>>['value']>;
  moveTaskToInProgress: (
    taskId: string
  ) => Promise<Awaited<ReturnType<TaskService['moveColumn']>>['value']>;
  startTask: (input: CreateTaskInput) => Promise<{
    createdTask: Awaited<ReturnType<TaskService['create']>>['value'];
    runningTask: Awaited<ReturnType<TaskService['moveColumn']>>['value']['task'];
    startInput: StartAgentInput;
  }>;
  handlePlanReady: (
    taskId: string,
    sessionId: string,
    codespaceId: string,
    planData: PlanReadyData
  ) => Promise<void>;
  processAgentRunnerStream: (
    taskId: string,
    sessionId: string,
    codespaceId: string,
    stream: AgentRunnerStreamBuilder
  ) => Promise<void>;
  approvePlan: (taskId: string) => Promise<Result<void, SandboxError>>;
  rejectPlan: (taskId: string, reason?: string) => Promise<Result<void, SandboxError>>;
  teardown: () => void;
};

function unwrapResult<T, E extends { message?: string }>(
  result: Result<T, E>,
  operation: string
): T {
  if (result.ok) return result.value;
  throw new Error(`${operation} failed: ${result.error.message ?? String(result.error)}`);
}

export function createLifecycleHarness(
  options: {
    db?: Db;
    streams?: DurableStreamsService & InMemoryStreamsServer;
    worktreeService?: MockWorktreeService;
  } = {}
): LifecycleHarness {
  const db = options.db ?? getTestDb();
  const streams =
    options.streams ?? (createInMemoryStreams() as DurableStreamsService & InMemoryStreamsServer);
  const worktreeService = options.worktreeService ?? createMockWorktreeService();
  const stateManager = new SandboxStateManager();
  const taskService = new TaskService(db as Database, worktreeService);

  const containerStartAgent = vi.fn(async (_input: StartAgentInput) => ok(undefined));
  const executionStartAgent = vi.fn(async (_input: StartAgentInput) => ok(undefined));

  taskService.setContainerAgentService(
    createMockContainerAgent({
      startAgent: containerStartAgent,
      isAgentRunning: vi.fn(() => false),
    })
  );

  const planService = new PlanApprovalService(
    {
      db: db as Database,
      streams,
      provider: { get: vi.fn(async () => null) } as never,
    },
    stateManager,
    createMockWorktreeInit() as never,
    executionStartAgent,
    () => false
  );

  const harness: LifecycleHarness = {
    db,
    streams,
    taskService,
    planService,
    stateManager,
    worktreeService,
    containerStartAgent,
    executionStartAgent,
    enableSandboxDefaults: async () => {
      await enableSandboxDefaults();
    },
    createCodespace: createTestProject,
    createTask: async (input) => unwrapResult(await taskService.create(input), 'create task'),
    moveTaskToInProgress: async (taskId) =>
      unwrapResult(await taskService.moveColumn(taskId, 'in_progress'), 'move task to in_progress'),
    startTask: async (input) => {
      await enableSandboxDefaults();
      const createdTask = unwrapResult(await taskService.create(input), 'create task');
      const moveResult = unwrapResult(
        await taskService.moveColumn(createdTask.id, 'in_progress'),
        'move task to in_progress'
      );
      const startInput = containerStartAgent.mock.calls.at(-1)?.[0];
      if (!startInput) {
        throw new Error('Expected container startAgent to be called');
      }
      return { createdTask, runningTask: moveResult.task, startInput };
    },
    handlePlanReady: (taskId, sessionId, codespaceId, planData) =>
      planService.handlePlanReady(taskId, sessionId, codespaceId, planData),
    processAgentRunnerStream: async (taskId, sessionId, codespaceId, stream) => {
      const planPromises: Promise<void>[] = [];
      const bridge = createContainerBridge({
        taskId,
        sessionId,
        codespaceId,
        streams,
        onComplete: vi.fn(),
        onError: vi.fn(),
        onPlanReady: (planData) => {
          planPromises.push(planService.handlePlanReady(taskId, sessionId, codespaceId, planData));
        },
      });
      await bridge.processStream(stream.build());
      await Promise.all(planPromises);
    },
    approvePlan: (taskId) => planService.approvePlan(taskId),
    rejectPlan: (taskId, reason) => planService.rejectPlan(taskId, reason),
    teardown: () => {
      stateManager.dispose();
    },
  };

  return harness;
}
