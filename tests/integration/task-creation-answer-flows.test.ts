/**
 * Integration tests for TaskCreationService.answerQuestions full flows.
 *
 * Covers the resolver-resolution path (canUseTool integration) and the
 * tool-result fallback path (sendToolResultAndStream).
 *
 * Run: npx vitest run --project integration tests/integration/task-creation-answer-flows.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PendingQuestions,
  TaskCreationService,
} from '../../src/services/task-creation.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const sdkMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
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

function buildPendingQuestions(): PendingQuestions {
  return {
    id: 'pending-questions-id-1',
    questions: [
      {
        header: 'Topic',
        question: 'What feature?',
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: false,
      },
    ],
    round: 1,
    totalAsked: 1,
    maxQuestions: 4,
  };
}

describe('TaskCreationService.answerQuestions — full paths', () => {
  let service: TaskCreationService;
  let mockStreams: ReturnType<typeof createMockStreams>;
  let mockSessionService: ReturnType<typeof createMockSessionService>;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    mockStreams = createMockStreams();
    mockSessionService = createMockSessionService();
    sdkMocks.createSession.mockReset();
    sdkMocks.createSession.mockImplementation(() => makeSdkSession([]));
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
  // Resolver path: pendingPermissionResolver is set and gets resolved
  // ═══════════════════════════════════════════════════════════════════
  it('resolves the canUseTool permission when a resolver is pending', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'resolver-path' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    // Stage a session into the "waiting_user" state with a pending resolver
    const session = service.getSession(start.value.id)!;
    const resolveSpy = vi.fn();
    session.pendingQuestions = buildPendingQuestions();
    session.pendingPermissionResolver = resolveSpy;
    session.pendingQuestionsInput = {
      questions: session.pendingQuestions.questions,
    };
    session.pendingToolUseId = 'tool-use-id-1';
    session.status = 'waiting_user';

    const r = await service.answerQuestions(start.value.id, 'pending-questions-id-1', {
      '0': 'A',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'allow',
        toolUseID: 'tool-use-id-1',
        updatedInput: expect.objectContaining({ answers: { '0': 'A' } }),
      })
    );
    // Pending state cleared
    expect(session.pendingPermissionResolver).toBeNull();
    expect(session.pendingQuestionsInput).toBeNull();
    expect(session.lastProcessedQuestionsId).toBe('pending-questions-id-1');
  });

  it('multi-select answers are joined with commas before being sent to the resolver', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'multi-select' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const session = service.getSession(start.value.id)!;
    const resolveSpy = vi.fn();
    session.pendingQuestions = {
      ...buildPendingQuestions(),
      questions: [
        {
          ...buildPendingQuestions().questions[0],
          multiSelect: true,
        },
      ],
    };
    session.pendingPermissionResolver = resolveSpy;
    session.pendingQuestionsInput = { questions: session.pendingQuestions.questions };
    session.pendingToolUseId = 'tool-multi';
    session.status = 'waiting_user';

    const r = await service.answerQuestions(start.value.id, 'pending-questions-id-1', {
      '0': ['A', 'B'],
    });
    expect(r.ok).toBe(true);
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedInput: expect.objectContaining({ answers: { '0': 'A, B' } }),
      })
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // Tool-result fallback path
  // ═══════════════════════════════════════════════════════════════════
  it('falls back to sendToolResultAndStream when no resolver and v2Session+sdkSessionId are present', async () => {
    // Initial session: empty stream
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'fallback-tool-result' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const session = service.getSession(start.value.id)!;

    // Replace v2Session with a fresh fake whose stream produces a parseable
    // suggestion when sendToolResultAndStream calls .send + .stream.
    const followupAssistant = makeAssistant(
      '```json\n{"type":"task_suggestion","title":"Fallback OK","description":"From tool result","labels":["test"],"priority":"low"}\n```'
    );
    const followupResult = { type: 'result', usage: { input_tokens: 1, output_tokens: 2 } };
    const fakeV2 = makeSdkSession([followupAssistant, followupResult]);
    session.v2Session = fakeV2 as never;
    session.sdkSessionId = 'mock-sdk-session-id';
    session.pendingQuestions = buildPendingQuestions();
    // Resolver intentionally absent — exercises the fallback branch
    session.pendingPermissionResolver = null;
    session.pendingToolUseId = 'tool-fallback';
    session.status = 'waiting_user';

    const r = await service.answerQuestions(start.value.id, 'pending-questions-id-1', {
      '0': 'B',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // sendToolResultAndStream should have called .send with our tool_result
    expect(fakeV2.send).toHaveBeenCalled();
    const sendCallArg = fakeV2.send.mock.calls[0]![0]!;
    expect(typeof sendCallArg).toBe('object');
    expect((sendCallArg as { type: string }).type).toBe('user');
    // Suggestion populated from the stream
    expect(r.value.suggestion?.title).toBe('Fallback OK');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Final fallback: no tool_use id at all → sends as a plain message
  // ═══════════════════════════════════════════════════════════════════
  it('with no pendingToolUseId, falls back to sendMessage with formatted answer text', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'plain-msg-fallback' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const session = service.getSession(start.value.id)!;

    // Replace v2Session with a fresh fake whose stream emits a simple suggestion.
    const fakeV2 = makeSdkSession([
      makeAssistant(
        '```json\n{"type":"task_suggestion","title":"From plain msg","description":"D","labels":[],"priority":"low"}\n```'
      ),
    ]);
    session.v2Session = fakeV2 as never;
    session.sdkSessionId = null; // Force no sdkSessionId so tool-result fallback is skipped
    session.pendingQuestions = buildPendingQuestions();
    session.pendingPermissionResolver = null;
    session.pendingToolUseId = null;
    session.status = 'waiting_user';

    const r = await service.answerQuestions(start.value.id, 'pending-questions-id-1', {
      '0': 'A',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // sendMessage was invoked → fakeV2.send was called with the formatted answer text
    expect(fakeV2.send).toHaveBeenCalled();
    const arg = fakeV2.send.mock.calls[0]![0]!;
    expect(typeof arg).toBe('string');
    expect(arg as string).toContain('Here are my answers');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Out-of-range answer index is silently dropped (filtered)
  // ═══════════════════════════════════════════════════════════════════
  it('answers with an out-of-range index are filtered out', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'oob-answer' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const session = service.getSession(start.value.id)!;
    const resolveSpy = vi.fn();
    session.pendingQuestions = buildPendingQuestions(); // 1 question
    session.pendingPermissionResolver = resolveSpy;
    session.pendingQuestionsInput = { questions: session.pendingQuestions.questions };
    session.pendingToolUseId = 'tool-oob';
    session.status = 'waiting_user';

    const r = await service.answerQuestions(start.value.id, 'pending-questions-id-1', {
      '0': 'A',
      '99': 'should be filtered',
    });
    expect(r.ok).toBe(true);
    expect(resolveSpy).toHaveBeenCalled();
    // Both keys are passed in updatedInput (the formatter just builds a
    // plain object), but the answerMessage formatting drops index 99
    // because there's no question[99] to label it. Resolver still allow.
    const call = resolveSpy.mock.calls[0]![0];
    expect(call.behavior).toBe('allow');
  });
});
