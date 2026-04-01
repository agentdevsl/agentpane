import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planSessions } from '../../src/db/schema';
import type { PlanTurn } from '../../src/lib/plan-mode/types';
import { PlanModeService } from '../../src/services/plan-mode.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// The plan_sessions table from v19 migration is minimal. We need the full schema.
const PLAN_SESSIONS_TABLE_SQL = `
DROP TABLE IF EXISTS plan_sessions;
CREATE TABLE "plan_sessions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "task_id" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "codespace_id" TEXT NOT NULL REFERENCES codespaces(id) ON DELETE CASCADE,
  "status" TEXT DEFAULT 'active' NOT NULL,
  "turns" TEXT DEFAULT '[]',
  "github_issue_url" TEXT,
  "github_issue_number" INTEGER,
  "created_at" TEXT DEFAULT (datetime('now')) NOT NULL,
  "completed_at" TEXT,
  "updated_at" TEXT DEFAULT (datetime('now')) NOT NULL
);
`;

function setupPlanSessionsTable(): void {
  execRawSql(PLAN_SESSIONS_TABLE_SQL);
}

function clearPlanSessionsTable(): void {
  try {
    execRawSql('DELETE FROM plan_sessions');
  } catch {
    // Table may not exist yet
  }
}

// ---------------------------------------------------------------------------
// Mock factories for external I/O boundaries
// ---------------------------------------------------------------------------

function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(1),
    publishPlanStarted: vi.fn().mockResolvedValue(undefined),
    publishPlanTurn: vi.fn().mockResolvedValue(undefined),
    publishPlanToken: vi.fn().mockResolvedValue(undefined),
    publishPlanInteraction: vi.fn().mockResolvedValue(undefined),
    publishPlanCompleted: vi.fn().mockResolvedValue(undefined),
    publishPlanError: vi.fn().mockResolvedValue(undefined),
    publishPlanCancelled: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Mock the Claude client initialization (external API boundary).
 * The PlanModeService lazily initializes via createClaudeClient().
 */
vi.mock('../../src/lib/plan-mode/claude-client.js', () => ({
  createClaudeClient: vi.fn().mockResolvedValue({
    ok: true,
    value: {
      sendMessage: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          type: 'text',
          text: 'Here is the implementation plan:\n1. Create module\n2. Add tests',
        },
      }),
      parseAskUserQuestion: vi.fn().mockReturnValue({
        id: createId(),
        type: 'question',
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'React.js' },
              { label: 'Vue', description: 'Vue.js' },
            ],
            multiSelect: false,
          },
        ],
      }),
      parseCreateGitHubIssue: vi.fn().mockReturnValue({
        title: 'Test Issue',
        body: 'Issue body',
        labels: ['plan'],
      }),
    },
  }),
}));

