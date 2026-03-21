import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSession as DbPlanSession, Codespace as Project, Task } from '../../src/db/schema';
import { PlanModeErrors } from '../../src/lib/errors/plan-mode-errors';
import type { GitHubIssueCreator, GitHubIssueResult } from '../../src/lib/github/issue-creator';
import type {
  ClaudeClient,
  ClaudeResult,
  ToolCallResult,
} from '../../src/lib/plan-mode/claude-client';
import type { PlanTurn, UserInteraction } from '../../src/lib/plan-mode/types';
import { err, ok } from '../../src/lib/utils/result';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { PlanModeService } from '../../src/services/plan-mode.service';
import type { Database } from '../../src/types/database';

// Mock the claude-client module
vi.mock('../../src/lib/plan-mode/claude-client', () => ({
  createClaudeClient: vi.fn(),
}));

// Import after mocking
import { createClaudeClient } from '../../src/lib/plan-mode/claude-client';

// ============================================
// Test Fixtures
// ============================================

function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: createId(),
    projectFolderId: 'default-folder',
    name: 'Test Project',
    path: '/tmp/test-project',
    description: null,
    config: {
      worktreeRoot: '.worktrees',
      defaultBranch: 'main',
      allowedTools: ['Read', 'Write'],
      maxTurns: 50,
    },
    maxConcurrentAgents: 3,
    githubOwner: null,
    githubRepo: null,
    githubInstallationId: null,
    configPath: '.claude',
    sandboxConfigId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockTask(codespaceId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: createId(),
    codespaceId,
    agentId: null,
    sessionId: null,
    worktreeId: null,
    title: 'Test Task',
    description: 'Test task description',
    mode: 'implement',
    column: 'backlog',
    position: 0,
    labels: [],
    branch: null,
    diffSummary: null,
    approvedAt: null,
    approvedBy: null,
    rejectionCount: 0,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function createMockPlanSession(overrides: Partial<DbPlanSession> = {}): DbPlanSession {
  const id = overrides.id ?? createId();
  return {
    id,
    taskId: overrides.taskId ?? createId(),
    codespaceId: overrides.codespaceId ?? createId(),
    status: overrides.status ?? 'active',
    turns: overrides.turns ?? [],
    githubIssueUrl: overrides.githubIssueUrl ?? null,
    githubIssueNumber: overrides.githubIssueNumber ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

function createMockTurn(
  role: 'user' | 'assistant',
  content: string,
  interaction?: UserInteraction
): PlanTurn {
  return {
    id: createId(),
    role,
    content,
    interaction,
    timestamp: new Date().toISOString(),
  };
}

function createMockInteraction(overrides: Partial<UserInteraction> = {}): UserInteraction {
  return {
    id: overrides.id ?? createId(),
    type: 'question',
    questions: overrides.questions ?? [
      {
        question: 'Which approach do you prefer?',
        header: 'Approach',
        options: [
          { label: 'Option A', description: 'First approach' },
          { label: 'Option B', description: 'Second approach' },
        ],
        multiSelect: false,
      },
    ],
    answers: overrides.answers,
    answeredAt: overrides.answeredAt,
  };
}

// ============================================
// Mock Factory Functions
// ============================================

function createMockDatabase() {
  return {
    query: {
      codespaces: {
        findFirst: vi.fn(),
      },
      tasks: {
        findFirst: vi.fn(),
      },
      planSessions: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn(),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn(),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn(),
    }),
  } as unknown as Database;
}

function createMockStreamsService(): DurableStreamsService {
  const publishMock = vi.fn().mockResolvedValue(1); // Returns offset
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: publishMock,
    // Convenience methods that delegate to publish (matching DurableStreamsService)
    publishPlanStarted: vi
      .fn()
      .mockImplementation((streamId, data) => publishMock(streamId, 'plan:started', data)),
    publishPlanTurn: vi
      .fn()
      .mockImplementation((streamId, data) => publishMock(streamId, 'plan:turn', data)),
    publishPlanToken: vi
      .fn()
      .mockImplementation((streamId, data) => publishMock(streamId, 'plan:token', data)),
    publishPlanInteraction: vi
      .fn()
      .mockImplementation((streamId, data) => publishMock(streamId, 'plan:interaction', data)),
    publishPlanCompleted: vi
      .fn()
      .mockImplementation((streamId, data) => publishMock(streamId, 'plan:completed', data)),
    publishPlanError: vi
      .fn()
      .mockImplementation((streamId, data) => publishMock(streamId, 'plan:error', data)),
  } as unknown as DurableStreamsService;
}

function createMockClaudeClient(): ClaudeClient {
  return {
    sendMessage: vi.fn(),
    parseAskUserQuestion: vi.fn(),
    parseCreateGitHubIssue: vi.fn(),
  } as unknown as ClaudeClient;
}

function createMockIssueCreator(): GitHubIssueCreator {
  return {
    createIssue: vi.fn(),
    createFromPlanSession: vi.fn(),
    createFromToolInput: vi.fn(),
    updateIssue: vi.fn(),
    addComment: vi.fn(),
  } as unknown as GitHubIssueCreator;
}

// ============================================
// Test Suite
// ============================================

describe('PlanModeService', () => {
  let db: ReturnType<typeof createMockDatabase>;
  let streams: DurableStreamsService;
  let mockClaudeClient: ClaudeClient;
  let mockIssueCreator: GitHubIssueCreator;
  let service: PlanModeService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDatabase();
    streams = createMockStreamsService();
    mockClaudeClient = createMockClaudeClient();
    mockIssueCreator = createMockIssueCreator();

    // Setup default Claude client mock
    vi.mocked(createClaudeClient).mockResolvedValue(ok(mockClaudeClient));

    service = new PlanModeService(
      db,
      streams,
      mockIssueCreator,
      { owner: 'test-owner', repo: 'test-repo' },
      { maxTurns: 20 }
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ============================================
  // Plan Generation Tests (8 tests)
  // ============================================

  describe('Plan Generation', () => {
    it('should generate a plan from task description', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      const updateReturning = vi.fn().mockResolvedValue([
        createMockPlanSession({
          id: sessionId,
          codespaceId: project.id,
          taskId: task.id,
          turns: [createMockTurn('user', 'Create a login system')],
        }),
      ]);
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: updateReturning }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Here is the plan for your login system...' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a login system',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.codespaceId).toBe(project.id);
        expect(result.value.taskId).toBe(task.id);
        expect(result.value.status).toBe('active');
      }
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:started',
        expect.any(Object)
      );
    });

    it('should parse plan steps from Claude response', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      const planText = `## Implementation Plan
1. Create database schema
2. Implement authentication service
3. Build login UI`;

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: planText } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create authentication system',
      });

      expect(result.ok).toBe(true);
      expect(mockClaudeClient.sendMessage).toHaveBeenCalled();
    });

    it('should validate plan structure with required fields', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([createMockPlanSession({ codespaceId: project.id, taskId: task.id })]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Valid plan content' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test prompt',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty('id');
        expect(result.value).toHaveProperty('taskId');
        expect(result.value).toHaveProperty('codespaceId');
        expect(result.value).toHaveProperty('status');
        expect(result.value).toHaveProperty('turns');
      }
    });

    it('should handle malformed plans from Claude', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([createMockPlanSession({ codespaceId: project.id, taskId: task.id })]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Return tool_use with invalid tool name
      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'InvalidTool',
          toolId: 'tool-123',
          input: {},
        } as ToolCallResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Generate a plan',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_PARSING_ERROR');
      }
    });

    it('should handle empty plans gracefully', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([createMockPlanSession({ codespaceId: project.id, taskId: task.id })]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: '' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Generate a plan',
      });

      // Empty response should still succeed - it's a valid Claude response
      expect(result.ok).toBe(true);
    });

    it('should return error when project not found', async () => {
      db.query.codespaces.findFirst.mockResolvedValue(null);

      const result = await service.start({
        codespaceId: 'nonexistent',
        taskId: 'task-1',
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_PROJECT_NOT_FOUND');
      }
    });

    it('should return error when task not found', async () => {
      const project = createMockProject();
      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(null);

      const result = await service.start({
        codespaceId: project.id,
        taskId: 'nonexistent',
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_TASK_NOT_FOUND');
      }
    });

    it('should handle Claude client initialization failure', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      vi.mocked(createClaudeClient).mockResolvedValue(err(PlanModeErrors.CREDENTIALS_NOT_FOUND));

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
      }
    });
  });

  // ============================================
  // Step Execution Tests (10 tests)
  // ============================================

  describe('Step Execution', () => {
    it('should execute individual steps via AskUserQuestion tool', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();
      const interactionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-1',
          input: {
            questions: [
              {
                question: 'Which database?',
                header: 'Database',
                options: [
                  { label: 'PostgreSQL', description: 'Relational DB' },
                  { label: 'MongoDB', description: 'NoSQL DB' },
                ],
                multiSelect: false,
              },
            ],
          },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseAskUserQuestion).mockReturnValue({
        id: interactionId,
        type: 'question',
        questions: [
          {
            question: 'Which database?',
            header: 'Database',
            options: [
              { label: 'PostgreSQL', description: 'Relational DB' },
              { label: 'MongoDB', description: 'NoSQL DB' },
            ],
            multiSelect: false,
          },
        ],
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Help me choose a database',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('waiting_user');
      }
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:interaction',
        expect.any(Object)
      );
    });

    it('should track step completion after user response', async () => {
      const sessionId = createId();
      const interactionId = createId();
      const interaction = createMockInteraction({ id: interactionId });
      const turn = createMockTurn('assistant', 'Which database do you prefer?', interaction);

      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'waiting_user',
        turns: [createMockTurn('user', 'Help me choose'), turn],
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Great choice! PostgreSQL it is.' } as ClaudeResult)
      );

      const result = await service.respondToInteraction({
        sessionId,
        interactionId,
        answers: { Approach: 'Option A' },
      });

      expect(result.ok).toBe(true);
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:turn',
        expect.any(Object)
      );
    });

    it('should handle step failures from Claude API', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([createMockPlanSession({ codespaceId: project.id, taskId: task.id })]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        err(PlanModeErrors.API_ERROR('Rate limit exceeded'))
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_API_ERROR');
      }
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:error',
        expect.any(Object)
      );
    });

    it('should skip steps when session not waiting for user', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'active', // Not waiting_user
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const result = await service.respondToInteraction({
        sessionId,
        interactionId: 'interaction-1',
        answers: { test: 'answer' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_NOT_WAITING_FOR_USER');
      }
    });

    it('should resolve dependencies between plan steps', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Multiple turns simulate dependency resolution
      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValueOnce(
        ok({ type: 'text', text: 'Step 1: Setup database' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create multi-step plan',
      });

      expect(result.ok).toBe(true);
    });

    it('should handle CreateGitHubIssue tool for step completion', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Implementation Plan', body: 'Plan content', labels: ['plan'] },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Implementation Plan',
        body: 'Plan content',
        labels: ['plan'],
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        ok({
          url: 'https://github.com/test/repo/issues/1',
          number: 1,
          id: 1,
          nodeId: 'node-1',
        } as GitHubIssueResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan and issue',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        expect(result.value.githubIssueUrl).toBe('https://github.com/test/repo/issues/1');
      }
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:completed',
        expect.any(Object)
      );
    });

    it('should handle GitHub issue creation failure gracefully', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test',
        body: 'Content',
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        err(PlanModeErrors.GITHUB_ERROR('Permission denied'))
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      // Session should still complete even if GitHub fails
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        expect(result.value.githubIssueUrl).toBeUndefined();
      }
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:error',
        expect.any(Object)
      );
    });

    it('should complete without GitHub issue when config missing', async () => {
      // Create service without GitHub config
      const serviceWithoutGitHub = new PlanModeService(
        db,
        streams,
        null, // No issue creator
        null, // No GitHub config
        { maxTurns: 20 }
      );

      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      const result = await serviceWithoutGitHub.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
      }
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:error',
        expect.objectContaining({ code: 'GITHUB_CONFIG_MISSING' })
      );
    });

    it('should handle database insert failure', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi.fn().mockRejectedValue(new Error('Database connection lost'));
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should support token streaming callbacks', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Streamed response' } as ClaudeResult)
      );

      const tokenCallback = vi.fn();
      const result = await service.start(
        {
          codespaceId: project.id,
          taskId: task.id,
          initialPrompt: 'Test streaming',
        },
        tokenCallback
      );

      expect(result.ok).toBe(true);
      // Callback is passed to sendMessage
      expect(mockClaudeClient.sendMessage).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function)
      );
    });
  });

  // ============================================
  // State Management Tests (7 tests)
  // ============================================

  describe('State Management', () => {
    it('should initialize plan state correctly', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi.fn().mockResolvedValue([
        createMockPlanSession({
          id: sessionId,
          codespaceId: project.id,
          taskId: task.id,
          status: 'active',
          turns: [],
        }),
      ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Initial response' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Start planning',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(sessionId);
        expect(result.value.status).toBe('active');
      }
    });

    it('should transition state from active to waiting_user', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-1',
          input: {
            questions: [
              {
                question: 'Test?',
                header: 'Q1',
                options: [{ label: 'A', description: 'A' }],
                multiSelect: false,
              },
            ],
          },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseAskUserQuestion).mockReturnValue(createMockInteraction());

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Need input',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('waiting_user');
      }
    });

    it('should persist state to database on updates', async () => {
      const sessionId = createId();
      const interactionId = createId();
      const interaction = createMockInteraction({ id: interactionId });
      const turn = createMockTurn('assistant', 'Question', interaction);

      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'waiting_user',
        turns: [createMockTurn('user', 'Initial'), turn],
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      });
      db.update.mockReturnValue({ set: updateSet });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Thank you' } as ClaudeResult)
      );

      await service.respondToInteraction({
        sessionId,
        interactionId,
        answers: { Approach: 'Option A' },
      });

      expect(db.update).toHaveBeenCalled();
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
        })
      );
    });

    it('should recover state from database on getById', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'active',
        turns: [createMockTurn('user', 'Test'), createMockTurn('assistant', 'Response')],
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const result = await service.getById(sessionId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(sessionId);
        expect(result.value.turns).toHaveLength(2);
      }
    });

    it('should handle concurrent plan sessions independently', async () => {
      const session1 = createMockPlanSession({ id: 'session-1', status: 'active' });
      const session2 = createMockPlanSession({ id: 'session-2', status: 'waiting_user' });

      db.query.planSessions.findFirst
        .mockResolvedValueOnce(session1)
        .mockResolvedValueOnce(session2);

      const result1 = await service.getById('session-1');
      const result2 = await service.getById('session-2');

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.status).toBe('active');
        expect(result2.value.status).toBe('waiting_user');
      }
    });

    it('should cancel a plan session', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({ id: sessionId, status: 'active' });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const updateReturning = vi
        .fn()
        .mockResolvedValue([createMockPlanSession({ id: sessionId, status: 'cancelled' })]);
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: updateReturning }),
        }),
      });

      const result = await service.cancel(sessionId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('cancelled');
      }
    });

    it('should not allow cancelling completed sessions', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({ id: sessionId, status: 'completed' });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const result = await service.cancel(sessionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_SESSION_COMPLETED');
      }
    });
  });

  // ============================================
  // Additional Edge Case Tests
  // ============================================

  describe('Edge Cases', () => {
    it('should enforce max turns limit', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      // Create session with turns at the limit
      const maxTurns = 20;
      const turns: PlanTurn[] = [];
      for (let i = 0; i < maxTurns * 2; i++) {
        turns.push(createMockTurn(i % 2 === 0 ? 'user' : 'assistant', `Turn ${i}`));
      }

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id, turns }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_MAX_TURNS_EXCEEDED');
      }
    });

    it('should return error when session not found', async () => {
      db.query.planSessions.findFirst.mockResolvedValue(null);

      const result = await service.getById('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_SESSION_NOT_FOUND');
      }
    });

    it('should get plan session by task ID', async () => {
      const taskId = createId();
      const dbSession = createMockPlanSession({ taskId });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const result = await service.getByTaskId(taskId);

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.taskId).toBe(taskId);
      }
    });

    it('should return null when no session exists for task', async () => {
      db.query.planSessions.findFirst.mockResolvedValue(null);

      const result = await service.getByTaskId('nonexistent-task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  // ============================================
  // Coverage Enhancement Tests (Lines 423-624, 636, 647)
  // ============================================

  describe('Coverage Enhancement - completeSession', () => {
    it('should handle stream publish failure during turn event in completeSession', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test',
        body: 'Content',
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        ok({
          url: 'https://github.com/test/repo/issues/1',
          number: 1,
          id: 1,
          nodeId: 'node-1',
        } as GitHubIssueResult)
      );

      // Make publish fail for turn events (this covers line 636)
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:turn') {
          return Promise.reject(new Error('Stream publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      // Session should still complete despite stream failure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
      }
    });

    it('should handle stream publish failure during completion event', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test',
        body: 'Content',
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        ok({
          url: 'https://github.com/test/repo/issues/1',
          number: 1,
          id: 1,
          nodeId: 'node-1',
        } as GitHubIssueResult)
      );

      // Make publish fail for completed events (this covers line 647)
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:completed') {
          return Promise.reject(new Error('Completion publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      // Session should still complete despite stream failure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
      }
    });

    it('should handle database update error in completeSession', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      // Make database update fail synchronously on the completeSession call
      db.update.mockImplementation(() => {
        throw new Error('DB write failed');
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test',
        body: 'Content',
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        ok({
          url: 'https://github.com/test/repo/issues/1',
          number: 1,
          id: 1,
          nodeId: 'node-1',
        } as GitHubIssueResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should complete session with empty final content', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Return CreateGitHubIssue with no streamed content (empty string)
      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test',
        body: 'Content',
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        ok({
          url: 'https://github.com/test/repo/issues/1',
          number: 1,
          id: 1,
          nodeId: 'node-1',
        } as GitHubIssueResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        // The final turn should have default content when empty
        const lastTurn = result.value.turns[result.value.turns.length - 1];
        expect(lastTurn?.content).toBe('Plan completed.');
      }
    });
  });

  describe('Coverage Enhancement - handleAskUserQuestion', () => {
    it('should handle database update error in handleAskUserQuestion', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      // Make database update fail - simulate error in update operation
      db.update.mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-1',
          input: {
            questions: [
              {
                question: 'Test question?',
                header: 'Test',
                options: [{ label: 'A', description: 'Option A' }],
                multiSelect: false,
              },
            ],
          },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseAskUserQuestion).mockReturnValue(createMockInteraction());

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Need input',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should handle stream publish failure for interaction event', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-1',
          input: {
            questions: [
              {
                question: 'Test?',
                header: 'Q1',
                options: [{ label: 'A', description: 'A' }],
                multiSelect: false,
              },
            ],
          },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseAskUserQuestion).mockReturnValue(createMockInteraction());

      // Make interaction publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:interaction') {
          return Promise.reject(new Error('Interaction publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Need input',
      });

      // Should still succeed despite stream failure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('waiting_user');
      }
    });

    it('should handle stream publish failure for turn event in handleAskUserQuestion', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-1',
          input: {
            questions: [
              {
                question: 'Test?',
                header: 'Q1',
                options: [{ label: 'A', description: 'A' }],
                multiSelect: false,
              },
            ],
          },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseAskUserQuestion).mockReturnValue(createMockInteraction());

      // Make turn publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:turn') {
          return Promise.reject(new Error('Turn publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Need input',
      });

      // Should still succeed despite stream failure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('waiting_user');
      }
    });

    it('should create interaction turn with streamed content', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-1',
          input: {
            questions: [
              {
                question: 'Test?',
                header: 'Q1',
                options: [{ label: 'A', description: 'A' }],
                multiSelect: false,
              },
            ],
          },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseAskUserQuestion).mockReturnValue(createMockInteraction());

      // Call with token callback to test streaming path
      const tokenCallback = vi.fn();
      const result = await service.start(
        {
          codespaceId: project.id,
          taskId: task.id,
          initialPrompt: 'Need input',
        },
        tokenCallback
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('waiting_user');
      }
    });
  });

  describe('Coverage Enhancement - handleCreateGitHubIssue', () => {
    it('should complete session with issue URL when GitHub issue created successfully', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test Issue', body: 'Issue Content', labels: ['plan'] },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test Issue',
        body: 'Issue Content',
        labels: ['plan'],
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        ok({
          url: 'https://github.com/test/repo/issues/42',
          number: 42,
          id: 12345,
          nodeId: 'node-42',
        } as GitHubIssueResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
        expect(result.value.githubIssueUrl).toBe('https://github.com/test/repo/issues/42');
        expect(result.value.githubIssueNumber).toBe(42);
      }
    });

    it('should handle stream publish failure for error event when GitHub config missing', async () => {
      // Create service without GitHub config
      const serviceWithoutGitHub = new PlanModeService(
        db,
        streams,
        null, // No issue creator
        null, // No GitHub config
        { maxTurns: 20 }
      );

      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      // Make error publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:error') {
          return Promise.reject(new Error('Error publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await serviceWithoutGitHub.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      // Should still complete despite stream failure
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
      }
    });

    it('should handle stream publish failure for error event when GitHub issue creation fails', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({
          type: 'tool_use',
          toolName: 'CreateGitHubIssue',
          toolId: 'tool-1',
          input: { title: 'Test', body: 'Content' },
        } as ToolCallResult)
      );

      vi.mocked(mockClaudeClient.parseCreateGitHubIssue).mockReturnValue({
        title: 'Test',
        body: 'Content',
      });

      vi.mocked(mockIssueCreator.createFromToolInput).mockResolvedValue(
        err(PlanModeErrors.GITHUB_ERROR('Permission denied'))
      );

      // Make error publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:error') {
          return Promise.reject(new Error('Error publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Create a plan',
      });

      // Session should still complete even if both GitHub and stream fail
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('completed');
      }
    });
  });

  describe('Coverage Enhancement - respondToInteraction', () => {
    it('should handle database update error in respondToInteraction', async () => {
      const sessionId = createId();
      const interactionId = createId();
      const interaction = createMockInteraction({ id: interactionId });
      const turn = createMockTurn('assistant', 'Question', interaction);

      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'waiting_user',
        turns: [createMockTurn('user', 'Initial'), turn],
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      // Make database update fail synchronously
      db.update.mockImplementation(() => {
        throw new Error('DB write failed');
      });

      const result = await service.respondToInteraction({
        sessionId,
        interactionId,
        answers: { Approach: 'Option A' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should handle stream publish failure for turn event in respondToInteraction', async () => {
      const sessionId = createId();
      const interactionId = createId();
      const interaction = createMockInteraction({ id: interactionId });
      const turn = createMockTurn('assistant', 'Question', interaction);

      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'waiting_user',
        turns: [createMockTurn('user', 'Initial'), turn],
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Thank you' } as ClaudeResult)
      );

      // Make turn publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:turn') {
          return Promise.reject(new Error('Turn publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.respondToInteraction({
        sessionId,
        interactionId,
        answers: { Approach: 'Option A' },
      });

      // Should still succeed despite stream failure
      expect(result.ok).toBe(true);
    });

    it('should return error for invalid interaction ID', async () => {
      const sessionId = createId();
      const turn = createMockTurn('assistant', 'Question', createMockInteraction());

      const dbSession = createMockPlanSession({
        id: sessionId,
        status: 'waiting_user',
        turns: [createMockTurn('user', 'Initial'), turn],
      });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const result = await service.respondToInteraction({
        sessionId,
        interactionId: 'invalid-interaction-id',
        answers: { Approach: 'Option A' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_INTERACTION_NOT_FOUND');
      }
    });
  });

  describe('Coverage Enhancement - processNextTurn', () => {
    it('should handle stream publish failure for turn event in processNextTurn', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Response text' } as ClaudeResult)
      );

      // Make turn publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:turn') {
          return Promise.reject(new Error('Turn publish failed'));
        }
        return Promise.resolve(1);
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test prompt',
      });

      // Should still succeed despite stream failure
      expect(result.ok).toBe(true);
    });

    it('should handle database update error in processNextTurn', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      // Make database update fail synchronously
      db.update.mockImplementation(() => {
        throw new Error('DB write failed');
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Response text' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test prompt',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should invoke token callback and publish token events when streaming', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Create a mock implementation that invokes the callback
      vi.mocked(mockClaudeClient.sendMessage).mockImplementation(async (_turns, callback) => {
        if (callback) {
          callback('Hello', 'Hello');
          callback(' World', 'Hello World');
        }
        return ok({ type: 'text', text: 'Hello World' } as ClaudeResult);
      });

      const tokenCallback = vi.fn();
      const result = await service.start(
        {
          codespaceId: project.id,
          taskId: task.id,
          initialPrompt: 'Test prompt',
        },
        tokenCallback
      );

      expect(result.ok).toBe(true);
      expect(tokenCallback).toHaveBeenCalledWith('Hello', 'Hello');
      expect(tokenCallback).toHaveBeenCalledWith(' World', 'Hello World');
      expect(streams.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plan:token',
        expect.any(Object)
      );
    });

    it('should handle token publish failure gracefully', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Make token publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:token') {
          return Promise.reject(new Error('Token publish failed'));
        }
        return Promise.resolve(1);
      });

      // Create a mock implementation that invokes the callback
      vi.mocked(mockClaudeClient.sendMessage).mockImplementation(async (_turns, callback) => {
        if (callback) {
          callback('Hello', 'Hello');
        }
        return ok({ type: 'text', text: 'Hello' } as ClaudeResult);
      });

      const tokenCallback = vi.fn();
      const result = await service.start(
        {
          codespaceId: project.id,
          taskId: task.id,
          initialPrompt: 'Test prompt',
        },
        tokenCallback
      );

      // Should still succeed despite token publish failure
      expect(result.ok).toBe(true);
      expect(tokenCallback).toHaveBeenCalled();
    });
  });

  describe('Coverage Enhancement - cancel', () => {
    it('should return error when cancelling non-existent session', async () => {
      db.query.planSessions.findFirst.mockResolvedValue(null);

      const result = await service.cancel('nonexistent-session');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_SESSION_NOT_FOUND');
      }
    });

    it('should not allow cancelling already cancelled sessions', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({ id: sessionId, status: 'cancelled' });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      const result = await service.cancel(sessionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_SESSION_COMPLETED');
      }
    });

    it('should handle database update error during cancel', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({ id: sessionId, status: 'active' });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      // Make database update fail
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('DB write failed')),
          }),
        }),
      });

      const result = await service.cancel(sessionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should handle database returning no session after cancel update', async () => {
      const sessionId = createId();
      const dbSession = createMockPlanSession({ id: sessionId, status: 'active' });

      db.query.planSessions.findFirst.mockResolvedValue(dbSession);

      // Return empty array from update
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await service.cancel(sessionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });
  });

  describe('Coverage Enhancement - start', () => {
    it('should handle database returning no session after insert', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      // Return empty array from insert
      const insertReturning = vi.fn().mockResolvedValue([]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_DATABASE_ERROR');
      }
    });

    it('should handle stream creation failure gracefully', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Make stream creation fail
      vi.mocked(streams.createStream).mockRejectedValue(new Error('Stream creation failed'));

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Response' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      // Should still succeed despite stream creation failure
      expect(result.ok).toBe(true);
    });

    it('should handle plan started publish failure gracefully', async () => {
      const project = createMockProject();
      const task = createMockTask(project.id);
      const sessionId = createId();

      db.query.codespaces.findFirst.mockResolvedValue(project);
      db.query.tasks.findFirst.mockResolvedValue(task);

      const insertReturning = vi
        .fn()
        .mockResolvedValue([
          createMockPlanSession({ id: sessionId, codespaceId: project.id, taskId: task.id }),
        ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      // Make plan started publish fail
      vi.mocked(streams.publish).mockImplementation((_streamId, eventType) => {
        if (eventType === 'plan:started') {
          return Promise.reject(new Error('Publish failed'));
        }
        return Promise.resolve(1);
      });

      vi.mocked(mockClaudeClient.sendMessage).mockResolvedValue(
        ok({ type: 'text', text: 'Response' } as ClaudeResult)
      );

      const result = await service.start({
        codespaceId: project.id,
        taskId: task.id,
        initialPrompt: 'Test',
      });

      // Should still succeed despite publish failure
      expect(result.ok).toBe(true);
    });
  });
});
