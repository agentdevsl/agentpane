/**
 * Integration tests for cleanupIdleSessions, getAssistantText, and a few
 * more targeted branches in TaskCreationService.
 *
 * Run: npx vitest run --project integration tests/integration/task-creation-cleanup.test.ts
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

describe('TaskCreationService — cleanup, getAssistantText, leftover branches', () => {
  let mockStreams: ReturnType<typeof createMockStreams>;

  beforeEach(async () => {
    await setupTestDatabase();
    mockStreams = createMockStreams();
    sdkMocks.createSession.mockReset();
    sdkMocks.createSession.mockImplementation(() => makeSdkSession());
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  it('cleanupIdleSessions removes sessions whose lastActivityAt is older than the idle timeout', async () => {
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([]));
    const db = getTestDb();
    const service = new TaskCreationService(
      db as never,
      mockStreams as never,
      undefined,
      undefined
    );
    try {
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const session = service.getSession(start.value.id)!;
      // Force lastActivityAt to be 2 hours ago — exceeds the 30m timeout
      session.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;
      // Trigger the private cleanup directly via cast
      (service as unknown as { cleanupIdleSessions: () => void }).cleanupIdleSessions();
      expect(service.getSession(start.value.id)).toBeNull();
    } finally {
      service.destroy();
    }
  });

  it('multi-text-block assistant message: getAssistantText concatenates text fragments', async () => {
    sdkMocks.createSession.mockImplementationOnce(() =>
      makeSdkSession([
        {
          type: 'assistant',
          session_id: 'mock-sdk-session-id',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [
              { type: 'text', text: 'Part one. ' },
              { type: 'text', text: 'Part two. ' },
              {
                type: 'text',
                text: '```json\n{"type":"task_suggestion","title":"MultiText","description":"Joined parts","labels":[],"priority":"low"}\n```',
              },
            ],
          },
        },
      ])
    );
    const db = getTestDb();
    const service = new TaskCreationService(
      db as never,
      mockStreams as never,
      undefined,
      undefined
    );
    try {
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'go');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion?.title).toBe('MultiText');
    } finally {
      service.destroy();
    }
  });

  it('extractJsonBlock returns null when no opening ```json fence is found', async () => {
    sdkMocks.createSession.mockImplementationOnce(() =>
      makeSdkSession([makeAssistant('I will say nothing structured.')])
    );
    const db = getTestDb();
    const service = new TaskCreationService(
      db as never,
      mockStreams as never,
      undefined,
      undefined
    );
    try {
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'go');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.suggestion).toBeNull();
    } finally {
      service.destroy();
    }
  });

  it('parseClarifyingQuestions: a question with empty options is filtered out', async () => {
    const text =
      '```json\n' +
      JSON.stringify({
        type: 'clarifying_questions',
        questions: [
          { header: 'NoOpts', question: 'Q?', options: [] }, // filtered
          {
            header: 'Valid',
            question: 'Q2?',
            options: [{ label: 'A' }],
            multiSelect: false,
          },
        ],
      }) +
      '\n```';
    sdkMocks.createSession.mockImplementationOnce(() => makeSdkSession([makeAssistant(text)]));
    const db = getTestDb();
    const service = new TaskCreationService(
      db as never,
      mockStreams as never,
      undefined,
      undefined
    );
    try {
      const codespace = await createTestProject();
      const start = await service.startConversation(codespace.id);
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const r = await service.sendMessage(start.value.id, 'go');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Only the second question survives the filter
      expect(r.value.pendingQuestions?.questions.length).toBe(1);
      expect(r.value.pendingQuestions?.questions[0].header).toBe('Valid');
    } finally {
      service.destroy();
    }
  });
});
