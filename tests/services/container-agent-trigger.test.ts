import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions, settings } from '../../src/db/schema';
import type { ProjectSandboxConfig } from '../../src/lib/sandbox/types';
import { err, ok } from '../../src/lib/utils/result';
import type { StartAgentInput } from '../../src/services/container-agent.service';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// =============================================================================
// Mock createId to return predictable session IDs
// =============================================================================

let sessionIdCounter = 0;
const mockCreateId = vi.hoisted(() => vi.fn(() => `test-session-id-${++sessionIdCounter}`));

vi.mock('@paralleldrive/cuid2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paralleldrive/cuid2')>();
  return {
    ...actual,
    createId: mockCreateId,
  };
});

// =============================================================================
// Mock Setup
// =============================================================================

const createMockWorktreeService = () => ({
  getDiff: vi.fn(),
  merge: vi.fn(),
  remove: vi.fn(),
});

/**
 * Creates a mock container agent service.
 * Note: Session records must be pre-created via preCreateNextSession() before moveColumn.
 */
const createMockContainerAgentService = (
  shouldSucceed = true,
  errorResult?: unknown
): ContainerAgentTrigger => {
  return {
    startAgent: vi.fn().mockImplementation(async (_input: StartAgentInput) => {
      if (shouldSucceed) {
        return ok(undefined);
      }
      return err(errorResult ?? { message: 'Agent failed to start' });
    }),
    stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
    rejectPlan: vi.fn().mockReturnValue(ok(undefined)),
  };
};

/**
 * Helper to pre-create a session with the next expected ID.
 * Call this BEFORE moveColumn to satisfy FK constraints.
 */
async function preCreateNextSession(
  codespaceId: string,
  taskId: string | null = null
): Promise<string> {
  const db = getTestDb();
  const nextId = `test-session-id-${sessionIdCounter + 1}`;
  await db.insert(sessions).values({
    id: nextId,
    codespaceId,
    taskId,
    agentId: null,
    status: 'active',
    title: `Pre-created session ${nextId}`,
    url: `/sessions/${nextId}`,
  });
  return nextId;
}

// =============================================================================
// Container Agent Trigger Tests
// =============================================================================

