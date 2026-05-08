/**
 * Integration tests for the canUseTool callback wired up by
 * TaskCreationService.startConversation. Exercising it directly covers the
 * questions-detection branch (lines 622-733), the no-questions early-allow
 * branch, the over-limit branch, and the per-tool allow branches without
 * needing to drive the SDK end-to-end.
 *
 * Run: npx vitest run --project integration tests/integration/task-creation-can-use-tool.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCreationService } from '../../src/services/task-creation.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const sdkMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: sdkMocks.createSession,
}));

function makeSdkSession() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn().mockImplementation(async function* () {
      // Empty stream — we only care about canUseTool
    }),
    close: vi.fn(),
  };
}

function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    publishTaskCreationStarted: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationMessage: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationToken: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationSuggestion: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationQuestions: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationCompleted: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationCancelled: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationError: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationProcessing: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    deleteStream: vi.fn().mockResolvedValue(true),
  };
}

function createMockSessionService() {
  return {
    create: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'mock-db-session-id' },
    }),
    publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0 } }),
    close: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    destroy: vi.fn(),
  };
}

describe('TaskCreationService canUseTool callback', () => {
  let service: TaskCreationService;
  let mockStreams: ReturnType<typeof createMockStreams>;
  let mockSessionService: ReturnType<typeof createMockSessionService>;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    mockStreams = createMockStreams();
    mockSessionService = createMockSessionService();
    sdkMocks.createSession.mockReset();
    sdkMocks.createSession.mockImplementation(() => makeSdkSession());
    service = new TaskCreationService(
      db as never,
      mockStreams as never,
      mockSessionService as never,
      undefined
    );
  });

  afterEach(async () => {
    service.destroy();
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  async function startAndGetCanUseTool(): Promise<{
    canUseTool: (
      toolName: string,
      input: unknown,
      options: { toolUseID: string }
    ) => Promise<unknown>;
    sessionId: string;
  }> {
    const codespace = await createTestProject();
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error('start failed');
    const callArg = sdkMocks.createSession.mock.calls.at(-1)![0]!;
    return { canUseTool: callArg.canUseTool, sessionId: start.value.id };
  }

  it('non-AskUserQuestion tools resolve immediately with allow', async () => {
    const { canUseTool } = await startAndGetCanUseTool();
    const result = await canUseTool('Read', { file_path: '/x' }, { toolUseID: 'tu-1' });
    expect(result).toMatchObject({
      behavior: 'allow',
      toolUseID: 'tu-1',
    });
  });

  it('AskUserQuestion with empty questions allows the tool to proceed', async () => {
    const { canUseTool } = await startAndGetCanUseTool();
    const result = await canUseTool(
      'AskUserQuestion',
      { questions: [] },
      { toolUseID: 'tu-empty' }
    );
    expect(result).toMatchObject({
      behavior: 'allow',
      toolUseID: 'tu-empty',
    });
  });

  it('AskUserQuestion with valid questions stores PendingQuestions and waits (Promise unresolved)', async () => {
    const { canUseTool, sessionId } = await startAndGetCanUseTool();
    const promise = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Topic',
            question: 'Pick one',
            multiSelect: false,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
      { toolUseID: 'tu-with-q' }
    );

    // Race the canUseTool promise with a short timer; the canUseTool side
    // returns a Promise that will only resolve when the user (test) answers.
    const winner = await Promise.race([
      promise.then(() => 'resolved-too-soon'),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 50)),
    ]);
    expect(winner).toBe('still-waiting');

    // PendingQuestions captured on the session
    const session = service.getSession(sessionId)!;
    expect(session.status).toBe('waiting_user');
    expect(session.pendingQuestions?.questions.length).toBe(1);
    expect(session.pendingToolUseId).toBe('tu-with-q');
    expect(session.pendingQuestionsInput).toMatchObject({ questions: expect.any(Array) });

    // Resolve the canUseTool Promise so vitest doesn't hang on cleanup.
    if (session.pendingPermissionResolver) {
      session.pendingPermissionResolver({
        behavior: 'allow',
        updatedInput: { questions: session.pendingQuestions!.questions, answers: { '0': 'A' } },
        toolUseID: 'tu-with-q',
      });
    }
    await promise;
  });

  it('AskUserQuestion deny path is reachable when session was deleted before callback fires', async () => {
    const { canUseTool, sessionId } = await startAndGetCanUseTool();
    // Force the session to be missing from the in-memory map
    // by closing the service-level session via the cancel flow.
    const cancelResult = await service.cancel(sessionId);
    expect(cancelResult.ok).toBe(true);
    // Wait for the delayed setTimeout cleanup to drop the session — but
    // since the cleanup is on a 60s timer, simulate by directly removing.
    // Access internal map via cast.
    (service as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId);

    const result = await canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'X',
            question: 'Y',
            multiSelect: false,
            options: [{ label: 'A' }],
          },
        ],
      },
      { toolUseID: 'tu-gone' }
    );
    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Session not found',
      toolUseID: 'tu-gone',
    });
  });
});
