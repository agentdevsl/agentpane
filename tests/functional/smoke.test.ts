/**
 * Fast E2E smoke test — the task creation → agent auto-start golden path
 * exercised through REAL services.
 *
 * Runs as a dedicated early CI job to provide fast-feedback on the orchestration
 * boundary before the full (sharded, slow) integration-test suite.
 *
 * Covered transitions (all use real service code):
 * 1. TaskService.create() — task lands in backlog with skill/labels/priority
 * 2. TaskService.moveColumn() backlog → in_progress — triggers container agent
 *    with skill + task metadata in the prompt
 *
 * Only external I/O is mocked: Claude SDK, sandbox providers, git ops,
 * DurableStreams. See CLAUDE.md §"Functional Tests: Real Service Transitions".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams } from '../helpers/mocks';

function createMockWorktreeService() {
  return {
    getDiff: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };
}

describe('E2E smoke — task creation + agent auto-start golden path', () => {
  let db: ReturnType<typeof getTestDb>;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    const _streams = createInMemoryStreams() as unknown as DurableStreamsService;
    const mockWorktreeService = createMockWorktreeService();
    taskService = new TaskService(db, mockWorktreeService as never);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('creates a task and auto-starts a container agent with skill in prompt', async () => {
    const codespace = await createTestProject({
      id: 'smoke-codespace-1',
      name: 'Smoke Project',
      path: '/tmp/smoke-project',
      config: {
        worktreeRoot: '.worktrees',
        defaultBranch: 'main',
        allowedTools: ['Read', 'Write', 'Edit'],
        maxTurns: 10,
      },
    });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Smoke: add logging',
      description: 'Instrument the API with structured logs',
      skillId: 'observability',
      skillName: 'Observability Toolkit',
      labels: ['infra'],
      priority: 'medium',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw createResult.error;
    expect(createResult.value.column).toBe('backlog');
    expect(createResult.value.skillId).toBe('observability');
    const taskId = createResult.value.id;

    let capturedPrompt: string | null = null;
    const mockContainerAgent = {
      providerName: 'docker' as const,
      startAgent: vi.fn().mockImplementation(async (input: { prompt: string }) => {
        capturedPrompt = input.prompt;
        return { ok: true as const, value: undefined };
      }),
      stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn(),
      rejectPlan: vi.fn(),
    };
    taskService.setContainerAgentService(mockContainerAgent as never);

    // Seed sandbox defaults (infrastructure config, no service API).
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true, mode: 'shared' }),
    });

    const moveResult = await taskService.moveColumn(taskId, 'in_progress');
    expect(moveResult.ok).toBe(true);
    if (!moveResult.ok) throw moveResult.error;
    expect(moveResult.value.task.column).toBe('in_progress');
    expect(moveResult.value.task.sessionId).toBeTruthy();
    expect(moveResult.value.task.startedAt).toBeTruthy();

    expect(mockContainerAgent.startAgent).toHaveBeenCalledOnce();
    expect(capturedPrompt).toContain('.claude/skills/observability/SKILL.md');
    expect(capturedPrompt).toContain('Smoke: add logging');
    expect(capturedPrompt).toContain('Labels: infra');
    expect(capturedPrompt).toContain('Priority: medium');
  });
});
