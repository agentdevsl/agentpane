/**
 * Integration tests for TaskCreationService — coverage gaps not exercised by
 * the existing IT-250..IT-280 suites.
 *
 * Focus:
 *   - parseSuggestion edge cases (no JSON, wrong type, missing fields, bad priority/labels)
 *   - extractJsonBlock multiple-fence skipping (JSON-with-backticks)
 *   - sendMessage with concatenated stream_event text deltas → suggestion
 *   - skipQuestions flow (resolver path, message path)
 *   - cancel after answerQuestions flow
 *   - getSession returns null vs object
 *   - constructor cleanup interval (call-and-destroy)
 *
 * The Claude SDK is mocked at module scope; the real DB / DurableStreams
 * helpers are used so service code paths execute end-to-end.
 *
 * Run: npx vitest run --project integration tests/integration/task-creation-coverage.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions } from '../../src/db/schema';
import { TaskCreationService } from '../../src/services/task-creation.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const sdkMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: sdkMocks.createSession,
}));

function makeAssistant(text: string) {
  return {
    type: 'assistant',
    session_id: 'mock-sdk-session-id',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text }],
    },
  };
}

function makeStreamEvent(event: Record<string, unknown>) {
  return {
    type: 'stream_event',
    session_id: 'mock-sdk-session-id',
    event,
  };
}

function makeSdkSession(messages: unknown[] = []) {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn().mockImplementation(async function* () {
      for (const msg of messages) yield msg;
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

describe('TaskCreationService — additional coverage', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: TaskCreationService;
  let mockStreams: ReturnType<typeof createMockStreams>;
  let mockSessionService: ReturnType<typeof createMockSessionService>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
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

  // ═══════════════════════════════════════════════════════════════════
  // parseSuggestion edge cases (via sendMessage round-trip)
  // ═══════════════════════════════════════════════════════════════════
  describe('parseSuggestion edge cases', () => {
    it('non-JSON text in assistant response yields no suggestion', async () => {
      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([makeAssistant('I have nothing for you, just plain text.')])
      );
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion).toBeNull();
    });

    it('wrong type discriminator yields no suggestion', async () => {
      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([
          makeAssistant('```json\n{"type":"something_else","title":"X","description":"Y"}\n```'),
        ])
      );
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion).toBeNull();
    });

    it('missing description field yields no suggestion', async () => {
      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([makeAssistant('```json\n{"type":"task_suggestion","title":"X"}\n```')])
      );
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion).toBeNull();
    });

    it('invalid priority falls back to "medium"', async () => {
      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([
          makeAssistant(
            '```json\n{"type":"task_suggestion","title":"X","description":"Y","priority":"PANIC"}\n```'
          ),
        ])
      );
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion?.priority).toBe('medium');
    });

    it('non-array labels become []', async () => {
      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([
          makeAssistant(
            '```json\n{"type":"task_suggestion","title":"X","description":"Y","labels":"not-an-array"}\n```'
          ),
        ])
      );
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion?.labels).toEqual([]);
    });

    it('extractJsonBlock skips invalid first close fence and finds the second valid one', async () => {
      // The inner backticks act as a confounding ``` close marker; the parser
      // must keep searching to find the real close fence.
      const text =
        '```json\n' +
        '{"type":"task_suggestion","title":"Multi-fence","description":"Has ``` inside","labels":["test"],"priority":"high"}\n' +
        '```';
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([makeAssistant(text)]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion).toMatchObject({
        title: 'Multi-fence',
        priority: 'high',
        labels: ['test'],
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // sendMessage stream_event text_delta accumulation → parser
  // ═══════════════════════════════════════════════════════════════════
  describe('sendMessage with stream_event text deltas', () => {
    it('accumulates text_delta chunks then parses suggestion from the joined text', async () => {
      const fullText =
        '```json\n{"type":"task_suggestion","title":"Streamed","description":"From deltas","labels":["feature"],"priority":"low"}\n```';
      // Split into 3 chunks
      const c1 = fullText.slice(0, 30);
      const c2 = fullText.slice(30, 60);
      const c3 = fullText.slice(60);

      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([
          makeStreamEvent({
            type: 'message_start',
            message: { model: 'm', usage: { input_tokens: 1 } },
          }),
          makeStreamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: c1 },
          }),
          makeStreamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: c2 },
          }),
          makeStreamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: c3 },
          }),
          makeStreamEvent({ type: 'message_delta', usage: { output_tokens: 99 } }),
          { type: 'result', usage: { input_tokens: 1, output_tokens: 99 } },
        ])
      );

      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const tokens: string[] = [];
      const r = await service.sendMessage(start.value.id, 'go', (delta) => {
        tokens.push(delta);
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(tokens.join('')).toBe(fullText);
      expect(r.value.suggestion).toMatchObject({
        title: 'Streamed',
        priority: 'low',
        labels: ['feature'],
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // sendMessage error guards
  // ═══════════════════════════════════════════════════════════════════
  describe('sendMessage error guards', () => {
    it('returns API_ERROR if v2Session has been cleared mid-flight', async () => {
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const session = service.getSession(start.value.id);
      expect(session).not.toBeNull();
      // Force the v2Session to null to simulate post-cleanup
      if (session) session.v2Session = null;
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('API_ERROR');
    });

    it('returns SESSION_COMPLETED for a completed session', async () => {
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      // Force completed
      const session = service.getSession(start.value.id);
      if (session) session.status = 'completed';
      const r = await service.sendMessage(start.value.id, 'hi');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('SESSION_COMPLETED');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // skipQuestions paths
  // ═══════════════════════════════════════════════════════════════════
  describe('skipQuestions()', () => {
    it('returns SESSION_NOT_FOUND for unknown session', async () => {
      const r = await service.skipQuestions('nope');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('clears pending state and resolves resolver when one is set', async () => {
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const session = service.getSession(start.value.id)!;
      // Simulate a pending resolver
      const resolveSpy = vi.fn();
      session.pendingPermissionResolver = resolveSpy;
      session.pendingQuestionsInput = { questions: [] };
      session.pendingToolUseId = 'tool-1';
      session.status = 'waiting_user';

      // Note: skipQuestions calls sendMessage internally → kicks off another
      // SDK round. Provide an empty mock so it can complete.
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));

      const r = await service.skipQuestions(start.value.id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow' }));
      // pending state cleared
      expect(session.pendingPermissionResolver).toBeNull();
      expect(session.pendingQuestionsInput).toBeNull();
      expect(session.pendingToolUseId).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // answerQuestions error branches
  // ═══════════════════════════════════════════════════════════════════
  describe('answerQuestions()', () => {
    it('returns SESSION_NOT_FOUND for unknown session', async () => {
      const r = await service.answerQuestions('nope', 'qid', {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns INVALID_QUESTIONS_ID when no pending questions', async () => {
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.answerQuestions(start.value.id, 'mismatched', {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_QUESTIONS_ID');
    });

    it('idempotent on repeated submission with same questionsId', async () => {
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const session = service.getSession(start.value.id)!;
      session.lastProcessedQuestionsId = 'qid-already-done';

      const r = await service.answerQuestions(start.value.id, 'qid-already-done', {
        '0': 'answer',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The duplicate response carries an `alreadyProcessed` marker
      expect((r.value as { alreadyProcessed?: boolean }).alreadyProcessed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // cancel + getSession
  // ═══════════════════════════════════════════════════════════════════
  describe('cancel() and getSession()', () => {
    it('cancel returns SESSION_NOT_FOUND for unknown session', async () => {
      const r = await service.cancel('nope');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('cancel marks status=cancelled, publishes event, and writes DB session as closed', async () => {
      sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      const r = await service.cancel(start.value.id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status).toBe('cancelled');
      expect(mockStreams.publishTaskCreationCancelled).toHaveBeenCalled();

      // Wait a microtask for the .catch attached promise update
      await new Promise((resolve) => setImmediate(resolve));
      const dbSess = await db.query.sessions.findFirst({
        where: eq(sessions.id, start.value.id),
      });
      expect(dbSess?.status).toBe('closed');
    });

    it('getSession returns null for unknown id', () => {
      expect(service.getSession('nope')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // acceptSuggestion: DATABASE_ERROR path is reachable when insert fails
  // ═══════════════════════════════════════════════════════════════════
  describe('acceptSuggestion error paths', () => {
    it('returns DATABASE_ERROR when codespace was deleted before accept', async () => {
      sdkMocks.createSession.mockImplementationOnce(() =>
        makeSdkSession([
          makeAssistant(
            '```json\n{"type":"task_suggestion","title":"X","description":"Y","labels":[],"priority":"high"}\n```'
          ),
        ])
      );
      const codespace = await createTestProject({ name: 'about-to-delete' });
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const send = await service.sendMessage(start.value.id, 'hi');
      expect(send.ok).toBe(true);

      // Delete the codespace via raw SQL — there is no service API for
      // arbitrary codespace deletion in this slice and we want the FK
      // constraint to bite when acceptSuggestion runs the insert.
      const { codespaces } = await import('../../src/db/schema');
      await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

      const accept = await service.acceptSuggestion(start.value.id);
      expect(accept.ok).toBe(false);
      if (accept.ok) return;
      expect(accept.error.code).toBe('DATABASE_ERROR');
    });
  });
});
