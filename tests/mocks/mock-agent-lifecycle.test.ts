import { describe, expect, it } from 'vitest';
import {
  createMockAgent,
  createMockAgentConfig,
  createMockAgentLifecycleScenario,
  createMockPendingPlan,
  createMockProject,
  createMockProjectConfig,
  createMockRunningAgent,
  createMockSession,
  createMockStartAgentInput,
  createMockTask,
  createMockWorktreeRecord,
} from './mock-agent-lifecycle';

describe('mock-agent-lifecycle', () => {
  describe('createMockStartAgentInput', () => {
    it('creates valid StartAgentInput with defaults', () => {
      const input = createMockStartAgentInput();
      expect(input.codespaceId).toBeTruthy();
      expect(input.taskId).toBeTruthy();
      expect(input.sessionId).toBeTruthy();
      expect(input.prompt).toBe('Fix the bug in the authentication module');
      expect(input.model).toBe('claude-sonnet-4-6');
      expect(input.maxTurns).toBe(50);
      expect(input.phase).toBe('plan');
    });

    it('accepts overrides', () => {
      const input = createMockStartAgentInput({
        prompt: 'Custom prompt',
        phase: 'execute',
        maxTurns: 100,
      });
      expect(input.prompt).toBe('Custom prompt');
      expect(input.phase).toBe('execute');
      expect(input.maxTurns).toBe(100);
    });
  });

  describe('createMockRunningAgent', () => {
    it('creates valid RunningAgent', () => {
      const agent = createMockRunningAgent();
      expect(agent.taskId).toBeTruthy();
      expect(agent.sessionId).toBeTruthy();
      expect(agent.codespaceId).toBeTruthy();
      expect(agent.sandboxId).toBe('sandbox-shared');
      expect(agent.bridge).toBeDefined();
      expect(agent.execResult).toBeDefined();
      expect(agent.stopFilePath).toContain('/tmp/.agent-stop-');
      expect(agent.stopRequested).toBe(false);
      expect(agent.phase).toBe('plan');
    });
  });

  describe('createMockPendingPlan', () => {
    it('creates valid PlanData', () => {
      const plan = createMockPendingPlan();
      expect(plan.taskId).toBeTruthy();
      expect(plan.sessionId).toBeTruthy();
      expect(plan.codespaceId).toBeTruthy();
      expect(plan.plan).toContain('# Implementation Plan');
      expect(plan.turnCount).toBe(5);
      expect(plan.sdkSessionId).toContain('sdk-session-');
      expect(plan.allowedPrompts).toHaveLength(2);
    });
  });

  describe('createMockAgentConfig', () => {
    it('creates valid AgentConfig', () => {
      const config = createMockAgentConfig();
      expect(config.allowedTools).toContain('Read');
      expect(config.allowedTools).toContain('Write');
      expect(config.maxTurns).toBe(50);
      expect(config.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('createMockProjectConfig', () => {
    it('creates valid ProjectConfig', () => {
      const config = createMockProjectConfig();
      expect(config.worktreeRoot).toBe('.worktrees');
      expect(config.defaultBranch).toBe('main');
      expect(config.allowedTools).toContain('Read');
      expect(config.maxTurns).toBe(50);
    });
  });

  describe('createMockProject', () => {
    it('creates valid Project', () => {
      const project = createMockProject();
      expect(project.id).toBeTruthy();
      expect(project.name).toBe('Mock Project');
      expect(project.path).toContain('/Users/test/projects/mock-project');
      expect(project.config).toBeDefined();
      expect(project.config?.worktreeRoot).toBe('.worktrees');
      expect(project.maxConcurrentAgents).toBe(3);
    });
  });

  describe('createMockTask', () => {
    it('creates valid Task', () => {
      const task = createMockTask();
      expect(task.id).toBeTruthy();
      expect(task.codespaceId).toBeTruthy();
      expect(task.title).toBe('Fix authentication bug');
      expect(task.column).toBe('backlog');
      expect(task.position).toBe(0);
      expect(task.labels).toEqual([]);
      expect(task.agentId).toBeNull();
      expect(task.sessionId).toBeNull();
      expect(task.worktreeId).toBeNull();
    });
  });

  describe('createMockAgent', () => {
    it('creates valid Agent', () => {
      const agent = createMockAgent();
      expect(agent.id).toBeTruthy();
      expect(agent.codespaceId).toBeTruthy();
      expect(agent.name).toBe('Container Agent');
      expect(agent.type).toBe('task');
      expect(agent.status).toBe('idle');
      expect(agent.config).toBeDefined();
      expect(agent.currentTaskId).toBeNull();
    });
  });

  describe('createMockSession', () => {
    it('creates valid Session', () => {
      const session = createMockSession();
      expect(session.id).toBeTruthy();
      expect(session.codespaceId).toBeTruthy();
      expect(session.status).toBe('active');
      expect(session.title).toBe('Container Agent Session');
      expect(session.url).toContain('/codespaces/');
      expect(session.closedAt).toBeNull();
    });
  });

  describe('createMockWorktreeRecord', () => {
    it('creates valid Worktree', () => {
      const worktree = createMockWorktreeRecord();
      expect(worktree.id).toBeTruthy();
      expect(worktree.codespaceId).toBeTruthy();
      expect(worktree.branch).toContain('agent/task/');
      expect(worktree.path).toContain('.worktrees/');
      expect(worktree.baseBranch).toBe('main');
      expect(worktree.status).toBe('active');
    });
  });

  describe('createMockAgentLifecycleScenario', () => {
    it('creates idle scenario', () => {
      const scenario = createMockAgentLifecycleScenario('idle');
      expect(scenario.project).toBeDefined();
      expect(scenario.agent.status).toBe('idle');
      expect(scenario.task.column).toBe('backlog');
      expect(scenario.session).toBeUndefined();
      expect(scenario.worktree).toBeUndefined();
      expect(scenario.plan).toBeUndefined();
    });

    it('creates planning scenario', () => {
      const scenario = createMockAgentLifecycleScenario('planning');
      expect(scenario.project).toBeDefined();
      expect(scenario.agent.status).toBe('planning');
      expect(scenario.task.column).toBe('in_progress');
      expect(scenario.session).toBeDefined();
      expect(scenario.session?.status).toBe('active');
      expect(scenario.worktree).toBeDefined();
      expect(scenario.worktree?.status).toBe('active');
    });

    it('creates executing scenario', () => {
      const scenario = createMockAgentLifecycleScenario('executing');
      expect(scenario.project).toBeDefined();
      expect(scenario.agent.status).toBe('running');
      expect(scenario.task.column).toBe('in_progress');
      expect(scenario.task.plan).toBeDefined();
      expect(scenario.task.lastAgentStatus).toBe('planning');
      expect(scenario.session).toBeDefined();
      expect(scenario.worktree).toBeDefined();
      expect(scenario.plan).toBeDefined();
    });

    it('creates waiting_approval scenario', () => {
      const scenario = createMockAgentLifecycleScenario('waiting_approval');
      expect(scenario.project).toBeDefined();
      expect(scenario.agent.status).toBe('idle');
      expect(scenario.task.column).toBe('waiting_approval');
      expect(scenario.task.completedAt).toBeDefined();
      expect(scenario.task.lastAgentStatus).toBe('completed');
      expect(scenario.session).toBeDefined();
      expect(scenario.session?.status).toBe('closed');
      expect(scenario.worktree).toBeDefined();
      expect(scenario.plan).toBeDefined();
      expect(scenario.diff).toBeDefined();
      expect(scenario.diff?.files).toHaveLength(2);
    });

    it('creates completed scenario', () => {
      const scenario = createMockAgentLifecycleScenario('completed');
      expect(scenario.project).toBeDefined();
      expect(scenario.agent.status).toBe('completed');
      expect(scenario.task.column).toBe('verified');
      expect(scenario.task.approvedAt).toBeDefined();
      expect(scenario.task.approvedBy).toBe('user-123');
      expect(scenario.session).toBeDefined();
      expect(scenario.session?.status).toBe('closed');
      expect(scenario.worktree).toBeDefined();
      expect(scenario.worktree?.status).toBe('merged');
    });

    it('uses consistent IDs across scenario entities', () => {
      const scenario = createMockAgentLifecycleScenario('executing');
      expect(scenario.task.codespaceId).toBe(scenario.project.id);
      expect(scenario.task.agentId).toBe(scenario.agent.id);
      expect(scenario.task.sessionId).toBe(scenario.session?.id);
      expect(scenario.task.worktreeId).toBe(scenario.worktree?.id);
      expect(scenario.agent.codespaceId).toBe(scenario.project.id);
      expect(scenario.session?.codespaceId).toBe(scenario.project.id);
      expect(scenario.worktree?.codespaceId).toBe(scenario.project.id);
    });
  });
});
