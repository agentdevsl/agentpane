import {
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  unstable_v2_createSession,
} from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { codespaces, type NewTask, sessions, tasks } from '@/db/schema';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('TaskCreationService');

import { buildSdkEnv } from '@/lib/agents/agent-sdk-utils';
import { DEFAULT_TASK_CREATION_MODEL, getFullModelId } from '@/lib/constants/models';
import { DEFAULT_TASK_CREATION_TOOLS } from '@/lib/constants/tools';
import { getPromptDefaultText, resolvePromptServer } from '@/lib/prompts';
import type { Result } from '@/lib/utils/result';
import { err, ok } from '@/lib/utils/result';
import type { Database } from '@/types/database';
import type { DurableStreamsService } from './durable-streams.service';
import type { SessionService } from './session.service';
import type { SettingsService } from './settings.service';

// ============================================================================
// Types
// ============================================================================

export type TaskPriority = 'high' | 'medium' | 'low';

export interface TaskSuggestion {
  title: string;
  description: string;
  labels: string[];
  priority: TaskPriority;
}

export interface ClarifyingQuestionOption {
  label: string;
  description?: string;
}

export interface ClarifyingQuestion {
  header: string;
  question: string;
  options: ClarifyingQuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestions {
  id: string;
  questions: ClarifyingQuestion[];
  round: number;
  totalAsked: number;
  maxQuestions: number;
}

export interface TaskCreationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type TaskCreationSessionStatus = 'active' | 'waiting_user' | 'completed' | 'cancelled';

/** V2 Session interface - matches SDK's SDKSession */
interface V2Session {
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage>;
  close(): void;
}

/** SDK User Message for tool results */
interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
  };
  parent_tool_use_id: string | null;
  tool_use_result?: unknown;
  session_id: string;
}

/** Resolver function for pending AskUserQuestion permission */
type PermissionResolver = (result: PermissionResult) => void;

export interface TaskCreationSession {
  id: string;
  codespaceId: string;
  status: TaskCreationSessionStatus;
  messages: TaskCreationMessage[];
  suggestion: TaskSuggestion | null;
  pendingQuestions: PendingQuestions | null;
  questionRound: number;
  totalQuestionsAsked: number;
  createdTaskId: string | null;
  createdAt: string;
  completedAt: string | null;
  /** SDK session ID for resuming */
  sdkSessionId: string | null;
  pendingToolUseId: string | null;
  /** V2 session object */
  v2Session: V2Session | null;
  /** Whether system prompt has been sent */
  systemPromptSent: boolean;
  /** Database session ID for history tracking */
  dbSessionId: string | null;
  /** Resolver for pending AskUserQuestion permission - call with answers to continue */
  pendingPermissionResolver: PermissionResolver | null;
  /** Store questions input while waiting for user answers */
  pendingQuestionsInput: Record<string, unknown> | null;
  /** Active stream iterator - persists across permission pauses to maintain SDK state */
  activeStreamIterator: AsyncGenerator<SDKMessage> | null;
  /** Promise that resolves when the current stream processing completes */
  streamProcessingPromise: Promise<void> | null;
  /** Callback for when background processor finds a suggestion - used to send SSE events */
  onSuggestionCallback: SuggestionCallback | null;
  /** Callback for when background processor publishes an assistant message - used to send SSE events */
  onMessageCallback: MessageCallback | null;
  /** Promise that resolves when questions are ready */
  questionsReadyPromise: Promise<void> | null;
  /** Resolver for questionsReadyPromise */
  questionsReadyResolver: (() => void) | null;
  /** Last activity timestamp for idle session cleanup */
  lastActivityAt: number;
  /** Most recently processed questionsId -- used to deduplicate retried answer submissions for the same question round */
  lastProcessedQuestionsId: string | null;
}

export interface TaskCreationError {
  code: string;
  message: string;
}

// ============================================================================
// Error Definitions
// ============================================================================

export const TaskCreationErrors = {
  PROJECT_NOT_FOUND: {
    code: 'PROJECT_NOT_FOUND',
    message: 'Project not found.',
  },
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    message: 'Task creation session not found.',
  },
  NO_SUGGESTION: {
    code: 'NO_SUGGESTION',
    message: 'No task suggestion available to accept.',
  },
  MESSAGE_TOO_LONG: {
    code: 'MESSAGE_TOO_LONG',
    message: 'Message content exceeds maximum allowed length.',
  },
  SESSION_COMPLETED: (sessionId: string) => ({
    code: 'SESSION_COMPLETED',
    message: `Session ${sessionId} is already completed.`,
  }),
  API_ERROR: (message: string) => ({
    code: 'API_ERROR',
    message: `Claude API error: ${message}`,
  }),
  DATABASE_ERROR: (operation: string, message: string) => ({
    code: 'DATABASE_ERROR',
    message: `Database ${operation} failed: ${message}`,
  }),
} as const;

// ============================================================================
// Constants
// ============================================================================

/** Fallback system prompt when settingsService is unavailable */
const SYSTEM_PROMPT_DEFAULT = getPromptDefaultText('task-creation');

// ============================================================================
// Service Implementation
// ============================================================================

export type TokenCallback = (delta: string, accumulated: string) => void;
export type SuggestionCallback = (suggestion: TaskSuggestion) => void;
export type MessageCallback = (
  messageId: string,
  role: 'user' | 'assistant',
  content: string
) => void;

export class TaskCreationService {
  private sessions = new Map<string, TaskCreationSession>();
  /** Token buffers for batching token publishes */
  private tokenBuffers = new Map<string, { chunks: string[]; lastFlush: number }>();
  /** Interval for cleaning up idle sessions */
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Maximum idle time before session cleanup (30 minutes) */
  private static readonly SESSION_IDLE_TIMEOUT = 30 * 60 * 1000;
  /** Cleanup check interval (5 minutes) */
  private static readonly CLEANUP_INTERVAL = 5 * 60 * 1000;
  /** Token batch flush interval (50ms) */
  private static readonly TOKEN_FLUSH_INTERVAL = 50;
  /** Token batch size threshold */
  private static readonly TOKEN_BATCH_SIZE = 10;

