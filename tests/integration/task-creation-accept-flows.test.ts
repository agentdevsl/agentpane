/**
 * Integration tests for additional acceptSuggestion / cancel branches:
 *   - acceptSuggestion waits for streamProcessingPromise before closing
 *   - acceptSuggestion handles v2Session.close throwing (logged, not propagated)
 *   - acceptSuggestion handles sessionService.close throwing
 *   - cancel waits for streamProcessingPromise
 *   - cancel handles v2Session.close throwing
 *
 * Run: npx vitest run --project integration tests/integration/task-creation-accept-flows.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCreationService } from '../../src/services/task-creation.service';
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

describe('TaskCreationService — acceptSuggestion / cancel error paths', () => {
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

  it('acceptSuggestion awaits streamProcessingPromise before closing', async () => {
    sdkMocks.createSession.mockImplementationOnce(() =>
      makeSdkSession([
        makeAssistant(
          '```json\n{"type":"task_suggestion","title":"With BG","description":"d","labels":[],"priority":"low"}\n```'
        ),
      ])
    );
    const codespace = await createTestProject({ name: 'accept-bg' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const sendRes = await service.sendMessage(start.value.id, 'go');
    expect(sendRes.ok).toBe(true);
    const session = service.getSession(start.value.id)!;
    let bgResolved = false;
    session.streamProcessingPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        bgResolved = true;
        resolve();
      }, 30);
    });

    const accept = await service.acceptSuggestion(start.value.id);
    expect(accept.ok).toBe(true);
    expect(bgResolved).toBe(true);
  });

  it('acceptSuggestion swallows v2Session.close throwing', async () => {
    const failingClose = makeSdkSession([
      makeAssistant(
        '```json\n{"type":"task_suggestion","title":"close-throws","description":"d","labels":[],"priority":"low"}\n```'
      ),
    ]);
    failingClose.close = vi.fn().mockImplementation(() => {
      throw new Error('close exploded');
    });
    sdkMocks.createSession.mockImplementationOnce(() => failingClose);

    const codespace = await createTestProject({ name: 'accept-close-fail' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const send = await service.sendMessage(start.value.id, 'go');
    expect(send.ok).toBe(true);

    const accept = await service.acceptSuggestion(start.value.id);
    expect(accept.ok).toBe(true);
    expect(failingClose.close).toHaveBeenCalled();
    // Session has v2Session = null after the close call
    const session = service.getSession(start.value.id)!;
    expect(session.v2Session).toBeNull();
  });

  it('acceptSuggestion swallows sessionService.close throwing', async () => {
    sdkMocks.createSession.mockImplementationOnce(() =>
      makeSdkSession([
        makeAssistant(
          '```json\n{"type":"task_suggestion","title":"sess-close-fail","description":"d","labels":[],"priority":"low"}\n```'
        ),
      ])
    );
    mockSessionService.close.mockRejectedValueOnce(new Error('session-close-error'));

    const codespace = await createTestProject({ name: 'accept-sess-close-fail' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const send = await service.sendMessage(start.value.id, 'go');
    expect(send.ok).toBe(true);

    const accept = await service.acceptSuggestion(start.value.id);
    expect(accept.ok).toBe(true); // error was swallowed
    expect(mockSessionService.close).toHaveBeenCalled();
  });

  it('cancel awaits streamProcessingPromise (when set)', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'cancel-bg-wait' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const session = service.getSession(start.value.id)!;
    let bgResolved = false;
    session.streamProcessingPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        bgResolved = true;
        resolve();
      }, 30);
    });

    const cancel = await service.cancel(start.value.id);
    expect(cancel.ok).toBe(true);
    expect(bgResolved).toBe(true);
  });

  it('cancel swallows v2Session.close throwing', async () => {
    const failingClose = makeSdkSession([]);
    failingClose.close = vi.fn().mockImplementation(() => {
      throw new Error('cancel close exploded');
    });
    sdkMocks.createSession.mockImplementationOnce(() => failingClose);

    const codespace = await createTestProject({ name: 'cancel-close-fail' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const cancel = await service.cancel(start.value.id);
    expect(cancel.ok).toBe(true);
    expect(failingClose.close).toHaveBeenCalled();
  });

  it('cancel returns ok even when streamProcessingPromise rejects (caught + logged)', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const codespace = await createTestProject({ name: 'cancel-bg-reject' });
    const start = await service.startConversation(codespace.id);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const session = service.getSession(start.value.id)!;
    session.streamProcessingPromise = Promise.reject(new Error('bg reject'));
    // Suppress unhandled rejection
    session.streamProcessingPromise.catch(() => undefined);

    const cancel = await service.cancel(start.value.id);
    expect(cancel.ok).toBe(true);
  });
});
