import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import { DEFAULT_TASK_CREATION_MODEL, getFullModelId } from '../../src/lib/constants/models';
import { DEFAULT_TASK_CREATION_TOOLS } from '../../src/lib/constants/tools';
import { SettingsService } from '../../src/services/settings.service';
import type { PermissionResolver } from '../../src/services/task-creation-sdk.service';
import { TaskCreationSdkService } from '../../src/services/task-creation-sdk.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
}));

describe('TaskCreationSdkService — SDK orchestration integration tests', () => {
  let settingsService: SettingsService;
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    await db.delete(settings);
    settingsService = new SettingsService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-382: The service can be constructed with proper dependencies', () => {
    const serviceWithSettings = new TaskCreationSdkService(settingsService);
    expect(serviceWithSettings).toBeInstanceOf(TaskCreationSdkService);

    // Also works without settingsService (optional dependency)
    const serviceWithout = new TaskCreationSdkService();
    expect(serviceWithout).toBeInstanceOf(TaskCreationSdkService);

    const serviceUndefined = new TaskCreationSdkService(undefined);
    expect(serviceUndefined).toBeInstanceOf(TaskCreationSdkService);
  });

  it('IT-383: Model resolution from SettingsService: stored taskCreation.model is used', async () => {
    // Store a specific task creation model in settings
    const setResult = await settingsService.setTaskCreationModel('claude-haiku-4-5');
    expect(setResult.ok).toBe(true);

    const service = new TaskCreationSdkService(settingsService);
    const model = await service.resolveModel();

    // SettingsService.getTaskCreationModel returns the raw stored value
    // (model ID resolution happens at a different layer)
    expect(model).toBe('claude-haiku-4-5');
  });

  it('IT-384: Model resolution fallback: no setting uses DEFAULT_TASK_CREATION_MODEL', async () => {
    // No taskCreation.model set in the database — settingsService returns its own default
    const serviceWithSettings = new TaskCreationSdkService(settingsService);
    const modelWithSettings = await serviceWithSettings.resolveModel();
    // SettingsService.getTaskCreationModel falls back to DEFAULT_AGENT_MODEL's full ID
    expect(typeof modelWithSettings).toBe('string');
    expect(modelWithSettings).toBeTruthy();

    // Without settingsService, falls back to DEFAULT_TASK_CREATION_MODEL
    const serviceWithout = new TaskCreationSdkService();
    const modelWithout = await serviceWithout.resolveModel();
    expect(modelWithout).toBe(getFullModelId(DEFAULT_TASK_CREATION_MODEL));
  });

  it('IT-385: canUseTool callback: AskUserQuestion is handled specially, other tools are allowed', async () => {
    const service = new TaskCreationSdkService(settingsService);

    const sessionState = {
      pendingToolUseId: null as string | null,
      pendingQuestionsInput: null as Record<string, unknown> | null,
      pendingPermissionResolver: null as PermissionResolver | null,
      status: 'active',
      questionRound: 0,
      totalQuestionsAsked: 0,
      pendingQuestions: null as any,
      questionsReadyResolver: null as (() => void) | null,
      questionsReadyPromise: null as Promise<void> | null,
    };

    const onQuestionsCalled: Array<{ toolUseId: string }> = [];
    const onQuestions = vi.fn(async (_questions, toolUseId, _rawInput, _resolve) => {
      onQuestionsCalled.push({ toolUseId });
    });

    const canUseTool = service.buildCanUseTool('test-session-id', () => sessionState, onQuestions);

    // Non-AskUserQuestion tools should be immediately allowed
    const readResult = await canUseTool('Read', {}, { toolUseID: 'tool-1' } as any);
    expect(readResult).toEqual({ behavior: 'allow', toolUseID: 'tool-1' });

    const grepResult = await canUseTool('Grep', {}, { toolUseID: 'tool-2' } as any);
    expect(grepResult).toEqual({ behavior: 'allow', toolUseID: 'tool-2' });

    const bashResult = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tool-3' } as any);
    expect(bashResult).toEqual({ behavior: 'allow', toolUseID: 'tool-3' });

    // AskUserQuestion with valid questions should trigger the onQuestions callback
    // and return a promise (which we resolve manually)
    const askPromise = canUseTool(
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Test',
            question: 'What type?',
            multiSelect: false,
            options: [{ label: 'Option A' }, { label: 'Option B', description: 'Desc B' }],
          },
        ],
      },
      { toolUseID: 'tool-ask-1' } as any
    );

    // onQuestions should have been called
    expect(onQuestions).toHaveBeenCalledTimes(1);
    expect(onQuestionsCalled[0]?.toolUseId).toBe('tool-ask-1');

    // Session state should reflect waiting_user
    expect(sessionState.status).toBe('waiting_user');
    expect(sessionState.questionRound).toBe(1);
    expect(sessionState.totalQuestionsAsked).toBe(1);
    expect(sessionState.pendingToolUseId).toBe('tool-ask-1');

    // Resolve the pending permission to unblock the promise
    const resolverCall = onQuestions.mock.calls[0];
    const resolve = resolverCall[3] as PermissionResolver;
    resolve({ behavior: 'allow' as const, toolUseID: 'tool-ask-1' });

    const askResult = await askPromise;
    expect(askResult).toEqual({ behavior: 'allow', toolUseID: 'tool-ask-1' });
  });

  it('IT-385b: canUseTool callback: AskUserQuestion with empty questions array is allowed immediately', async () => {
    const service = new TaskCreationSdkService(settingsService);

    const sessionState = {
      pendingToolUseId: null as string | null,
      pendingQuestionsInput: null as Record<string, unknown> | null,
      pendingPermissionResolver: null as PermissionResolver | null,
      status: 'active',
      questionRound: 0,
      totalQuestionsAsked: 0,
      pendingQuestions: null as any,
      questionsReadyResolver: null as (() => void) | null,
      questionsReadyPromise: null as Promise<void> | null,
    };

    const onQuestions = vi.fn();

    const canUseTool = service.buildCanUseTool('test-session-id', () => sessionState, onQuestions);

    // Empty questions array should be allowed immediately without calling onQuestions
    const result = await canUseTool('AskUserQuestion', { questions: [] }, {
      toolUseID: 'tool-empty',
    } as any);

    expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-empty' });
    expect(onQuestions).not.toHaveBeenCalled();
    expect(sessionState.status).toBe('active');
  });

  it('IT-385c: canUseTool callback: question limit enforcement (max 4 questions)', async () => {
    const service = new TaskCreationSdkService(settingsService);

    const sessionState = {
      pendingToolUseId: null as string | null,
      pendingQuestionsInput: null as Record<string, unknown> | null,
      pendingPermissionResolver: null as PermissionResolver | null,
      status: 'active',
      questionRound: 0,
      totalQuestionsAsked: 4, // Already at max
      pendingQuestions: null as any,
      questionsReadyResolver: null as (() => void) | null,
      questionsReadyPromise: null as Promise<void> | null,
    };

    const onQuestions = vi.fn();

    const canUseTool = service.buildCanUseTool('test-session-id', () => sessionState, onQuestions);

    // When max questions already asked, AskUserQuestion should be allowed (bypassed)
    const result = await canUseTool(
      'AskUserQuestion',
      {
        questions: [
          { header: 'Extra', question: 'More?', multiSelect: false, options: [{ label: 'Yes' }] },
        ],
      },
      { toolUseID: 'tool-over-limit' } as any
    );

    expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-over-limit' });
    expect(onQuestions).not.toHaveBeenCalled();
    // totalQuestionsAsked should remain unchanged
    expect(sessionState.totalQuestionsAsked).toBe(4);
  });

  it('IT-385d: canUseTool callback: questions are truncated when approaching the limit', async () => {
    const service = new TaskCreationSdkService(settingsService);

    const sessionState = {
      pendingToolUseId: null as string | null,
      pendingQuestionsInput: null as Record<string, unknown> | null,
      pendingPermissionResolver: null as PermissionResolver | null,
      status: 'active',
      questionRound: 0,
      totalQuestionsAsked: 3, // Only 1 remaining of the 4 max
      pendingQuestions: null as any,
      questionsReadyResolver: null as (() => void) | null,
      questionsReadyPromise: null as Promise<void> | null,
    };

    const onQuestions = vi.fn(
      async (_questions, _toolUseId, _rawInput, resolve: PermissionResolver) => {
        resolve({ behavior: 'allow' as const, toolUseID: _toolUseId });
      }
    );

    const canUseTool = service.buildCanUseTool('test-session-id', () => sessionState, onQuestions);

    // Send 3 questions but only 1 should be processed (remaining = 4 - 3 = 1)
    const result = await canUseTool(
      'AskUserQuestion',
      {
        questions: [
          { header: 'Q1', question: 'First?', multiSelect: false, options: [{ label: 'A' }] },
          { header: 'Q2', question: 'Second?', multiSelect: false, options: [{ label: 'B' }] },
          { header: 'Q3', question: 'Third?', multiSelect: false, options: [{ label: 'C' }] },
        ],
      },
      { toolUseID: 'tool-truncate' } as any
    );

    expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-truncate' });
    expect(onQuestions).toHaveBeenCalledTimes(1);

    // The pending questions should only have 1 question (truncated from 3)
    const pendingArg = onQuestions.mock.calls[0][0];
    expect(pendingArg.questions).toHaveLength(1);
    expect(pendingArg.questions[0].header).toBe('Q1');
    expect(pendingArg.totalAsked).toBe(4); // 3 + 1
    expect(pendingArg.maxQuestions).toBe(4);
  });

  it('IT-385e: canUseTool callback: null session returns deny', async () => {
    const service = new TaskCreationSdkService(settingsService);

    const canUseTool = service.buildCanUseTool(
      'test-session-id',
      () => null, // Session not found
      vi.fn()
    );

    const result = await canUseTool(
      'AskUserQuestion',
      { questions: [{ header: 'Q', question: 'Q?', multiSelect: false, options: [] }] },
      { toolUseID: 'tool-null' } as any
    );

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Session not found',
      toolUseID: 'tool-null',
    });
  });

  it('IT-386: buildAllowedTools ensures AskUserQuestion is always included', () => {
    const service = new TaskCreationSdkService(settingsService);

    // Default tools already include AskUserQuestion
    const defaultTools = service.buildAllowedTools();
    expect(defaultTools).toEqual(DEFAULT_TASK_CREATION_TOOLS);
    expect(defaultTools).toContain('AskUserQuestion');

    // Custom tools without AskUserQuestion — should be appended
    const customTools = service.buildAllowedTools(['Read', 'Bash']);
    expect(customTools).toEqual(['Read', 'Bash', 'AskUserQuestion']);

    // Custom tools already including AskUserQuestion — no duplicate
    const toolsWithAsk = service.buildAllowedTools(['Read', 'AskUserQuestion', 'Grep']);
    expect(toolsWithAsk).toEqual(['Read', 'AskUserQuestion', 'Grep']);
    expect(toolsWithAsk.filter((t) => t === 'AskUserQuestion')).toHaveLength(1);
  });

  it('IT-387: Settings service integration: getTaskCreationModel returns the stored value', async () => {
    // Set a specific task creation model via SettingsService
    const setResult = await settingsService.setTaskCreationModel('claude-opus-4-5');
    expect(setResult.ok).toBe(true);

    // Read it back through SettingsService — returns the raw stored value
    const model = await settingsService.getTaskCreationModel();
    expect(model).toBe('claude-opus-4-5');

    // Verify it flows through TaskCreationSdkService.resolveModel()
    const service = new TaskCreationSdkService(settingsService);
    const resolved = await service.resolveModel();
    expect(resolved).toBe('claude-opus-4-5');
  });

  it('IT-387b: Settings service integration: getTaskCreationModel returns default when not set', async () => {
    // No task creation model stored — should return the default
    const model = await settingsService.getTaskCreationModel();
    expect(typeof model).toBe('string');
    expect(model).toBeTruthy();

    // The service should also resolve to a valid model
    const service = new TaskCreationSdkService(settingsService);
    const resolved = await service.resolveModel();
    expect(typeof resolved).toBe('string');
    expect(resolved).toBeTruthy();
  });

  it('IT-386b: createSession calls unstable_v2_createSession with correct arguments', async () => {
    const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
    const mockCreateSession = vi.mocked(unstable_v2_createSession);
    const mockSession = { send: vi.fn(), stream: vi.fn(), close: vi.fn() };
    mockCreateSession.mockReturnValue(mockSession as any);

    const service = new TaskCreationSdkService(settingsService);
    const canUseTool = vi.fn();
    const allowedTools = ['Read', 'Glob', 'AskUserQuestion'];

    const session = service.createSession('claude-sonnet-4-6', allowedTools, canUseTool);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateSession.mock.calls[0][0] as any;
    expect(callArgs.model).toBe('claude-sonnet-4-6');
    expect(callArgs.allowedTools).toEqual(allowedTools);
    expect(callArgs.canUseTool).toBe(canUseTool);
    expect(callArgs.env).toBeDefined();
    expect(callArgs.env.CLAUDE_CODE_ENABLE_TASKS).toBe('true');
    expect(callArgs.env.DEBUG_CLAUDE_AGENT_SDK).toBe('1');
    expect(session).toBe(mockSession);
  });

  it('IT-386c: SDK environment excludes sensitive variables', async () => {
    const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
    const mockCreateSession = vi.mocked(unstable_v2_createSession);
    mockCreateSession.mockClear();
    mockCreateSession.mockReturnValue({ send: vi.fn(), stream: vi.fn(), close: vi.fn() } as any);

    // Save only the keys we're about to modify
    const savedDbUrl = process.env.DATABASE_URL;
    const savedEncKey = process.env.ENCRYPTION_KEY;
    const savedSessionSecret = process.env.SESSION_SECRET;

    process.env.DATABASE_URL = 'sqlite:///secret.db';
    process.env.ENCRYPTION_KEY = 'super-secret-key';
    process.env.SESSION_SECRET = 'session-secret';
    process.env.SAFE_VAR = 'safe-value';

    try {
      const service = new TaskCreationSdkService(settingsService);
      service.createSession('claude-sonnet-4-6', ['Read'], vi.fn());

      const callArgs = mockCreateSession.mock.calls[0][0] as any;
      const env = callArgs.env;

      // Sensitive vars should be excluded by buildSdkEnv
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.SESSION_SECRET).toBeUndefined();

      // Safe vars should be present
      expect(env.SAFE_VAR).toBe('safe-value');

      // Extra vars from createSession should be present
      expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('true');
    } finally {
      // Restore original env — delete if originally undefined to avoid "undefined" string
      for (const [key, saved] of [
        ['DATABASE_URL', savedDbUrl],
        ['ENCRYPTION_KEY', savedEncKey],
        ['SESSION_SECRET', savedSessionSecret],
      ] as const) {
        if (saved === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved;
        }
      }
      delete process.env.SAFE_VAR;
    }
  });
});