  constructor(
    private db: Database,
    private streams: DurableStreamsService,
    private sessionService?: SessionService,
    private settingsService?: SettingsService
  ) {
    // Start periodic cleanup of abandoned sessions
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, TaskCreationService.CLEANUP_INTERVAL);
  }

  /**
   * Clean up sessions that have been idle for too long
   */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions) {
      const idleTime = now - session.lastActivityAt;
      if (idleTime > TaskCreationService.SESSION_IDLE_TIMEOUT) {
        // Clean up abandoned session
        if (session.v2Session) {
          try {
            session.v2Session.close();
          } catch (closeErr) {
            log.warn('Failed to close abandoned V2 session', {
              error: closeErr instanceof Error ? (closeErr as Error).message : String(closeErr),
            });
          }
        }
        this.sessions.delete(sessionId);
        // Mark DB session as closed
        this.db
          .update(sessions)
          .set({ status: 'closed', closedAt: new Date().toISOString() })
          .where(eq(sessions.id, sessionId))
          .catch((err) =>
            log.warn('Failed to mark idle session as closed in DB', {
              error: err instanceof Error ? err.message : String(err),
            })
          );
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      log.info(`Cleaned up ${cleanedCount} idle sessions`);
    }
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Update session activity timestamp */
  private touchSession(session: TaskCreationSession): void {
    session.lastActivityAt = Date.now();
  }

  /**
   * Wait for the pendingPermissionResolver to become available on a session.
   * This handles the race where the user answers before canUseTool fires.
   */
  private async waitForPermissionResolver(
    session: TaskCreationSession,
    maxWaitMs = 5000,
    pollIntervalMs = 50
  ): Promise<void> {
    log.info(
      '[TaskCreationService] Waiting for permission resolver (canUseTool not yet called)...'
    );
    const deadline = Date.now() + maxWaitMs;
    while (!session.pendingPermissionResolver && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (session.pendingPermissionResolver) {
      log.info('Permission resolver now available');
    } else {
      log.error(
        '[TaskCreationService] Permission resolver not available after waiting, falling back'
      );
    }
  }

  /**
   * Add a token to the buffer and publish if threshold reached
   */
  private async bufferToken(
    sessionId: string,
    delta: string,
    getAccumulated: () => string,
    forceFlush = false
  ): Promise<void> {
    let buffer = this.tokenBuffers.get(sessionId);
    if (!buffer) {
      buffer = { chunks: [], lastFlush: Date.now() };
      this.tokenBuffers.set(sessionId, buffer);
    }

    if (delta) {
      buffer.chunks.push(delta);
    }

    const shouldFlush =
      forceFlush ||
      buffer.chunks.length >= TaskCreationService.TOKEN_BATCH_SIZE ||
      (buffer.chunks.length > 0 &&
        Date.now() - buffer.lastFlush >= TaskCreationService.TOKEN_FLUSH_INTERVAL);

    if (shouldFlush && buffer.chunks.length > 0) {
      const batchedDelta = buffer.chunks.join('');
      buffer.chunks = [];
      buffer.lastFlush = Date.now();

      try {
        await this.streams.publishTaskCreationToken(sessionId, {
          sessionId,
          delta: batchedDelta,
          accumulated: getAccumulated(),
        });
      } catch (error: unknown) {
        log.error('Failed to publish token batch:', { error });
      }
    }
  }

  /**
   * Flush any remaining tokens in the buffer
   */
  private async flushTokenBuffer(sessionId: string, getAccumulated: () => string): Promise<void> {
    await this.bufferToken(sessionId, '', getAccumulated, true);
    this.tokenBuffers.delete(sessionId);
  }

  /**
   * Clean up token buffer without publishing (for error cases)
   */
  private clearTokenBuffer(sessionId: string): void {
    this.tokenBuffers.delete(sessionId);
  }

  /** Maximum total questions to ask across all rounds (SDK AskUserQuestion tool limits to 4 per call) */
  private static readonly MAX_QUESTIONS = 4;

  /** Maximum allowed message content length (50KB) */
  private static readonly MAX_MESSAGE_LENGTH = 50 * 1024;

  /** Maximum allowed task title length */
  private static readonly MAX_TITLE_LENGTH = 200;

  /** Maximum allowed task description length */
  private static readonly MAX_DESCRIPTION_LENGTH = 10000;

  /** Valid task labels */
  private static readonly VALID_LABELS = [
    'bug',
    'feature',
    'enhancement',
    'docs',
    'refactor',
    'test',
    'research',
  ];

  /**
   * Extract JSON content from a ```json fenced code block in text.
   *
   * The naive regex /```json\s*([\s\S]*?)\s*```/ fails when the JSON itself
   * contains triple-backtick markdown (e.g. directory trees in descriptions).
   * Instead, we find the opening ```json fence, then try each subsequent ```
   * as a potential closing fence, attempting JSON.parse on the content between.
   * The first substring that parses as valid JSON wins.
   */
  private static extractJsonBlock(text: string): unknown | null {
    const openMarker = '```json';
    const closeMarker = '```';

    let searchFrom = 0;
    while (true) {
      const openIdx = text.indexOf(openMarker, searchFrom);
      if (openIdx === -1) return null;

      // Content starts after the ```json marker and any trailing whitespace on that line
      const contentStart = openIdx + openMarker.length;

      // Try each subsequent ``` as a potential closing fence
      let closeSearch = contentStart;
      while (true) {
        const closeIdx = text.indexOf(closeMarker, closeSearch);
        if (closeIdx === -1) break; // No more closing fences for this opening

        const candidate = text.substring(contentStart, closeIdx).trim();
        if (candidate.length > 0) {
          try {
            return JSON.parse(candidate);
          } catch {
            // Not valid JSON yet — try the next ``` further along
          }
        }
        closeSearch = closeIdx + closeMarker.length;
      }

      // None of the closing fences produced valid JSON for this opening.
      // Try the next ```json opening in the text.
      searchFrom = contentStart;
    }
  }

  /**
   * Parse a task suggestion from assistant response text
   */
  private parseSuggestion(text: string): TaskSuggestion | null {
    const parsed = TaskCreationService.extractJsonBlock(text);
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'task_suggestion') return null;

    // Validate and extract suggestion
    if (!obj.title || !obj.description) return null;

    return {
      title: obj.title as string,
      description: obj.description as string,
      // Validate labels: filter to known valid labels only
      labels: Array.isArray(obj.labels)
        ? obj.labels.filter(
            (label: unknown): label is string =>
              typeof label === 'string' && TaskCreationService.VALID_LABELS.includes(label)
          )
        : [],
      priority: ['high', 'medium', 'low'].includes(obj.priority as string)
        ? (obj.priority as 'high' | 'medium' | 'low')
        : 'medium',
    };
  }

  /**
   * Parse clarifying questions from assistant response text (legacy JSON block format)
   */
  private parseClarifyingQuestions(
    text: string,
    session: TaskCreationSession
  ): PendingQuestions | null {
    log.info(`Attempting to parse clarifying questions from text length: ${text.length}`);
    const parsed = TaskCreationService.extractJsonBlock(text);
    if (!parsed || typeof parsed !== 'object') {
      log.info('No valid JSON block found in response');
      return null;
    }
    log.info('Found and parsed JSON block');

    try {
      const obj = parsed as Record<string, unknown>;
      log.info('Parsed JSON block:', {
        data: {
          type: obj.type,
          hasQuestions: !!obj.questions,
          questionsCount: Array.isArray(obj.questions) ? obj.questions.length : undefined,
          keys: Object.keys(obj),
        },
      });

      if (obj.type !== 'clarifying_questions') {
        log.info(
          '[TaskCreationService] Not clarifying_questions type, skipping (found: ' +
            String(obj.type) +
            ')'
        );
        return null;
      }

      // Validate questions array
      if (!Array.isArray(obj.questions) || obj.questions.length === 0) return null;

      // Validate each question
      const questions: ClarifyingQuestion[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: parsed from untyped JSON
      for (const q of obj.questions as Array<any>) {
        if (!q.header || !q.question || !Array.isArray(q.options) || q.options.length === 0) {
          continue;
        }
        questions.push({
          header: q.header,
          question: q.question,
          options: q.options.map((opt: { label?: string; description?: string }) => ({
            label: opt.label || '',
            description: opt.description,
          })),
          multiSelect: q.multiSelect ?? false,
        });
      }

      if (questions.length === 0) return null;

      return {
        id: createId(),
        questions,
        round: session.questionRound + 1,
        totalAsked: session.totalQuestionsAsked + questions.length,
        maxQuestions: TaskCreationService.MAX_QUESTIONS,
      };
    } catch (error: unknown) {
      log.error('Failed to parse clarifying questions JSON:', { error });
      return null;
    }
  }

  /**
   * Parse AskUserQuestion tool input into PendingQuestions
   * This handles the SDK tool call format used by Claude Code
   */
  private parseAskUserQuestionToolInput(
    input: {
      toolUseId: string;
      questions: Array<{
        question: string;
        header: string;
        multiSelect: boolean;
        options: Array<{ label: string; description?: string }>;
      }>;
    },
    session: TaskCreationSession
  ): PendingQuestions | null {
    const { questions: rawQuestions } = input;
    if (!rawQuestions || rawQuestions.length === 0) {
      log.info('AskUserQuestion input has no questions');
      return null;
    }

    // Check if we've already asked the max number of questions
    const remainingQuestions = TaskCreationService.MAX_QUESTIONS - session.totalQuestionsAsked;
    if (remainingQuestions <= 0) {
      log.info(
        `Max questions reached (${TaskCreationService.MAX_QUESTIONS}), skipping additional questions`
      );
      return null;
    }

    // Limit questions to remaining capacity
    const questionsToProcess = rawQuestions.slice(0, remainingQuestions);
    log.info(
      `Parsing AskUserQuestion tool input: ${questionsToProcess.length} of ${rawQuestions.length} questions (limit: ${remainingQuestions} remaining)`
    );

    const questions: ClarifyingQuestion[] = questionsToProcess.map((q) => ({
      header: q.header,
      question: q.question,
      options: q.options.map((opt) => ({
        label: opt.label,
        description: opt.description,
      })),
      multiSelect: q.multiSelect ?? false,
    }));

    // Store the tool_use_id for responding with tool result
    session.pendingToolUseId = input.toolUseId;
    log.info('Stored pending tool_use_id');

    return {
      id: createId(),
      questions,
      round: session.questionRound + 1,
      totalAsked: session.totalQuestionsAsked + questions.length,
      maxQuestions: TaskCreationService.MAX_QUESTIONS,
    };
  }

  /**
   * Start a new task creation conversation
   * @param codespaceId - The codespace to create a task for
   * @param configuredTools - Optional tools configured in settings (from frontend localStorage)
   */
  async startConversation(
    codespaceId: string,
    configuredTools?: string[]
  ): Promise<Result<TaskCreationSession, TaskCreationError>> {
    // Verify codespace exists
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });

    if (!codespace) {
      return err(TaskCreationErrors.PROJECT_NOT_FOUND);
    }

    // Create V2 session with task system enabled
    // Use configured tools from settings, ensuring AskUserQuestion is included
    // Get model from SettingsService if available, otherwise use default
    const taskCreationModel = this.settingsService
      ? await this.settingsService.getTaskCreationModel()
      : getFullModelId(DEFAULT_TASK_CREATION_MODEL);
    const baseTools = configuredTools ?? DEFAULT_TASK_CREATION_TOOLS;
    // Ensure AskUserQuestion is always included
    const allowedTools = baseTools.includes('AskUserQuestion')
      ? baseTools
      : [...baseTools, 'AskUserQuestion'];

    // Create our session ID first so canUseTool callback can reference it
    const sessionId = createId();

    log.info('Creating V2 session:', {
      data: {
        sessionId,
        model: taskCreationModel,
        allowedTools,
        hasAskUserQuestion: allowedTools.includes('AskUserQuestion'),
      },
    });

    // Create canUseTool callback to handle AskUserQuestion
    // This callback pauses execution when AskUserQuestion is called,
    // allowing us to wait for user answers via our API
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      log.info('canUseTool called:', { data: { toolName, sessionId } });

      // For non-AskUserQuestion tools, allow automatically
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'allow' as const, toolUseID: options.toolUseID };
      }

      // Handle AskUserQuestion - pause and wait for user answers
      log.info(
        '[TaskCreationService] 🛑 AskUserQuestion permission requested, pausing for user input'
      );

      const session = this.sessions.get(sessionId);
      if (!session) {
        log.error('Session not found in canUseTool callback');
        return {
          behavior: 'deny' as const,
          message: 'Session not found',
          toolUseID: options.toolUseID,
        };
      }

      // Store the questions input and tool use ID
      session.pendingToolUseId = options.toolUseID;
      session.pendingQuestionsInput = input;

      // Parse and store questions for the UI
      // The SDK input has 'questions' array, we add the toolUseId from options
      const inputWithToolId = {
        toolUseId: options.toolUseID,
        questions: (input as { questions: unknown }).questions as Array<{
          question: string;
          header: string;
          multiSelect: boolean;
          options: Array<{ label: string; description?: string }>;
        }>,
      };
      const questions = this.parseAskUserQuestionToolInput(inputWithToolId, session);
      if (!questions) {
        log.error(
          '[TaskCreationService] No valid AskUserQuestion payload, allowing tool to proceed'
        );
        session.pendingQuestions = null;
        session.pendingToolUseId = null;
        session.pendingQuestionsInput = null;
        session.pendingPermissionResolver = null;
        if (session.questionsReadyResolver) {
          session.questionsReadyResolver();
        }
        session.questionsReadyPromise = null;
        session.questionsReadyResolver = null;
        session.status = 'active';
        return { behavior: 'allow' as const, toolUseID: options.toolUseID };
      }

      log.info('Parsed questions for UI:', {
        data: {
          questionsId: questions.id,
          questionCount: questions.questions.length,
        },
      });
      session.pendingQuestions = questions;
      session.questionRound = questions.round;
      session.totalQuestionsAsked = questions.totalAsked;
      session.status = 'waiting_user';

      // Signal that questions are ready (for Promise-based waiting)
      if (session.questionsReadyResolver) {
        session.questionsReadyResolver();
        session.questionsReadyPromise = null;
        session.questionsReadyResolver = null;
      }

      // Publish questions event for UI
      try {
        await this.streams.publishTaskCreationQuestions(session.id, {
          sessionId: session.id,
          questions,
        });
      } catch (error: unknown) {
        log.error('Failed to publish questions:', { error });
      }

      // Persist to database if available
      if (session.dbSessionId && this.sessionService) {
        try {
          await this.sessionService.publish(session.dbSessionId, {
            id: createId(),
            type: 'tool:start',
            timestamp: Date.now(),
            data: {
              id: options.toolUseID,
              tool: 'AskUserQuestion',
              input: { questions: questions.questions },
            },
          });
        } catch (error: unknown) {
          log.error('Failed to persist tool:start:', { error });
        }
      }

      // Create a Promise that will be resolved when user provides answers
      return new Promise<PermissionResult>((resolve) => {
        log.info('🔒 Storing permission resolver, waiting for answers...');
        session.pendingPermissionResolver = resolve;
      });
    };

    // Create database session for history tracking FIRST (before v2Session)
    let dbSessionId: string | null = null;
    if (this.sessionService) {
      try {
        const dbSessionResult = await this.sessionService.create({
          codespaceId,
          title: 'Task Creation',
        });
        if (dbSessionResult.ok) {
          dbSessionId = dbSessionResult.value.id;
          log.info('Created database session');
        } else {
          log.error('[TaskCreationService] Failed to create database session', {
            error: dbSessionResult.error,
          });
        }
      } catch (error: unknown) {
        log.error('Error creating database session:', { error });
      }
    }

    // IMPORTANT: Create and store session BEFORE creating v2Session
    // This ensures canUseTool callback can find the session when it's invoked
    const session: TaskCreationSession = {
      id: sessionId,
      codespaceId,
      status: 'active',
      messages: [],
      suggestion: null,
      pendingQuestions: null,
      questionRound: 0,
      totalQuestionsAsked: 0,
      createdTaskId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      sdkSessionId: null,
      pendingToolUseId: null,
      v2Session: null, // Will be set after v2Session is created
      systemPromptSent: false,
      dbSessionId,
      pendingPermissionResolver: null,
      pendingQuestionsInput: null,
      activeStreamIterator: null,
      streamProcessingPromise: null,
      onSuggestionCallback: null,
      onMessageCallback: null,
      questionsReadyPromise: null,
      questionsReadyResolver: null,
      lastActivityAt: Date.now(),
      lastProcessedQuestionsId: null,
    };

    // Store session BEFORE creating v2Session so canUseTool callback can access it
    this.sessions.set(sessionId, session);

    // Now create v2Session - canUseTool callback can now find the session
    const v2Session = unstable_v2_createSession({
      model: taskCreationModel,
      env: buildSdkEnv({ CLAUDE_CODE_ENABLE_TASKS: 'true', DEBUG_CLAUDE_AGENT_SDK: '1' }),
      allowedTools,
      canUseTool,
    });

    // Update session with v2Session reference
    session.v2Session = v2Session as V2Session;

    // Insert a sessions row so session_events FK constraint is satisfied
    try {
      await this.db.insert(sessions).values({
        id: sessionId,
        codespaceId,
        taskId: null,
        agentId: null,
        title: 'Task Creation',
        url: `/codespaces/${codespaceId}/task-creation/${sessionId}`,
        status: 'active',
        createdAt: new Date().toISOString(),
      });
    } catch (insertErr) {
      const errorMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
      if (!errorMsg.includes('UNIQUE constraint')) {
        log.warn('Failed to create session record');
      }
    }

    // Create stream and publish start event in parallel
    await Promise.all([
      this.streams
        .createStream(sessionId, { type: 'task-creation', codespaceId })
        .catch((error) => log.error('Failed to create stream:', { error })),
      this.streams
        .publishTaskCreationStarted(sessionId, { sessionId, codespaceId })
        .catch((error) => log.error('Failed to publish start event:', { error })),
    ]);

    return ok(session);
  }

  /**
   * Send a message in the conversation using V2 API
   */
  async sendMessage(
    sessionId: string,
    content: string,
    onToken?: TokenCallback,
    onSuggestion?: SuggestionCallback,
    onMessage?: MessageCallback
  ): Promise<Result<TaskCreationSession, TaskCreationError>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(TaskCreationErrors.SESSION_NOT_FOUND);
    }

    // Update activity timestamp
    this.touchSession(session);

    if (session.status === 'completed' || session.status === 'cancelled') {
      return err(TaskCreationErrors.SESSION_COMPLETED(sessionId));
    }

    // Validate message length to prevent resource exhaustion
    if (content.length > TaskCreationService.MAX_MESSAGE_LENGTH) {
      return err(TaskCreationErrors.MESSAGE_TOO_LONG);
    }

    if (!session.v2Session) {
      return err(TaskCreationErrors.API_ERROR('No active V2 session'));
    }

    // Store callbacks for background processor to use
    if (onSuggestion) {
      session.onSuggestionCallback = onSuggestion;
    }
    if (onMessage) {
      session.onMessageCallback = onMessage;
    }

    // Add user message
    const userMessage: TaskCreationMessage = {
      id: createId(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMessage);

    // Publish user message event
    try {
      await this.streams.publishTaskCreationMessage(sessionId, {
        sessionId,
        messageId: userMessage.id,
        role: 'user',
        content,
      });
    } catch (error: unknown) {
      log.error('Failed to publish user message:', { error });
    }

    // Persist user message to database for session history
    if (session.dbSessionId && this.sessionService) {
      try {
        await this.sessionService.publish(session.dbSessionId, {
          id: userMessage.id,
          type: 'chunk',
          timestamp: Date.now(),
          data: { role: 'user', content },
        });
      } catch (error: unknown) {
        log.error('Failed to persist user message:', { error });
      }
    }

    try {
      // Build message with system prompt for first message
      let messageToSend = content;
      if (!session.systemPromptSent) {
        const systemPrompt = this.settingsService
          ? await resolvePromptServer('task-creation', this.settingsService)
          : SYSTEM_PROMPT_DEFAULT;
        messageToSend = `${systemPrompt}\n\n---\n\nUser message: ${content}`;
        session.systemPromptSent = true;
      }

      // Send message using V2 API
      await session.v2Session.send(messageToSend);

      const accumulatedChunks: string[] = [];
      const getAccumulated = () => accumulatedChunks.join('');
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = '';

      // Track in-flight tool calls for emitting tool:start/tool:result events
      const inFlightTools = new Map<
        number,
        { id: string; name: string; input: string; startTime: number }
      >();

      // Stream response using V2 API
      // Note: AskUserQuestion is handled by canUseTool callback, which pauses the stream
      // When answerQuestions() resolves the permission, the stream continues automatically
      //
      // IMPORTANT: We use a manual while loop instead of for-await to avoid iterator cleanup issues.
      // When we need to exit early (e.g., questions detected), using for-await's break/return
      // calls iterator.return() which closes the iterator and prevents the background processor
      // from continuing to consume it. With a manual loop, we can exit without cleanup.
      const streamIterator = session.v2Session.stream();
      session.activeStreamIterator = streamIterator;

      // Flag to signal early return (when questions detected)
      let shouldReturnEarly = false;

      // Manual iteration loop - allows us to exit without calling iterator.return()
      // Use a labeled loop so inner break can exit both loops
      outerLoop: while (true) {
        // Check if we should exit BEFORE calling next() - important to avoid blocking
        if (shouldReturnEarly) {
          log.info('🚪 Exiting loop - shouldReturnEarly is true');
          break;
        }

        const iterResult = await streamIterator.next();
        if (iterResult.done) {
          break;
        }
        const msg = iterResult.value;

        // DON'T break when pendingPermissionResolver is set!
        // The SDK's canUseTool callback pauses the stream internally via the Promise.
        // Breaking here loses the iterator state. Instead, we return control but let
        // a background processor continue consuming the iterator after permission resolves.

        // Log ALL message types to debug event format
        log.info(`📨 Stream msg type: ${msg.type}`, {
          data: {
            hasSessionId: !!msg.session_id,
            msgKeys: Object.keys(msg).filter((k) => k !== 'session_id'),
          },
        });

        // Capture session ID for resume capability
        if (msg.session_id && !session.sdkSessionId) {
          session.sdkSessionId = msg.session_id;
        }

        // Check for user messages with tool_use_result (SDK V2 format)
        if (msg.type === 'user') {
          const userMsg = msg as {
            type: 'user';
            message?: {
              content?: Array<{
                type: string;
                tool_use_id?: string;
                content?: unknown;
              }>;
            };
            tool_use_result?: {
              tool_use_id?: string;
              tool_name?: string;
              input?: unknown;
              output?: unknown;
            };
          };

          // Log tool_use_result (handled by canUseTool for AskUserQuestion)
          if (userMsg.tool_use_result) {
            const toolResult = userMsg.tool_use_result;
            log.info('🛠️ SDK V2 tool_use_result found:', {
              data: {
                toolName: toolResult.tool_name,
                hasInput: !!toolResult.input,
              },
            });
            // Note: AskUserQuestion is handled by canUseTool callback, no need to capture here
          }
        }

        // Check for assistant messages with tool_use content
        if (msg.type === 'assistant') {
          const assistantMsg = msg as {
            type: 'assistant';
            message?: {
              content?: Array<{
                type: string;
                id?: string;
                name?: string;
                input?: unknown;
                text?: string;
              }>;
            };
          };

          // Accumulate text content from assistant messages
          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                accumulatedChunks.push(block.text);
                // Stream token to UI
                if (onToken) {
                  onToken(block.text, getAccumulated());
                }
              }

              // Detect AskUserQuestion tool_use - spawn background processor and return control
              // canUseTool callback handles questions parsing, publishing, and pausing
              // The SDK will wait for the permission Promise to resolve before continuing
              //
              // CRITICAL: We must NOT break from the loop here!
              // Breaking loses the iterator state. Instead, we spawn a background task
              // that continues consuming the SAME iterator after permission resolves.
              if (
                block.type === 'tool_use' &&
                block.name === 'AskUserQuestion' &&
                block.input &&
                block.id
              ) {
                log.info(
                  '[TaskCreationService] 📝 AskUserQuestion tool_use detected - spawning background processor'
                );

                // Create promise for questions readiness signaling
                session.questionsReadyPromise = new Promise<void>((resolve) => {
                  session.questionsReadyResolver = resolve;
                });

                // Store accumulated text before returning
                const accumulatedText = getAccumulated();
                if (accumulatedText) {
                  await this.addAssistantMessage(session, accumulatedText, undefined);
                  accumulatedChunks.length = 0; // Reset accumulator for background processing
                }

                // Set status to waiting_user in case canUseTool hasn't run yet
                // canUseTool will also set this, so it's safe to set it here too
                session.status = 'waiting_user';

                // Spawn a background task to continue processing the stream
                // This task will resume when the canUseTool Promise resolves (after user answers)
                // We pass the same streamIterator, accumulated state, and other context
                log.info('🔄 Spawning background stream processor...');
                session.streamProcessingPromise = this.processStreamInBackground(
                  session,
                  streamIterator,
                  inFlightTools,
                  onToken
                );

                // Wait for questions to be ready using Promise signaling instead of polling
                if (session.questionsReadyPromise) {
                  try {
                    await Promise.race([
                      session.questionsReadyPromise,
                      new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error('Questions timeout')), 5000)
                      ),
                    ]);
                    log.info('✅ Questions ready via Promise signaling');
                  } catch {
                    log.info('⚠️ Questions not ready after timeout');
                  }
                }

                // Set flag and break to exit both loops without calling iterator.return()
                // This is critical because the background processor is consuming the same iterator
                // Using 'return' inside for-await would trigger cleanup that blocks/conflicts
                shouldReturnEarly = true;
                break outerLoop;
              }
            }
          }
        }

        // Handle partial streaming messages
        if (msg.type === 'stream_event') {
          const event = msg.event as {
            type: string;
            index?: number;
            content_block?: { type: string; id?: string; name?: string };
            delta?: { type: string; text?: string; partial_json?: string };
            message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          // Capture message_start for model info (legacy SDK V1 path)
          if (event.type === 'message_start' && event.message) {
            if (event.message.model) {
              modelUsed = event.message.model;
            }
            if (event.message.usage) {
              inputTokens = event.message.usage.input_tokens ?? 0;
            }
          }

          // Capture message_delta for output token usage
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }

          // Handle tool_use content_block_start - emit tool:start event
          if (
            event.type === 'content_block_start' &&
            event.content_block?.type === 'tool_use' &&
            event.index !== undefined
          ) {
            const toolId = event.content_block.id ?? createId();
            const toolName = event.content_block.name ?? 'unknown';

            log.info(
              `[TaskCreationService] 🔧 TOOL DETECTED: ${toolName} (id: ${toolId}, index: ${event.index})`
            );
            if (toolName === 'AskUserQuestion') {
              log.info('✅ AskUserQuestion tool is being called!');
            }

            inFlightTools.set(event.index, {
              id: toolId,
              name: toolName,
              input: '',
              startTime: Date.now(),
            });

            // Publish tool:start event to session
            if (session.dbSessionId && this.sessionService) {
              try {
                const publishResult = await this.sessionService.publish(session.dbSessionId, {
                  id: createId(),
                  type: 'tool:start',
                  timestamp: Date.now(),
                  data: {
                    id: toolId,
                    tool: toolName,
                    input: {},
                  },
                });
                if (publishResult.ok) {
                  log.info(
                    `[TaskCreationService] Published tool:start for ${toolName}, offset: ${publishResult.value.offset}`
                  );
                } else {
                  log.error(
                    `[TaskCreationService] Failed to publish tool:start: ${publishResult.error.message}`
                  );
                }
              } catch (error: unknown) {
                log.error('Failed to publish tool:start:', { error });
              }
            } else {
              log.error(
                `[TaskCreationService] Cannot publish tool:start - dbSessionId: ${session.dbSessionId}, hasSessionService: ${!!this.sessionService}`
              );
            }
          }

          // Handle input_json_delta - accumulate tool input
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta' &&
            event.delta.partial_json &&
            event.index !== undefined
          ) {
            const toolInfo = inFlightTools.get(event.index);
            if (toolInfo) {
              toolInfo.input += event.delta.partial_json;
            }
          }

          // Handle content_block_stop - emit tool:result event for completed tools
          if (event.type === 'content_block_stop' && event.index !== undefined) {
            const toolInfo = inFlightTools.get(event.index);
            if (toolInfo) {
              const duration = Date.now() - toolInfo.startTime;

              // Parse the accumulated input JSON
              let parsedInput: Record<string, unknown> = {};
              try {
                if (toolInfo.input) {
                  parsedInput = JSON.parse(toolInfo.input);
                }
              } catch (parseError) {
                log.warn('Failed to parse tool input JSON', {
                  data: {
                    toolId: toolInfo.id,
                    toolName: toolInfo.name,
                    inputLength: toolInfo.input.length,
                  },
                  error: parseError,
                });
              }

              // Log AskUserQuestion tool call (handled by canUseTool callback)
              if (toolInfo.name === 'AskUserQuestion' && parsedInput.questions) {
                log.info('[TaskCreationService] AskUserQuestion tool call completed', {
                  data: { questionCount: (parsedInput.questions as unknown[]).length },
                });
              }

              // Publish tool:result event with the accumulated input and duration
              if (session.dbSessionId && this.sessionService) {
                try {
                  // Publish tool:result event
                  await this.sessionService.publish(session.dbSessionId, {
                    id: createId(),
                    type: 'tool:result',
                    timestamp: Date.now(),
                    data: {
                      id: toolInfo.id,
                      tool: toolInfo.name,
                      input: parsedInput,
                      output: null, // Output comes from the actual tool execution, not available here
                      duration,
                      isError: false,
                    },
                  });
                } catch (error: unknown) {
                  log.error('Failed to publish tool:result:', { error });
                }
              }

              inFlightTools.delete(event.index);
            }
          }

          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            const delta = event.delta.text;
            accumulatedChunks.push(delta);

            if (onToken) {
              onToken(delta, getAccumulated());
            }

            // Publish token event (batched)
            await this.bufferToken(sessionId, delta, getAccumulated);
          }
        }

        // Handle complete assistant messages
        if (msg.type === 'assistant') {
          const text = this.getAssistantText(msg);
          if (text) {
            // Reset accumulated chunks and set to the complete text
            accumulatedChunks.length = 0;
            accumulatedChunks.push(text);
          }

          // Extract model and usage from assistant message
          const message = msg.message as {
            model?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
            content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
          };
          if (message?.model) {
            modelUsed = message.model;
          }
          if (message?.usage) {
            inputTokens = message.usage.input_tokens ?? 0;
            outputTokens = message.usage.output_tokens ?? 0;
          }

          // Extract tool_use blocks from assistant message content
          if (message?.content && session.dbSessionId && this.sessionService) {
            for (const block of message.content) {
              if (block.type === 'tool_use' && block.id && block.name) {
                // Emit tool:start and tool:result for tool_use blocks not seen via streaming
                const toolId = block.id;
                const existingTool = Array.from(inFlightTools.values()).find(
                  (t) => t.id === toolId
                );

                if (!existingTool) {
                  try {
                    const timestamp = Date.now();
                    // Emit tool:start
                    await this.sessionService.publish(session.dbSessionId, {
                      id: createId(),
                      type: 'tool:start',
                      timestamp,
                      data: {
                        id: toolId,
                        tool: block.name,
                        input: (block.input as Record<string, unknown>) ?? {},
                      },
                    });
                    // Emit tool:result immediately (we don't have the actual result)
                    await this.sessionService.publish(session.dbSessionId, {
                      id: createId(),
                      type: 'tool:result',
                      timestamp: timestamp + 1,
                      data: {
                        id: toolId,
                        tool: block.name,
                        input: (block.input as Record<string, unknown>) ?? {},
                        output: null,
                        duration: 0,
                        isError: false,
                      },
                    });
                  } catch (error: unknown) {
                    log.error(
                      '[TaskCreationService] Failed to publish tool events from assistant',
                      { error }
                    );
                  }
                }
              }
            }
          }
        }

        // Handle result messages which may contain usage info
        if (msg.type === 'result') {
          const result = msg as {
            usage?: { input_tokens?: number; output_tokens?: number };
            num_turns?: number;
          };
          if (result.usage) {
            inputTokens = result.usage.input_tokens ?? inputTokens;
            outputTokens = result.usage.output_tokens ?? outputTokens;
          }
        }

        // Handle tool_progress messages - these indicate tool execution in progress
        if (msg.type === 'tool_progress') {
          const progress = msg as {
            tool_use_id: string;
            tool_name: string;
            elapsed_time_seconds: number;
          };

          log.info(
            `[TaskCreationService] Tool progress - ${progress.tool_name} (${progress.tool_use_id}): ${progress.elapsed_time_seconds}s`
          );

          // If we haven't seen this tool yet, emit a tool:start event
          // This handles cases where the tool_use block wasn't captured via stream_event
          const existingTool = Array.from(inFlightTools.values()).find(
            (t) => t.id === progress.tool_use_id
          );
          if (!existingTool && session.dbSessionId && this.sessionService) {
            try {
              await this.sessionService.publish(session.dbSessionId, {
                id: createId(),
                type: 'tool:start',
                timestamp: Date.now(),
                data: {
                  id: progress.tool_use_id,
                  tool: progress.tool_name,
                  input: {},
                },
              });
            } catch (error: unknown) {
              log.error('Failed to publish tool:start from progress', { error });
            }
          }
        }
      }

      // Log token usage for debugging
      const totalTokens = inputTokens + outputTokens;
      if (totalTokens > 0) {
        log.info(
          `[TaskCreationService] Token usage - Input: ${inputTokens}, Output: ${outputTokens}, Model: ${modelUsed}`
        );
      }

      // Flush any remaining tokens before processing
      await this.flushTokenBuffer(sessionId, getAccumulated);

      // Get final accumulated text
      const accumulated = getAccumulated();

      // Log what we have after streaming
      log.info('📊 Stream completed:', {
        data: {
          accumulatedTextLength: accumulated.length,
          hasPendingQuestions: !!session.pendingQuestions,
          hasPendingPermissionResolver: !!session.pendingPermissionResolver,
          inFlightToolsCount: inFlightTools.size,
        },
      });

      // Helper to apply pending questions to session state
      const applyPendingQuestions = async (questions: PendingQuestions): Promise<void> => {
        log.info('Applying pending questions:', {
          data: {
            sessionId,
            questionsId: questions.id,
            questionCount: questions.questions.length,
            round: questions.round,
          },
        });
        session.pendingQuestions = questions;
        session.questionRound = questions.round;
        session.totalQuestionsAsked = questions.totalAsked;
        session.status = 'waiting_user';

        try {
          await this.streams.publishTaskCreationQuestions(sessionId, {
            sessionId,
            questions,
          });
        } catch (error: unknown) {
          log.error('Failed to publish questions:', { error });
        }
      };

      // Build usage info for message persistence
      const usageInfo = totalTokens > 0 ? { modelUsed, inputTokens, outputTokens } : undefined;

      // Note: AskUserQuestion is now handled by canUseTool callback, which:
      // - Parses questions and stores them in session.pendingQuestions
      // - Publishes questions to UI via streams
      // - Pauses stream execution via pending Promise
      // - When answerQuestions() is called, the Promise resolves and stream continues
      //
      // If we reach here, either:
      // - Claude didn't call AskUserQuestion (going straight to task suggestion)
      // - Or the stream completed after answers were provided
      //
      // Either way, we should process the accumulated response for task suggestions

      // Add assistant response if we have content
      if (accumulated) {
        await this.addAssistantMessage(session, accumulated, usageInfo);

        // Parse clarifying questions from response (legacy JSON block format - fallback)
        log.info(
          '[TaskCreationService] Fallback: Trying to parse JSON block from text response...'
        );
        const questions = this.parseClarifyingQuestions(accumulated, session);
        if (questions) {
          log.info(
            `Parsed clarifying questions from JSON block: ${questions.questions.length} questions`
          );
          await applyPendingQuestions(questions);
        } else {
          // Parse suggestion from response (only if no questions)
          log.info('[TaskCreationService] No questions found, trying to parse task suggestion...');
          const suggestion = this.parseSuggestion(accumulated);
          if (suggestion) {
            log.info('Found task suggestion:', {
              data: {
                title: suggestion.title.substring(0, 50),
                priority: suggestion.priority,
                labelsCount: suggestion.labels.length,
              },
            });
            session.suggestion = suggestion;
            // Only clear pendingQuestions if we're NOT waiting for user input
            // This prevents clearing questions while user is still answering them
            if (session.status !== 'waiting_user') {
              session.pendingQuestions = null;
            }

            try {
              await this.streams.publishTaskCreationSuggestion(sessionId, {
                sessionId,
                suggestion,
              });
            } catch (error: unknown) {
              log.error('Failed to publish suggestion:', { error });
            }
          }
        }
      }

      // Check if we exited early due to questions detection
      // In this case, return immediately so the HTTP handler can respond with questions
      if (shouldReturnEarly) {
        log.info('[TaskCreationService] 📤 Returning early to allow HTTP response with questions');
        return ok(session);
      }

      return ok(session);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Error in sendMessage:', {
        data: {
          error: message,
          sessionId,
          sessionStatus: session?.status,
        },
      });

      // Clean up token buffer without publishing
      this.clearTokenBuffer(sessionId);

      // Update session status on error
      if (session) {
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();

        // Fire-and-forget iterator cleanup
        if (session.activeStreamIterator) {
          session.activeStreamIterator.return?.(undefined).catch((iteratorError) => {
            log.error('Failed to clean up stream iterator', { error: iteratorError });
          });
          session.activeStreamIterator = null;
        }

        // Close V2Session on error to prevent resource leaks
        if (session.v2Session) {
          try {
            session.v2Session.close();
          } catch (closeError) {
            log.error('Failed to close V2 session on error:', { error: closeError });
          }
          session.v2Session = null;
        }
      }

      // Fire-and-forget error publishing to avoid delaying error response
      this.streams
        .publishTaskCreationError(sessionId, {
          sessionId,
          error: message,
        })
        .catch((streamError) => {
          log.error('Failed to publish error:', { error: streamError });
        });

      return err(TaskCreationErrors.API_ERROR(message));
    }
  }

  /**
   * Process the SDK stream in the background after AskUserQuestion is detected.
   * This method continues consuming the SAME stream iterator that was created in sendMessage,
   * which is critical because the SDK's internal state (pending permission resolution) is
   * tied to that specific iterator instance.
   *
   * The stream will naturally pause at the canUseTool Promise until the user provides answers.
   * Once answerQuestions() resolves the Promise, the SDK continues generating messages,
   * and this background processor will capture them.
   */
  private async processStreamInBackground(
    session: TaskCreationSession,
    streamIterator: AsyncGenerator<SDKMessage>,
    _inFlightTools: Map<number, { id: string; name: string; input: string; startTime: number }>,
    onToken?: TokenCallback
  ): Promise<void> {
    // Note: _inFlightTools is passed for potential future use in tracking tool state,
    // but not currently used in background processing since we focus on post-permission messages
    log.info('🔄 Background stream processor started');

    const accumulatedChunks: string[] = [];
    const getAccumulated = () => accumulatedChunks.join('');
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = '';

    try {
      // Continue processing from the same iterator
      // The SDK will pause here until canUseTool Promise resolves
      for await (const msg of streamIterator) {
        // Check if session was cancelled
        if (session.status === 'cancelled' || session.status === 'completed') {
          log.info('[BG] Session ended, stopping background processor');
          break;
        }

        log.info(`[BG] 📨 Stream msg type: ${msg.type}`);

        // Handle assistant messages
        if (msg.type === 'assistant') {
          const assistantMsg = msg as {
            type: 'assistant';
            message?: {
              content?: Array<{
                type: string;
                id?: string;
                name?: string;
                input?: unknown;
                text?: string;
              }>;
              model?: string;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
          };

          // Extract model and usage
          if (assistantMsg.message?.model) {
            modelUsed = assistantMsg.message.model;
          }
          if (assistantMsg.message?.usage) {
            inputTokens = assistantMsg.message.usage.input_tokens ?? 0;
            outputTokens = assistantMsg.message.usage.output_tokens ?? 0;
          }

          // Accumulate text content
          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                accumulatedChunks.push(block.text);
                if (onToken) {
                  onToken(block.text, getAccumulated());
                }
              }

              // Check for another AskUserQuestion (multi-round questioning)
              if (
                block.type === 'tool_use' &&
                block.name === 'AskUserQuestion' &&
                block.input &&
                block.id
              ) {
                log.info(
                  '[TaskCreationService] [BG] 📝 Another AskUserQuestion detected - waiting for answers'
                );

                const accumulatedText = getAccumulated();
                if (accumulatedText) {
                  await this.addAssistantMessage(session, accumulatedText, undefined);
                  accumulatedChunks.length = 0;
                }

                session.status = 'waiting_user';
                // The canUseTool callback will handle the new questions
                // Continue the loop - it will pause again at the new canUseTool Promise
              }
            }
          }
        }

        // Handle streaming events
        if (msg.type === 'stream_event') {
          const event = msg.event as {
            type: string;
            index?: number;
            content_block?: { type: string; id?: string; name?: string };
            delta?: { type: string; text?: string; partial_json?: string };
            message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          if (event.type === 'message_start' && event.message) {
            if (event.message.model) modelUsed = event.message.model;
            if (event.message.usage) inputTokens = event.message.usage.input_tokens ?? 0;
          }

          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }

          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            const delta = event.delta.text;
            accumulatedChunks.push(delta);

            if (onToken) {
              onToken(delta, getAccumulated());
            }

            // Publish token event (batched)
            await this.bufferToken(session.id, delta, getAccumulated);
          }
        }

        // Handle result message (end of stream)
        if (msg.type === 'result') {
          log.info('[BG] 🎯 Result message received - stream complete');
          const result = msg as {
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (result.usage) {
            inputTokens = result.usage.input_tokens ?? inputTokens;
            outputTokens = result.usage.output_tokens ?? outputTokens;
          }
          break;
        }
      }

      // Flush any remaining tokens
      await this.flushTokenBuffer(session.id, getAccumulated);

      // Get final accumulated text
      const accumulated = getAccumulated();

      // Process accumulated content
      if (accumulated) {
        const usageInfo =
          inputTokens + outputTokens > 0 ? { modelUsed, inputTokens, outputTokens } : undefined;

        await this.addAssistantMessage(session, accumulated, usageInfo);

        // Parse task suggestion from accumulated content
        // Only parse suggestions if we're not waiting for user input (questions)
        // The background processor may receive pre-tool content that looks like a suggestion
        // but we shouldn't act on it until the user has answered questions
        if (session.status !== 'waiting_user') {
          log.info('[BG] Parsing response for task suggestion...');
          const suggestion = this.parseSuggestion(accumulated);
          if (suggestion) {
            log.info('[BG] Found task suggestion:', {
              data: {
                title: suggestion.title.substring(0, 50),
                priority: suggestion.priority,
              },
            });
            session.suggestion = suggestion;
            // Safe to clear pendingQuestions since we're in the outer block
            // that already checks session.status !== 'waiting_user'
            session.pendingQuestions = null;

            // Call the SSE callback if registered (sends event to client)
            if (session.onSuggestionCallback) {
              log.info(
                '[TaskCreationService] [BG] 📤 Calling onSuggestionCallback to send SSE event'
              );
              session.onSuggestionCallback(suggestion);
            }

            try {
              await this.streams.publishTaskCreationSuggestion(session.id, {
                sessionId: session.id,
                suggestion,
              });
            } catch (error: unknown) {
              log.error('[BG] Failed to publish suggestion:', { error });
            }
          }
        } else {
          log.info(
            '[TaskCreationService] [BG] Skipping suggestion parsing - waiting for user input'
          );
        }
      }

      log.info('[BG] 🏁 Background stream processor completed');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Background processing error';
      log.error('[BG] Error in background stream processor:', {
        data: {
          error: errorMessage,
          sessionId: session.id,
          sessionStatus: session.status,
        },
      });

      // Clean up token buffer without publishing
      this.clearTokenBuffer(session.id);

      // Update session status to indicate failure
      if (session.status !== 'completed' && session.status !== 'cancelled') {
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
      }

      // Fire-and-forget error publishing to avoid delaying error response
      this.streams
        .publishTaskCreationError(session.id, {
          sessionId: session.id,
          error: errorMessage,
        })
        .catch((streamError) => {
          log.error('[BG] Failed to publish error:', { error: streamError });
        });
    } finally {
      // Clean up
      session.activeStreamIterator = null;
      session.streamProcessingPromise = null;
    }
  }

  /**
   * Extract text content from an SDK assistant message
   */
  private getAssistantText(msg: SDKMessage): string | null {
    if (msg.type !== 'assistant') return null;
    return msg.message.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { type: string; text?: string }) => block.text ?? '')
      .join('');
  }

  /**
   * Create and persist an assistant message, publishing to streams and database
   */
  private async addAssistantMessage(
    session: TaskCreationSession,
    content: string,
    usage?: { modelUsed: string; inputTokens: number; outputTokens: number }
  ): Promise<TaskCreationMessage> {
    const message: TaskCreationMessage = {
      id: createId(),
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(message);

    // Publish to real-time stream
    try {
      await this.streams.publishTaskCreationMessage(session.id, {
        sessionId: session.id,
        messageId: message.id,
        role: 'assistant',
        content,
      });
    } catch (error: unknown) {
      log.error('Failed to publish assistant message:', { error });
    }

    // Also send via direct SSE callback (for background processor flow where
    // durable streams may not reach the SSE controller)
    if (session.onMessageCallback) {
      try {
        session.onMessageCallback(message.id, 'assistant', content);
      } catch (error: unknown) {
        log.error('Failed to call onMessageCallback:', { error });
      }
    }

    // Persist to database for session history
    if (session.dbSessionId && this.sessionService) {
      try {
        const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
        await this.sessionService.publish(session.dbSessionId, {
          id: message.id,
          type: 'chunk',
          timestamp: Date.now(),
          data: {
            role: 'assistant',
            content,
            model: usage?.modelUsed || undefined,
            usage:
              totalTokens > 0 && usage
                ? {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens,
                  }
                : undefined,
          },
        });
      } catch (error: unknown) {
        log.error('Failed to persist assistant message:', { error });
      }
    }

    return message;
  }

  /**
   * Accept the current suggestion and create a task
   */
  async acceptSuggestion(
    sessionId: string,
    overrides?: Partial<TaskSuggestion>
  ): Promise<Result<{ session: TaskCreationSession; taskId: string }, TaskCreationError>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(TaskCreationErrors.SESSION_NOT_FOUND);
    }

    // Update activity timestamp
    this.touchSession(session);

    // Check if we have a complete suggestion from either session or overrides
    const hasCompleteOverrides = overrides?.title && overrides?.description;
    if (!session.suggestion && !hasCompleteOverrides) {
      log.error('No suggestion available:', {
        data: {
          sessionId,
          hasSessionSuggestion: !!session.suggestion,
          hasCompleteOverrides,
          overrides,
        },
      });
      return err(TaskCreationErrors.NO_SUGGESTION);
    }

    // Use session suggestion as base, with overrides taking precedence
    // If session.suggestion is null but overrides has complete data, use overrides directly
    const baseSuggestion = session.suggestion ?? {
      title: '',
      description: '',
      labels: [],
      priority: 'medium' as const,
    };
    const finalSuggestion = { ...baseSuggestion, ...overrides };

    // Enforce title/description length limits
    if (finalSuggestion.title.length > TaskCreationService.MAX_TITLE_LENGTH) {
      finalSuggestion.title = finalSuggestion.title.substring(
        0,
        TaskCreationService.MAX_TITLE_LENGTH
      );
    }
    if (finalSuggestion.description.length > TaskCreationService.MAX_DESCRIPTION_LENGTH) {
      finalSuggestion.description = finalSuggestion.description.substring(
        0,
        TaskCreationService.MAX_DESCRIPTION_LENGTH
      );
    }

    // Create the task
    try {
      const taskId = createId();
      const newTask: NewTask = {
        id: taskId,
        codespaceId: session.codespaceId,
        title: finalSuggestion.title,
        description: finalSuggestion.description,
        labels: finalSuggestion.labels,
        priority: finalSuggestion.priority,
        column: 'backlog',
        position: 0, // Will be reordered by the task service
      };

      await this.db.insert(tasks).values(newTask);

      // Clean up token buffer
      this.clearTokenBuffer(sessionId);

      // Wait for background processor to complete before closing session
      if (session.streamProcessingPromise) {
        try {
          await session.streamProcessingPromise;
        } catch (error: unknown) {
          log.error('Error waiting for stream processor:', { error });
        }
      }

      // Close V2 session
      if (session.v2Session) {
        try {
          session.v2Session.close();
        } catch (error: unknown) {
          log.error('Failed to close V2 session:', { error });
        }
        session.v2Session = null;
      }

      // Close database session
      if (session.dbSessionId && this.sessionService) {
        try {
          await this.sessionService.close(session.dbSessionId);
          log.info('Closed database session');
        } catch (error: unknown) {
          log.error('Failed to close database session:', { error });
        }
      }

      // Update session
      session.status = 'completed';
      session.createdTaskId = taskId;
      session.completedAt = new Date().toISOString();

      // Publish completion event
      try {
        await this.streams.publishTaskCreationCompleted(sessionId, {
          sessionId,
          taskId,
          suggestion: finalSuggestion,
        });
      } catch (error: unknown) {
        log.error('Failed to publish completion event:', { error });
      }

      // Mark DB session as closed
      this.db
        .update(sessions)
        .set({ status: 'closed', closedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .catch((err) =>
          log.warn('Failed to mark completed session as closed in DB', {
            error: err instanceof Error ? err.message : String(err),
          })
        );

      // Schedule delayed in-memory cleanup to allow late API calls
      setTimeout(() => {
        this.sessions.delete(sessionId);
        log.info('Cleaned up completed session');
      }, 60000);

      return ok({ session, taskId });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(TaskCreationErrors.DATABASE_ERROR('insert', message));
    }
  }

  /**
   * Answer clarifying questions and continue the conversation
   * Supports both single-select (string) and multi-select (string[]) answers
   */
  async answerQuestions(
    sessionId: string,
    questionsId: string,
    answers: Record<string, string | string[]>
  ): Promise<Result<TaskCreationSession, TaskCreationError>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(TaskCreationErrors.SESSION_NOT_FOUND);
    }

    // Update activity timestamp
    this.touchSession(session);

    // Idempotency: if this questionsId was already processed, return success without
    // re-processing. The route handler checks `alreadyProcessed` to skip the SSE update.
    if (session.lastProcessedQuestionsId === questionsId) {
      log.info(`Duplicate answer submission for questionsId: ${questionsId}`);
      const duplicate = { ...session, alreadyProcessed: true } as TaskCreationSession & {
        alreadyProcessed: boolean;
      };
      return ok(duplicate);
    }

    if (!session.pendingQuestions || session.pendingQuestions.id !== questionsId) {
      log.error('Questions ID mismatch:', {
        data: {
          sessionId,
          providedQuestionsId: questionsId,
          hasPendingQuestions: !!session.pendingQuestions,
          serverQuestionsId: session.pendingQuestions?.id ?? null,
          sessionStatus: session.status,
        },
      });
      return err({
        code: 'INVALID_QUESTIONS_ID',
        message: 'Questions ID does not match pending questions',
      });
    }

    // Store reference for type safety (validated above)
    const { questions } = session.pendingQuestions;
    const pendingToolUseId = session.pendingToolUseId;

    // Format answers as a message to send to the AI
    const formattedAnswers = Object.entries(answers)
      .map(([index, answer]) => {
        const question = questions[Number(index)];
        if (!question) return null;
        const formattedAnswer = Array.isArray(answer) ? answer.join(', ') : answer;
        return `- ${question.header}: ${formattedAnswer}`;
      })
      .filter((line): line is string => line !== null);

    const answerMessage = ['Here are my answers to your questions:', ...formattedAnswers].join(
      '\n'
    );

    // Clear pending state and track processed questionsId for idempotency
    session.lastProcessedQuestionsId = questionsId;
    session.pendingQuestions = null;
    session.pendingToolUseId = null;
    session.questionsReadyPromise = null;
    session.questionsReadyResolver = null;
    session.status = 'active';

    // Publish processing event immediately so the frontend clears questions and shows loading.
    // This must happen BEFORE the polling loop to avoid a UI dead time gap.
    try {
      await this.streams.publishTaskCreationProcessing(sessionId, {
        sessionId,
        message: 'Processing your answers...',
      });
    } catch (error: unknown) {
      log.error('Failed to publish processing event:', { error });
    }

    // Wait for the permission resolver if the background processor is active but
    // canUseTool hasn't fired yet. This race happens when the user answers quickly
    // before the SDK's canUseTool callback runs in the background processor.
    // If the resolver doesn't appear within 5s, we fall through to the legacy
    // tool-result fallback path which sends answers via sendToolResult instead.
    if (!session.pendingPermissionResolver && session.streamProcessingPromise) {
      await this.waitForPermissionResolver(session);
    }

    // Check if we have a pending permission resolver (from canUseTool callback)
    const resolver = session.pendingPermissionResolver;
    const originalInput = session.pendingQuestionsInput;

    // Clear permission-related pending state after the polling loop
    session.pendingPermissionResolver = null;
    session.pendingQuestionsInput = null;

    // If we have a permission resolver, resolve it with the answers
    // This continues the SDK's permission flow with the user's answers
    if (resolver && originalInput) {
      log.info('Resolving permission with answers:', {
        data: {
          sessionId,
          questionCount: questions.length,
          answerCount: Object.keys(answers).length,
        },
      });

      // Format answers as a simple key-value object for the SDK
      // The SDK's AskUserQuestion expects answers as { [questionIndex]: selectedAnswer }
      const formattedAnswers: Record<string, string> = {};
      for (const [index, answer] of Object.entries(answers)) {
        // Convert array answers to comma-separated string
        formattedAnswers[index] = Array.isArray(answer) ? answer.join(', ') : answer;
      }

      // Publish tool:result event for AskUserQuestion
      if (session.dbSessionId && this.sessionService) {
        try {
          await this.sessionService.publish(session.dbSessionId, {
            id: createId(),
            type: 'tool:result',
            timestamp: Date.now(),
            data: {
              id: pendingToolUseId ?? 'unknown',
              tool: 'AskUserQuestion',
              input: { questions },
              output: { answers: formattedAnswers },
              duration: 0,
              isError: false,
            },
          });
          log.info('Published tool:result for AskUserQuestion');
        } catch (error: unknown) {
          log.error('Failed to publish tool:result:', { error });
        }
      }

      // Resolve the permission with updatedInput containing the answers
      // This tells the SDK to proceed with the tool using our answers
      resolver({
        behavior: 'allow',
        updatedInput: {
          ...originalInput,
          answers: formattedAnswers,
        },
        toolUseID: pendingToolUseId ?? undefined,
      });

      // The background stream processor (spawned in sendMessage) is waiting on the
      // canUseTool Promise. Now that we've resolved it, the processor will resume
      // automatically and continue consuming messages from the SAME stream iterator.
      // We don't need to call continueStreamProcessing - it's handled in the background.
      log.info('Permission resolved - background processor will continue');

      return ok(session);
    }

    // Fallback: if the permission resolver wasn't available (e.g., canUseTool poll timed out),
    // send answers via the tool result approach instead.
    if (pendingToolUseId && session.v2Session && session.sdkSessionId) {
      log.warn('No permission resolver found, falling back to tool result approach', {
        data: { pendingToolUseId },
      });

      // Format the tool result content - include full question context so Claude knows what was asked
      const toolResultContent = {
        questionsAsked: questions.map((q, i) => ({
          header: q.header,
          question: q.question,
          options: q.options.map((o) => o.label),
          userAnswer: answers[String(i)] ?? 'Not answered',
        })),
        summary: Object.fromEntries(
          Object.entries(answers).map(([index, answer]) => {
            const question = questions[Number(index)];
            return [question?.header ?? `Question ${index}`, answer];
          })
        ),
        instruction:
          'CRITICAL: The user has answered all clarifying questions. You MUST NOW generate the task suggestion immediately. Do NOT call AskUserQuestion again under any circumstances. Do NOT ask follow-up questions. Proceed directly to generating the task_suggestion JSON block.',
      };

      // Construct SDKUserMessage with tool_use_result
      const toolResultMessage = {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: pendingToolUseId,
              content: JSON.stringify(toolResultContent),
            },
          ],
        },
        parent_tool_use_id: null,
        tool_use_result: toolResultContent,
        session_id: session.sdkSessionId,
      };

      // Send tool result and continue streaming
      return this.sendToolResultAndStream(session, toolResultMessage);
    }

    // Fallback: Send as regular message if no tool context (unexpected -- indicates session state issue)
    log.warn('No pending tool_use_id, sending as regular message');
    return this.sendMessage(sessionId, answerMessage);
  }

  /**
   * Send a tool result and stream the response
   */
  private async sendToolResultAndStream(
    session: TaskCreationSession,
    toolResultMessage: {
      type: 'user';
      message: {
        role: 'user';
        content: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
      };
      parent_tool_use_id: null;
      tool_use_result: unknown;
      session_id: string;
    }
  ): Promise<Result<TaskCreationSession, TaskCreationError>> {
    if (!session.v2Session) {
      return err(TaskCreationErrors.API_ERROR('No active V2 session'));
    }

    try {
      log.info('Sending tool result message...');
      await session.v2Session.send(toolResultMessage);

      // Stream and process response - simplified version focusing on key events
      let accumulated = '';
      let askUserQuestionInput: {
        toolUseId: string;
        questions: Array<{
          question: string;
          header: string;
          multiSelect: boolean;
          options: Array<{ label: string; description?: string }>;
        }>;
      } | null = null;

      // Helper to apply pending questions
      const applyPendingQuestions = async (questions: PendingQuestions): Promise<void> => {
        log.info('Applying pending questions (tool result path):', {
          data: {
            sessionId: session.id,
            questionsId: questions.id,
            questionCount: questions.questions.length,
            round: questions.round,
          },
        });
        session.pendingQuestions = questions;
        session.questionRound = questions.round;
        session.totalQuestionsAsked = questions.totalAsked;
        session.status = 'waiting_user';

        try {
          await this.streams.publishTaskCreationQuestions(session.id, {
            sessionId: session.id,
            questions,
          });
        } catch (error: unknown) {
          log.error('Failed to publish questions:', { error });
        }
      };

      for await (const msg of session.v2Session.stream()) {
        log.info(`📨 Stream msg type: ${msg.type}`, {
          data: {
            hasSessionId: !!msg.session_id,
          },
        });

        // DEBUG: Log user messages to see what the SDK recorded as our tool result
        if (msg.type === 'user') {
          const userMsg = msg as { message?: { content?: unknown } };
          log.info('📥 User message in stream:', {
            data: {
              hasMessage: !!userMsg.message,
              contentPreview: JSON.stringify(userMsg.message?.content)?.slice(0, 500),
            },
          });
        }

        // Check for assistant messages with tool_use content or text
        if (msg.type === 'assistant') {
          const assistantMsg = msg as {
            type: 'assistant';
            message?: {
              content?: Array<{
                type: string;
                id?: string;
                name?: string;
                input?: unknown;
                text?: string;
              }>;
            };
          };

          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                accumulated += block.text;
              }

              // Check for AskUserQuestion tool_use
              if (
                block.type === 'tool_use' &&
                block.name === 'AskUserQuestion' &&
                block.input &&
                block.id
              ) {
                log.info(
                  '[TaskCreationService] 🛑 AskUserQuestion detected in tool result response!'
                );
                // DEBUG: Log the full questions being asked in round 2+
                log.info('[TaskCreationService] Round 2+ Questions', {
                  data: { input: block.input as Record<string, unknown> },
                });
                const input = block.input as {
                  questions: Array<{
                    question: string;
                    header: string;
                    multiSelect: boolean;
                    options: Array<{ label: string; description?: string }>;
                  }>;
                };
                askUserQuestionInput = {
                  toolUseId: block.id,
                  questions: input.questions,
                };

                // Publish tool:start event for round 2+ AskUserQuestion
                if (session.dbSessionId && this.sessionService) {
                  try {
                    await this.sessionService.publish(session.dbSessionId, {
                      id: createId(),
                      type: 'tool:start',
                      timestamp: Date.now(),
                      data: {
                        id: block.id,
                        tool: 'AskUserQuestion',
                        input: block.input as Record<string, unknown>,
                      },
                    });
                    log.info(
                      '[TaskCreationService] Published tool:start for AskUserQuestion (round 2+)'
                    );
                  } catch (error: unknown) {
                    log.error('Failed to publish tool:start:', { error });
                  }
                }
                break;
              }
            }
          }

          if (askUserQuestionInput) {
            break;
          }
        }

        // Handle result message
        if (msg.type === 'result') {
          break;
        }
      }

      log.info('📊 Tool result stream completed:', {
        data: {
          accumulatedTextLength: accumulated.length,
          hasAskUserQuestionToolInput: !!askUserQuestionInput,
          currentQuestionRound: session.questionRound,
        },
      });

      // ENFORCE ONE ROUND ONLY: If Claude tries to ask more questions after round 1,
      // silently ignore the tool call - the stream will continue to the task suggestion
      if (askUserQuestionInput && session.questionRound >= 1) {
        log.info(
          '[TaskCreationService] ⏭️ Ignoring additional AskUserQuestion after round 1 - proceeding to task generation'
        );
        // Clear the input so it's not processed below
        askUserQuestionInput = null;
      }

      // Process AskUserQuestion if detected (only for round 0 -> round 1 transition)
      if (askUserQuestionInput) {
        const questions = this.parseAskUserQuestionToolInput(askUserQuestionInput, session);
        if (questions) {
          log.info('Parsed AskUserQuestion from tool result response');
          if (accumulated) {
            await this.addAssistantMessage(session, accumulated, undefined);
          }
          await applyPendingQuestions(questions);
          return ok(session);
        }
      }

      // Add assistant response if we have content
      if (accumulated) {
        await this.addAssistantMessage(session, accumulated, undefined);

        // Try to parse task suggestion from response
        const suggestion = this.parseSuggestion(accumulated);
        if (suggestion) {
          log.info('Parsed task suggestion from tool result response');
          session.suggestion = suggestion;

          try {
            await this.streams.publishTaskCreationSuggestion(session.id, {
              sessionId: session.id,
              suggestion,
            });
          } catch (error: unknown) {
            log.error('Failed to publish suggestion:', { error });
          }
        }
      }

      return ok(session);
    } catch (error: unknown) {
      log.error('Error sending tool result:', { error });
      return err(TaskCreationErrors.API_ERROR('Failed to send tool result'));
    }
  }

  /**
   * Skip clarifying questions and generate task with available information
   */
  async skipQuestions(sessionId: string): Promise<Result<TaskCreationSession, TaskCreationError>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(TaskCreationErrors.SESSION_NOT_FOUND);
    }

    const resolver = session.pendingPermissionResolver;
    const originalInput = session.pendingQuestionsInput;
    const pendingToolUseId = session.pendingToolUseId;

    // Clear pending questions and resume active status
    session.pendingQuestions = null;
    session.pendingToolUseId = null;
    session.pendingQuestionsInput = null;
    session.pendingPermissionResolver = null;
    session.questionsReadyPromise = null;
    session.questionsReadyResolver = null;
    session.status = 'active';

    if (resolver && originalInput) {
      resolver({
        behavior: 'allow',
        updatedInput: { ...originalInput, answers: {} },
        toolUseID: pendingToolUseId ?? undefined,
      });
    }

    // Send a message telling the AI to proceed without further questions
    const skipMessage =
      'Please proceed with generating the task based on the information provided so far. No more clarifying questions needed.';

    return this.sendMessage(sessionId, skipMessage);
  }

  /**
   * Cancel a task creation session
   */
  async cancel(sessionId: string): Promise<Result<TaskCreationSession, TaskCreationError>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return err(TaskCreationErrors.SESSION_NOT_FOUND);
    }

    // Mark as cancelled first to signal background processor to stop
    session.status = 'cancelled';
    session.completedAt = new Date().toISOString();

    // Clean up token buffer
    this.clearTokenBuffer(sessionId);

    // Wait for background processor to complete before closing session
    if (session.streamProcessingPromise) {
      try {
        await session.streamProcessingPromise;
      } catch (error: unknown) {
        log.error('Error waiting for stream processor:', { error });
      }
    }

    // Close V2 session
    if (session.v2Session) {
      try {
        session.v2Session.close();
      } catch (error: unknown) {
        log.error('Failed to close V2 session:', { error });
      }
      session.v2Session = null;
    }

    // Close database session
    if (session.dbSessionId && this.sessionService) {
      try {
        await this.sessionService.close(session.dbSessionId);
        log.info('Closed database session');
      } catch (error: unknown) {
        log.error('Failed to close database session:', { error });
      }
    }

    try {
      await this.streams.publishTaskCreationCancelled(sessionId, {
        sessionId,
      });
    } catch (error: unknown) {
      log.error('Failed to publish cancel event:', { error });
    }

    // Mark DB session as closed
    this.db
      .update(sessions)
      .set({ status: 'closed', closedAt: new Date().toISOString() })
      .where(eq(sessions.id, sessionId))
      .catch((err) =>
        log.warn('Failed to mark cancelled session as closed in DB', {
          error: err instanceof Error ? err.message : String(err),
        })
      );

    // Schedule delayed in-memory cleanup to allow late API calls
    setTimeout(() => {
      this.sessions.delete(sessionId);
      log.info('Cleaned up cancelled session');
    }, 60000);

    return ok(session);
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): TaskCreationSession | null {
    return this.sessions.get(sessionId) ?? null;
  }
}

/**
 * Create TaskCreationService
 */
export function createTaskCreationService(
  db: Database,
  streams: DurableStreamsService,
  sessionService?: SessionService,
  settingsService?: SettingsService
): TaskCreationService {
  return new TaskCreationService(db, streams, sessionService, settingsService);
}