describe('TaskService Container Agent Trigger', () => {
  let taskService: TaskService;
  let mockWorktreeService: ReturnType<typeof createMockWorktreeService>;
  let mockContainerAgentService: ContainerAgentTrigger;

  beforeEach(async () => {
    await setupTestDatabase();
    mockWorktreeService = createMockWorktreeService();
    mockContainerAgentService = createMockContainerAgentService(true);
    const db = getTestDb();
    taskService = new TaskService(db as never, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgentService);
    vi.clearAllMocks();
    // Reset the session ID counter for each test
    sessionIdCounter = 0;
    mockCreateId.mockImplementation(() => `test-session-id-${++sessionIdCounter}`);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =============================================================================
  // Agent Triggering on Move to in_progress (5 tests)
  // =============================================================================

  describe('Agent Triggering on Move to in_progress', () => {
    it('triggers container agent when task moves to in_progress with project sandbox enabled', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session that will be generated
      await preCreateNextSession(project.id, task.id);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            codespaceId: project.id,
            taskId: task.id,
            sessionId: expect.any(String),
            prompt: expect.stringContaining(task.title),
          })
        );
      }
    });

    it('triggers container agent when global sandbox defaults are enabled', async () => {
      // Create project WITHOUT sandbox config
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          // No sandbox config
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Insert global sandbox defaults
      const db = getTestDb();
      const globalSandboxDefaults: ProjectSandboxConfig = {
        enabled: true,
        provider: 'docker',
        idleTimeoutMinutes: 30,
      };
      await db.insert(settings).values({
        key: 'sandbox.defaults',
        value: JSON.stringify(globalSandboxDefaults),
      });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            codespaceId: project.id,
            taskId: task.id,
          })
        );
      }
    });

    it('does not trigger agent when sandbox is disabled', async () => {
      // Clear any global settings from previous tests
      const db = getTestDb();
      await db.delete(settings);

      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: false, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(mockContainerAgentService.startAgent).not.toHaveBeenCalled();
      }
    });

    it('does not trigger agent when no container agent service is configured', async () => {
      // Create a new TaskService without container agent service
      const db = getTestDb();
      const taskServiceWithoutAgent = new TaskService(db as never, mockWorktreeService);
      // Do NOT call setContainerAgentService

      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      const result = await taskServiceWithoutAgent.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(result.value.agentError).toBeUndefined();
      }
    });

    it('skips agent trigger if agent is already running for task', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Mock that agent is already running
      (mockContainerAgentService.isAgentRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(mockContainerAgentService.startAgent).not.toHaveBeenCalled();
      }
    });
  });

  // =============================================================================
  // Agent Error Propagation (4 tests)
  // =============================================================================

  describe('Agent Error Propagation', () => {
    it('captures agent startup error in MoveTaskResult.agentError', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to fail with error result
      const errorMessage = 'Container not found';
      const failingMock = createMockContainerAgentService(false, {
        message: errorMessage,
        code: 'SANDBOX_CONTAINER_NOT_FOUND',
      });
      taskService.setContainerAgentService(failingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Task move should still succeed
        expect(result.value.task.column).toBe('in_progress');
        // But agentError should contain the error message
        expect(result.value.agentError).toBe(errorMessage);
      }
    });

    it('captures string error from agent startup', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to fail with string error
      const errorString = 'Docker daemon unavailable';
      const failingMock = createMockContainerAgentService(false, errorString);
      taskService.setContainerAgentService(failingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(result.value.agentError).toBe(errorString);
      }
    });

    it('captures exception from agent startup', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to throw an exception
      const errorMessage = 'Network timeout';
      const throwingMock: ContainerAgentTrigger = {
        startAgent: vi.fn().mockRejectedValue(new Error(errorMessage)),
        stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
        isAgentRunning: vi.fn().mockReturnValue(false),
        approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
        rejectPlan: vi.fn().mockReturnValue(ok(undefined)),
      };
      taskService.setContainerAgentService(throwingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(result.value.agentError).toBe(errorMessage);
      }
    });

    it('handles generic error result from agent startup', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to fail with generic error (no message property)
      const failingMock = createMockContainerAgentService(false, { code: 'UNKNOWN_ERROR' });
      taskService.setContainerAgentService(failingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('in_progress');
        expect(result.value.agentError).toBe('Failed to start agent');
      }
    });
  });

  // =============================================================================
  // Task Still Moves Even When Agent Fails (3 tests)
  // =============================================================================

  describe('Task Still Moves When Agent Fails', () => {
    it('task is successfully moved to in_progress even when agent fails to start', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to fail
      const failingMock = createMockContainerAgentService(false, {
        message: 'Sandbox not running',
        code: 'SANDBOX_CONTAINER_NOT_RUNNING',
      });
      taskService.setContainerAgentService(failingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Task should be moved
        expect(result.value.task.column).toBe('in_progress');
        expect(result.value.task.id).toBe(task.id);
        // Error should be captured but not fail the move
        expect(result.value.agentError).toBeDefined();
      }

      // Verify database state
      const getResult = await taskService.getById(task.id);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.column).toBe('in_progress');
      }
    });

    it('startedAt is set when moving to in_progress even when agent fails', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to throw
      const throwingMock: ContainerAgentTrigger = {
        startAgent: vi.fn().mockRejectedValue(new Error('Connection refused')),
        stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
        isAgentRunning: vi.fn().mockReturnValue(false),
        approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
        rejectPlan: vi.fn().mockReturnValue(ok(undefined)),
      };
      taskService.setContainerAgentService(throwingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.startedAt).toBeDefined();
        expect(result.value.task.startedAt).not.toBeNull();
      }
    });

    it('position is calculated correctly even when agent fails', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });

      // Create existing tasks in in_progress
      await createTestTask(project.id, { column: 'in_progress', position: 0 });
      await createTestTask(project.id, { column: 'in_progress', position: 1 });

      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      // Set up mock to fail
      const failingMock = createMockContainerAgentService(false, { message: 'Image not found' });
      taskService.setContainerAgentService(failingMock);

      const result = await taskService.moveColumn(task.id, 'in_progress');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Position should be 2 (after existing tasks at 0, 1)
        expect(result.value.task.position).toBe(2);
      }
    });
  });

  // =============================================================================
  // No Agent Trigger for Other Column Moves (4 tests)
  // =============================================================================

  describe('No Agent Trigger for Other Column Moves', () => {
    it('does not trigger agent when moving to backlog', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      const result = await taskService.moveColumn(task.id, 'backlog');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('backlog');
        expect(mockContainerAgentService.startAgent).not.toHaveBeenCalled();
        expect(result.value.agentError).toBeUndefined();
      }
    });

    it('does not trigger agent when moving to queued', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'backlog' });

      const result = await taskService.moveColumn(task.id, 'queued');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('queued');
        expect(mockContainerAgentService.startAgent).not.toHaveBeenCalled();
      }
    });

    it('does not trigger agent when moving to waiting_approval', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'in_progress' });

      const result = await taskService.moveColumn(task.id, 'waiting_approval');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('waiting_approval');
        expect(mockContainerAgentService.startAgent).not.toHaveBeenCalled();
      }
    });

    it('does not trigger agent when moving to verified', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'waiting_approval' });

      const result = await taskService.moveColumn(task.id, 'verified');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.task.column).toBe('verified');
        expect(mockContainerAgentService.startAgent).not.toHaveBeenCalled();
      }
    });
  });

  // =============================================================================
  // Task Prompt Generation (2 tests)
  // =============================================================================

  describe('Task Prompt Generation', () => {
    it('includes task title and description in agent prompt', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, {
        column: 'queued',
        title: 'Fix the bug',
        description: 'The login button does not work',
      });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      await taskService.moveColumn(task.id, 'in_progress');

      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Fix the bug'),
        })
      );
      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('The login button does not work'),
        })
      );
    });

    it('includes labels in agent prompt', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, {
        column: 'queued',
        title: 'Add feature',
        labels: ['frontend', 'urgent'],
      });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      await taskService.moveColumn(task.id, 'in_progress');

      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('frontend'),
        })
      );
      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('urgent'),
        })
      );
    });
  });

  // =============================================================================
  // Model Override Passed to Agent (2 tests)
  // =============================================================================

  describe('Model Override Passed to Agent', () => {
    it('passes project model config to agent', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 100,
          model: 'claude-opus-4-20250514',
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      await taskService.moveColumn(task.id, 'in_progress');

      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-5-20251101',
          maxTurns: 100,
        })
      );
    });

    it('passes undefined model when project has no model config', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          // No model specified
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued' });

      // Pre-create the session
      await preCreateNextSession(project.id, task.id);

      await taskService.moveColumn(task.id, 'in_progress');

      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: undefined,
          maxTurns: 50,
        })
      );
    });
  });

  // =============================================================================
  // Session ID Generation (2 tests)
  // =============================================================================

  describe('Session ID Generation', () => {
    it('generates a session ID when task has none', async () => {
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });
      const task = await createTestTask(project.id, { column: 'queued', sessionId: null });

      // Pre-create the session that will be generated
      const expectedSessionId = await preCreateNextSession(project.id, task.id);

      await taskService.moveColumn(task.id, 'in_progress');

      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expectedSessionId,
        })
      );

      // Verify session ID was saved to task
      const updatedTask = await taskService.getById(task.id);
      expect(updatedTask.ok).toBe(true);
      if (updatedTask.ok) {
        expect(updatedTask.value.sessionId).toBe(expectedSessionId);
      }
    });

    it('uses existing session ID when task already has one', async () => {
      const existingSessionId = 'existing-session-123';
      const project = await createTestProject({
        config: {
          worktreeRoot: '.worktrees',
          defaultBranch: 'main',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          maxTurns: 50,
          sandbox: { enabled: true, provider: 'docker', idleTimeoutMinutes: 30 },
        },
      });

      // Pre-create the session to satisfy foreign key constraint
      const db = getTestDb();
      await db.insert(sessions).values({
        id: existingSessionId,
        codespaceId: project.id,
        taskId: null,
        agentId: null,
        status: 'active',
        title: 'Pre-existing session',
        url: `/sessions/${existingSessionId}`,
      });

      const task = await createTestTask(project.id, {
        column: 'queued',
        sessionId: existingSessionId,
      });

      await taskService.moveColumn(task.id, 'in_progress');

      expect(mockContainerAgentService.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: existingSessionId,
        })
      );
    });
  });
});
