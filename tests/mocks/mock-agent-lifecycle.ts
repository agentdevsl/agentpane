/**
 * Mock builders for agent lifecycle and execution testing.
 *
 * Provides type-safe mock builders for the full agent lifecycle flow:
 * Task move → Agent start → Plan → Approve → Execute → Complete
 */
import { createId } from '@paralleldrive/cuid2';
import type {
  Agent,
  AgentConfig,
  Codespace,
  CodespaceConfig,
  Session,
  Task,
  TaskColumn,
  Worktree,
  WorktreeStatus,
} from '../../src/db/schema';
import type {
  AgentPhase,
  PlanData,
  StartAgentInput,
} from '../../src/services/container-agent.service';

/**
 * Internal RunningAgent interface from ContainerAgentService.
 * This is the in-memory state tracked for active agents.
 */
export interface RunningAgent {
  taskId: string;
  sessionId: string;
  codespaceId: string;
  sandboxId: string;
  bridge: MockContainerBridge;
  execResult: MockExecResult;
  stopFilePath: string;
  startedAt: Date;
  stopRequested: boolean;
  phase: AgentPhase;
  worktreeId?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Mock ContainerBridge for testing.
 */
export interface MockContainerBridge {
  processLine: (line: string) => void;
  processStream: (stream: AsyncIterable<string>) => Promise<void>;
  processStderr: (stream: AsyncIterable<string>) => void;
}

/**
 * Mock exec result for testing.
 */
export interface MockExecResult {
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  wait: () => Promise<{ exitCode: number }>;
  kill: () => Promise<void>;
}

/**
 * Create a mock StartAgentInput with sensible defaults.
 */
export function createMockStartAgentInput(overrides?: Partial<StartAgentInput>): StartAgentInput {
  return {
    codespaceId: createId(),
    taskId: createId(),
    sessionId: createId(),
    prompt: 'Fix the bug in the authentication module',
    model: 'claude-sonnet-4-6',
    maxTurns: 50,
    phase: 'plan',
    ...overrides,
  };
}

/**
 * Create a mock RunningAgent with defaults.
 * Process has mock kill(). Bridge has mock processLine().
 */
export function createMockRunningAgent(overrides?: Partial<RunningAgent>): RunningAgent {
  const taskId = createId();
  const sessionId = createId();
  const codespaceId = createId();

  const mockExecResult: MockExecResult = {
    stdout: (async function* () {
      yield JSON.stringify({ type: 'agent:started', taskId });
    })(),
    stderr: (async function* () {})(),
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  };

  const mockBridge: MockContainerBridge = {
    processLine: () => {},
    processStream: async () => {},
    processStderr: () => {},
  };

  return {
    taskId,
    sessionId,
    codespaceId,
    sandboxId: 'sandbox-shared',
    bridge: mockBridge,
    execResult: mockExecResult,
    stopFilePath: `/tmp/.agent-stop-${taskId}`,
    startedAt: new Date(),
    stopRequested: false,
    phase: 'plan',
    ...overrides,
  };
}

/**
 * Create a mock PlanData with default plan text and sdkSessionId.
 */
export function createMockPendingPlan(overrides?: Partial<PlanData>): PlanData {
  const taskId = createId();
  return {
    taskId,
    sessionId: createId(),
    codespaceId: createId(),
    plan: `# Implementation Plan

## Overview
Fix authentication bug by updating token validation logic.

## Steps
1. Review current authentication flow
2. Update token expiry check
3. Add integration tests
4. Deploy to staging`,
    turnCount: 5,
    sdkSessionId: `sdk-session-${createId()}`,
    allowedPrompts: [
      { tool: 'Bash', prompt: 'npm test' },
      { tool: 'Bash', prompt: 'git status' },
    ],
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a mock AgentConfig with default tools and maxTurns.
 */
export function createMockAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    model: 'claude-sonnet-4-6',
    temperature: 1.0,
    ...overrides,
  };
}

/**
 * Create a mock ProjectConfig with realistic defaults.
 */
export function createMockProjectConfig(overrides?: Partial<CodespaceConfig>): CodespaceConfig {
  return {
    worktreeRoot: '.worktrees',
    defaultBranch: 'main',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 50,
    model: 'claude-sonnet-4-6',
    initScript: 'npm install',
    envFile: '.env',
    temperature: 1.0,
    ...overrides,
  };
}

/**
 * Create a mock Project matching the DB schema shape.
 * Includes realistic config with worktreeRoot, defaultBranch, allowedTools, maxTurns.
 */
export function createMockProject(overrides?: Partial<Codespace>): Codespace {
  const now = new Date().toISOString();
  return {
    id: createId(),
    name: 'Mock Project',
    path: '/Users/test/projects/mock-project',
    description: 'A mock project for testing',
    config: createMockProjectConfig(),
    maxConcurrentAgents: 3,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
    sandboxConfigId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a mock Task matching DB schema.
 * Includes all nullable fields explicitly set.
 */
export function createMockTask(overrides?: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: createId(),
    codespaceId: createId(),
    agentId: null,
    sessionId: null,
    worktreeId: null,
    title: 'Fix authentication bug',
    description: 'Update token validation to handle edge cases',
    column: 'backlog' as TaskColumn,
    position: 0,
    labels: [],
    priority: 'medium',
    branch: null,
    diffSummary: null,
    approvedAt: null,
    approvedBy: null,
    rejectionCount: 0,
    rejectionReason: null,
    modelOverride: null,
    planOptions: null,
    plan: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    lastAgentStatus: null,
    ...overrides,
  };
}

/**
 * Create a mock Agent matching DB schema.
 * Includes config.
 */
export function createMockAgent(overrides?: Partial<Agent>): Agent {
  const now = new Date().toISOString();
  return {
    id: createId(),
    codespaceId: createId(),
    name: 'Container Agent',
    type: 'task',
    status: 'idle',
    config: createMockAgentConfig(),
    currentTaskId: null,
    currentSessionId: null,
    currentTurn: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Create a mock Session matching DB schema.
 */
export function createMockSession(overrides?: Partial<Session>): Session {
  const sessionId = createId();
  const now = new Date().toISOString();
  return {
    id: sessionId,
    codespaceId: createId(),
    taskId: null,
    agentId: null,
    status: 'active',
    title: 'Container Agent Session',
    url: `/codespaces/${createId()}/sessions/${sessionId}`,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    ...overrides,
  };
}

/**
 * Create a mock Worktree DB record (not the service, the DB row).
 */
export function createMockWorktreeRecord(overrides?: Partial<Worktree>): Worktree {
  const now = new Date().toISOString();
  return {
    id: createId(),
    codespaceId: createId(),
    agentId: null,
    taskId: null,
    branch: `agent/task/${createId()}`,
    path: `/Users/test/projects/mock-project/.worktrees/agent-task-${createId()}`,
    baseBranch: 'main',
    status: 'active' as WorktreeStatus,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    removedAt: null,
    ...overrides,
  };
}

/**
 * Scenario data returned by createMockAgentLifecycleScenario.
 */
export interface AgentLifecycleScenario {
  project: Project;
  agent: Agent;
  task: Task;
  session?: Session;
  worktree?: Worktree;
  plan?: PlanData;
  diff?: {
    files: Array<{ path: string; additions: number; deletions: number }>;
    summary: { filesChanged: number; additions: number; deletions: number };
  };
}

/**
 * Create a full set of interconnected mocks for common test scenarios.
 *
 * Scenarios:
 * - 'idle': Project + idle agent + backlog task
 * - 'planning': Project + planning agent + in_progress task + active session + active worktree
 * - 'executing': Project + running agent + in_progress task + active session + active worktree + plan
 * - 'waiting_approval': Project + idle agent + waiting_approval task + closed session + active worktree + plan + diff
 * - 'completed': Project + completed agent + verified task + closed session + merged worktree
 */
export function createMockAgentLifecycleScenario(
  scenario: 'idle' | 'planning' | 'executing' | 'waiting_approval' | 'completed'
): AgentLifecycleScenario {
  const codespaceId = createId();
  const agentId = createId();
  const taskId = createId();
  const sessionId = createId();
  const worktreeId = createId();

  const project = createMockProject({ id: codespaceId });

  switch (scenario) {
    case 'idle': {
      const agent = createMockAgent({
        id: agentId,
        codespaceId,
        status: 'idle',
        currentTaskId: null,
        currentSessionId: null,
      });

      const task = createMockTask({
        id: taskId,
        codespaceId,
        column: 'backlog',
        agentId: null,
        sessionId: null,
        worktreeId: null,
      });

      return { project, agent, task };
    }

    case 'planning': {
      const agent = createMockAgent({
        id: agentId,
        codespaceId,
        status: 'planning',
        currentTaskId: taskId,
        currentSessionId: sessionId,
      });

      const session = createMockSession({
        id: sessionId,
        codespaceId,
        taskId,
        agentId,
        status: 'active',
        title: 'Planning: Fix authentication bug',
      });

      const worktree = createMockWorktreeRecord({
        id: worktreeId,
        codespaceId,
        agentId,
        taskId,
        status: 'active',
      });

      const task = createMockTask({
        id: taskId,
        codespaceId,
        column: 'in_progress',
        agentId,
        sessionId,
        worktreeId,
        startedAt: new Date().toISOString(),
      });

      return { project, agent, task, session, worktree };
    }

    case 'executing': {
      const plan = createMockPendingPlan({
        taskId,
        sessionId,
        codespaceId,
      });

      const agent = createMockAgent({
        id: agentId,
        codespaceId,
        status: 'running',
        currentTaskId: taskId,
        currentSessionId: sessionId,
      });

      const session = createMockSession({
        id: sessionId,
        codespaceId,
        taskId,
        agentId,
        status: 'active',
        title: 'Executing: Fix authentication bug',
      });

      const worktree = createMockWorktreeRecord({
        id: worktreeId,
        codespaceId,
        agentId,
        taskId,
        status: 'active',
      });

      const task = createMockTask({
        id: taskId,
        codespaceId,
        column: 'in_progress',
        agentId,
        sessionId,
        worktreeId,
        plan: plan.plan,
        planOptions: {
          sdkSessionId: plan.sdkSessionId,
          allowedPrompts: plan.allowedPrompts,
        },
        lastAgentStatus: 'planning',
        startedAt: new Date().toISOString(),
      });

      return { project, agent, task, session, worktree, plan };
    }

    case 'waiting_approval': {
      const plan = createMockPendingPlan({
        taskId,
        sessionId,
        codespaceId,
      });

      const agent = createMockAgent({
        id: agentId,
        codespaceId,
        status: 'idle',
        currentTaskId: null,
        currentSessionId: null,
      });

      const session = createMockSession({
        id: sessionId,
        codespaceId,
        taskId,
        agentId,
        status: 'closed',
        title: 'Completed: Fix authentication bug',
        closedAt: new Date().toISOString(),
      });

      const worktree = createMockWorktreeRecord({
        id: worktreeId,
        codespaceId,
        agentId,
        taskId,
        status: 'active',
      });

      const diff = {
        files: [
          { path: 'src/auth/token-validator.ts', additions: 15, deletions: 8 },
          { path: 'tests/auth/token-validator.test.ts', additions: 42, deletions: 0 },
        ],
        summary: { filesChanged: 2, additions: 57, deletions: 8 },
      };

      const task = createMockTask({
        id: taskId,
        codespaceId,
        column: 'waiting_approval',
        agentId: null,
        sessionId: null,
        worktreeId,
        plan: plan.plan,
        planOptions: {
          sdkSessionId: plan.sdkSessionId,
          allowedPrompts: plan.allowedPrompts,
        },
        diffSummary: diff.summary,
        lastAgentStatus: 'completed',
        startedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        completedAt: new Date().toISOString(),
      });

      return { project, agent, task, session, worktree, plan, diff };
    }

    case 'completed': {
      const agent = createMockAgent({
        id: agentId,
        codespaceId,
        status: 'completed',
        currentTaskId: null,
        currentSessionId: null,
      });

      const session = createMockSession({
        id: sessionId,
        codespaceId,
        taskId,
        agentId,
        status: 'closed',
        title: 'Completed: Fix authentication bug',
        closedAt: new Date().toISOString(),
      });

      const worktree = createMockWorktreeRecord({
        id: worktreeId,
        codespaceId,
        agentId,
        taskId,
        status: 'merged',
        mergedAt: new Date().toISOString(),
      });

      const task = createMockTask({
        id: taskId,
        codespaceId,
        column: 'verified',
        agentId: null,
        sessionId: null,
        worktreeId: null,
        branch: worktree.branch,
        diffSummary: {
          filesChanged: 2,
          additions: 57,
          deletions: 8,
        },
        lastAgentStatus: 'completed',
        approvedAt: new Date().toISOString(),
        approvedBy: 'user-123',
        startedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        completedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      });

      return { project, agent, task, session, worktree };
    }
  }
}