describe('PlanModeService (IT-450)', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: ReturnType<typeof createMockStreams>;
  let service: PlanModeService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    setupPlanSessionsTable();
    streams = createMockStreams();
    service = new PlanModeService(
      db as any,
      streams as any,
      null, // no GitHub issue creator
      null, // no GitHub config
      { maxTurns: 10 }
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearPlanSessionsTable();
    await clearTestDatabase();
  });

  // ---------- start ----------------------------------------------------------

  it('IT-451: start creates a plan session in database with initial user turn', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    const result = await service.start({
      taskId: task.id,
      codespaceId: project.id,
      initialPrompt: 'Plan a login page feature',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = result.value;
    expect(session.taskId).toBe(task.id);
    expect(session.codespaceId).toBe(project.id);
    // Should have at least the user turn + assistant response turn
    expect(session.turns.length).toBeGreaterThanOrEqual(2);
    expect(session.turns[0].role).toBe('user');
    expect(session.turns[0].content).toBe('Plan a login page feature');

    // Verify persisted in DB
    const dbSession = await db.query.planSessions.findFirst({
      where: eq(planSessions.id, session.id),
    });
    expect(dbSession).toBeTruthy();
    expect(dbSession!.taskId).toBe(task.id);
    expect(dbSession!.codespaceId).toBe(project.id);
  });

  it('IT-452: start publishes stream events (createStream + plan:started + plan:turn)', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    await service.start({
      taskId: task.id,
      codespaceId: project.id,
      initialPrompt: 'Create a REST API',
    });

    // Stream should be created with plan:-prefixed ID
    expect(streams.createStream).toHaveBeenCalledTimes(1);
    const createStreamArgs = streams.createStream.mock.calls[0];
    expect(createStreamArgs[0]).toMatch(/^plan:/);

    // plan:started event
    expect(streams.publishPlanStarted).toHaveBeenCalledTimes(1);

    // At least one plan:turn event for the assistant response
    expect(streams.publishPlanTurn).toHaveBeenCalled();
  });

  it('IT-453: start returns PROJECT_NOT_FOUND for nonexistent codespace', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const result = await service.start({
      taskId: task.id,
      codespaceId: 'nonexistent-codespace',
      initialPrompt: 'Plan something',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_PROJECT_NOT_FOUND');
  });

  it('IT-454: start returns TASK_NOT_FOUND for nonexistent task', async () => {
    const project = await createTestProject();

    const result = await service.start({
      taskId: 'nonexistent-task',
      codespaceId: project.id,
      initialPrompt: 'Plan something',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_TASK_NOT_FOUND');
  });

  // ---------- getById --------------------------------------------------------

  it('IT-455: getById returns the plan session', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    // Insert directly into DB
    const sessionId = createId();
    const turns: PlanTurn[] = [
      {
        id: createId(),
        role: 'user',
        content: 'test prompt',
        timestamp: new Date().toISOString(),
      },
    ];

    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns,
    });

    const result = await service.getById(sessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(sessionId);
    expect(result.value.taskId).toBe(task.id);
    expect(result.value.turns).toHaveLength(1);
    expect(result.value.turns[0].content).toBe('test prompt');
  });

  it('IT-456: getById returns SESSION_NOT_FOUND for nonexistent session', async () => {
    const result = await service.getById('nonexistent-session-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_SESSION_NOT_FOUND');
  });

  // ---------- getByTaskId ----------------------------------------------------

  it('IT-457: getByTaskId returns session for task', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    await db.insert(planSessions).values({
      id: createId(),
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns: [],
    });

    const result = await service.getByTaskId(task.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.taskId).toBe(task.id);
  });

  it('IT-458: getByTaskId returns null when no session exists for task', async () => {
    const result = await service.getByTaskId('nonexistent-task');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // ---------- cancel ---------------------------------------------------------

  it('IT-459: cancel updates session status to cancelled in database', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns: [
        {
          id: createId(),
          role: 'user',
          content: 'initial prompt',
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const result = await service.cancel(sessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('cancelled');

    // Verify persisted in DB
    const dbSession = await db.query.planSessions.findFirst({
      where: eq(planSessions.id, sessionId),
    });
    expect(dbSession!.status).toBe('cancelled');
  });

  it('IT-460: cancel returns SESSION_NOT_FOUND for nonexistent session', async () => {
    const result = await service.cancel('nonexistent-session');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_SESSION_NOT_FOUND');
  });

  it('IT-461: cancel returns SESSION_COMPLETED when session is already completed', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'completed',
      turns: [],
      completedAt: new Date().toISOString(),
    });

    const result = await service.cancel(sessionId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_SESSION_COMPLETED');
  });

  it('IT-462: cancel returns SESSION_COMPLETED when session is already cancelled', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'cancelled',
      turns: [],
    });

    const result = await service.cancel(sessionId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_SESSION_COMPLETED');
  });

  // ---------- respondToInteraction -------------------------------------------

  it('IT-463: respondToInteraction returns NOT_WAITING_FOR_USER when session is active', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns: [],
    });

    const result = await service.respondToInteraction({
      sessionId,
      interactionId: 'interaction-1',
      answers: { q1: 'answer1' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_NOT_WAITING_FOR_USER');
  });

  it('IT-464: respondToInteraction returns SESSION_NOT_FOUND for nonexistent session', async () => {
    const result = await service.respondToInteraction({
      sessionId: 'nonexistent',
      interactionId: 'interaction-1',
      answers: { q1: 'a1' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PLAN_SESSION_NOT_FOUND');
  });

  // ---------- metrics --------------------------------------------------------

  it('IT-465: getMetrics returns droppedEventCount', () => {
    const metrics = service.getMetrics();
    expect(metrics.droppedEventCount).toBe(0);
  });

  it('IT-466: droppedEventCount increments when stream publish fails during start', async () => {
    // Make stream operations fail
    streams.createStream.mockRejectedValue(new Error('Stream unavailable'));
    streams.publishPlanStarted.mockRejectedValue(new Error('Stream unavailable'));

    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'in_progress' });

    // The service should still complete — stream errors are non-fatal
    await service.start({
      taskId: task.id,
      codespaceId: project.id,
      initialPrompt: 'Plan with broken stream',
    });

    // droppedEventCount should be > 0 due to stream failures
    const metrics = service.getMetrics();
    expect(metrics.droppedEventCount).toBeGreaterThan(0);
  });

  // ---------- DB persistence edge cases --------------------------------------

  it('IT-467: plan session stores and retrieves turns with correct structure', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    const turns: PlanTurn[] = [
      {
        id: createId(),
        role: 'user',
        content: 'Create a search feature',
        timestamp: new Date().toISOString(),
      },
      {
        id: createId(),
        role: 'assistant',
        content: 'Here is the plan:\n1. Add search input\n2. Implement fuzzy matching',
        timestamp: new Date().toISOString(),
      },
    ];

    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns,
    });

    const result = await service.getById(sessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = result.value;
    expect(session.turns).toHaveLength(2);
    expect(session.turns[0].role).toBe('user');
    expect(session.turns[0].content).toBe('Create a search feature');
    expect(session.turns[1].role).toBe('assistant');
    expect(session.turns[1].content).toContain('fuzzy matching');
  });

  it('IT-468: plan session with GitHub issue URL and number stored and retrieved', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'completed',
      turns: [],
      githubIssueUrl: 'https://github.com/org/repo/issues/42',
      githubIssueNumber: 42,
      completedAt: new Date().toISOString(),
    });

    const result = await service.getById(sessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.githubIssueUrl).toBe('https://github.com/org/repo/issues/42');
    expect(result.value.githubIssueNumber).toBe(42);
    expect(result.value.status).toBe('completed');
    expect(result.value.completedAt).toBeDefined();
  });

  it('IT-469: plan session with interaction turn preserves interaction data', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const interactionId = createId();
    const sessionId = createId();
    const turns: PlanTurn[] = [
      {
        id: createId(),
        role: 'user',
        content: 'Build a dashboard',
        timestamp: new Date().toISOString(),
      },
      {
        id: createId(),
        role: 'assistant',
        content: 'I have a question about the framework:',
        interaction: {
          id: interactionId,
          type: 'question',
          questions: [
            {
              question: 'Which charting library?',
              header: 'Charts',
              options: [
                { label: 'Chart.js', description: 'Simple and flexible' },
                { label: 'D3.js', description: 'Low-level and powerful' },
              ],
              multiSelect: false,
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];

    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'waiting_user',
      turns,
    });

    const result = await service.getById(sessionId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assistantTurn = result.value.turns[1];
    expect(assistantTurn.interaction).toBeDefined();
    expect(assistantTurn.interaction!.id).toBe(interactionId);
    expect(assistantTurn.interaction!.type).toBe('question');
    expect(assistantTurn.interaction!.questions).toHaveLength(1);
    expect(assistantTurn.interaction!.questions[0].question).toBe('Which charting library?');
    expect(assistantTurn.interaction!.questions[0].options).toHaveLength(2);
  });

  it('IT-470: multiple plan sessions for different tasks are independent', async () => {
    const project = await createTestProject();
    const task1 = await createTestTask(project.id, { title: 'Task 1' });
    const task2 = await createTestTask(project.id, { title: 'Task 2' });

    const session1Id = createId();
    const session2Id = createId();

    await db.insert(planSessions).values([
      {
        id: session1Id,
        taskId: task1.id,
        codespaceId: project.id,
        status: 'active',
        turns: [
          {
            id: createId(),
            role: 'user' as const,
            content: 'Plan for task 1',
            timestamp: new Date().toISOString(),
          },
        ],
      },
      {
        id: session2Id,
        taskId: task2.id,
        codespaceId: project.id,
        status: 'completed',
        turns: [
          {
            id: createId(),
            role: 'user' as const,
            content: 'Plan for task 2',
            timestamp: new Date().toISOString(),
          },
        ],
        completedAt: new Date().toISOString(),
      },
    ]);

    const result1 = await service.getByTaskId(task1.id);
    const result2 = await service.getByTaskId(task2.id);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;

    expect(result1.value!.status).toBe('active');
    expect(result1.value!.turns[0].content).toBe('Plan for task 1');
    expect(result2.value!.status).toBe('completed');
    expect(result2.value!.turns[0].content).toBe('Plan for task 2');
  });

  it('IT-471: cancel preserves existing turns in session', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    const turns: PlanTurn[] = [
      {
        id: createId(),
        role: 'user',
        content: 'Build an API gateway',
        timestamp: new Date().toISOString(),
      },
      {
        id: createId(),
        role: 'assistant',
        content: 'Plan: API gateway with rate limiting and auth',
        timestamp: new Date().toISOString(),
      },
    ];

    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns,
    });

    const cancelResult = await service.cancel(sessionId);
    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;

    // Turns should be preserved after cancellation
    expect(cancelResult.value.turns).toHaveLength(2);
    expect(cancelResult.value.turns[0].content).toBe('Build an API gateway');
    expect(cancelResult.value.turns[1].content).toContain('rate limiting');
    expect(cancelResult.value.status).toBe('cancelled');
  });

  it('IT-472: plan session cascade-deletes when task is deleted', async () => {
    const project = await createTestProject();
    const task = await createTestTask(project.id);

    const sessionId = createId();
    await db.insert(planSessions).values({
      id: sessionId,
      taskId: task.id,
      codespaceId: project.id,
      status: 'active',
      turns: [],
    });

    // Verify it exists
    const before = await db.query.planSessions.findFirst({
      where: eq(planSessions.id, sessionId),
    });
    expect(before).toBeTruthy();

    // Delete the task — should cascade
    const { tasks } = await import('../../src/db/schema');
    await db.delete(tasks).where(eq(tasks.id, task.id));

    // Plan session should be gone due to ON DELETE CASCADE
    const after = await db.query.planSessions.findFirst({
      where: eq(planSessions.id, sessionId),
    });
    expect(after).toBeUndefined();
  });
});
