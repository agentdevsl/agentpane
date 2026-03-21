/**
 * SL-009: Task Creation SDK Service
 *
 * Extracted from TaskCreationService to encapsulate Claude Agent SDK interactions:
 * - V2 session creation and configuration
 * - canUseTool callback construction for AskUserQuestion handling
 * - SDK environment and model resolution
 *
 * This reduces the surface area of the main TaskCreationService and isolates
 * SDK-specific concerns into a focused module.
 */
import {
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  unstable_v2_createSession,
} from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import { buildSdkEnv } from '@/lib/agents/agent-sdk-utils';
import { DEFAULT_TASK_CREATION_MODEL, getFullModelId } from '@/lib/constants/models';
import { DEFAULT_TASK_CREATION_TOOLS } from '@/lib/constants/tools';
import { getPromptDefaultText, resolvePromptServer } from '@/lib/prompts';
import type { SettingsService } from './settings.service';

/** V2 Session interface - matches SDK's SDKSession */
export interface V2Session {
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage>;
  close(): void;
}

/** SDK User Message for tool results */
export interface SDKUserMessage {
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
export type PermissionResolver = (result: PermissionResult) => void;

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

/** Callback invoked when canUseTool detects AskUserQuestion */
export type OnQuestionsCallback = (
  questions: PendingQuestions,
  toolUseId: string,
  rawInput: Record<string, unknown>,
  resolve: PermissionResolver
) => Promise<void>;

/** Callback invoked when canUseTool allows a non-AskUserQuestion tool */
export type OnToolAllowedCallback = (toolName: string, toolUseId: string) => void;

/** Maximum total questions to ask across all rounds */
const MAX_QUESTIONS = 4;

/** Fallback system prompt when settingsService is unavailable */
const SYSTEM_PROMPT_DEFAULT = getPromptDefaultText('task-creation');

/**
 * TaskCreationSdkService encapsulates Claude Agent SDK session management
 * for the task creation flow.
 */
export class TaskCreationSdkService {
  constructor(private settingsService?: SettingsService) {}

  /**
   * Resolve the model to use for task creation.
   */
  async resolveModel(): Promise<string> {
    return this.settingsService
      ? await this.settingsService.getTaskCreationModel()
      : getFullModelId(DEFAULT_TASK_CREATION_MODEL);
  }

  /**
   * Resolve the system prompt for task creation.
   */
  async resolveSystemPrompt(): Promise<string> {
    return this.settingsService
      ? await resolvePromptServer('task-creation', this.settingsService)
      : SYSTEM_PROMPT_DEFAULT;
  }

  /**
   * Build the list of allowed tools, ensuring AskUserQuestion is included.
   */
  buildAllowedTools(configuredTools?: string[]): string[] {
    const baseTools = configuredTools ?? DEFAULT_TASK_CREATION_TOOLS;
    return baseTools.includes('AskUserQuestion') ? baseTools : [...baseTools, 'AskUserQuestion'];
  }

  /**
   * Create a V2 SDK session with the appropriate configuration.
   *
   * @param model - The model to use
   * @param allowedTools - Tools to allow
   * @param canUseTool - Permission callback
   * @returns The created V2Session
   */
  createSession(model: string, allowedTools: string[], canUseTool: CanUseTool): V2Session {
    return unstable_v2_createSession({
      model,
      env: buildSdkEnv({ CLAUDE_CODE_ENABLE_TASKS: 'true', DEBUG_CLAUDE_AGENT_SDK: '1' }),
      allowedTools,
      canUseTool,
    }) as V2Session;
  }

  /**
   * Build a canUseTool callback that handles AskUserQuestion permission flow.
   *
   * @param sessionId - The session ID for logging
   * @param getSession - Getter for the current session state
   * @param onQuestions - Callback when questions are detected
   * @returns CanUseTool callback
   */
  buildCanUseTool(
    _sessionId: string,
    getSession: () => {
      pendingToolUseId: string | null;
      pendingQuestionsInput: Record<string, unknown> | null;
      pendingPermissionResolver: PermissionResolver | null;
      status: string;
      questionRound: number;
      totalQuestionsAsked: number;
      pendingQuestions: PendingQuestions | null;
      questionsReadyResolver: (() => void) | null;
      questionsReadyPromise: Promise<void> | null;
    } | null,
    onQuestions: OnQuestionsCallback
  ): CanUseTool {
    return async (toolName, input, options) => {
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'allow' as const, toolUseID: options.toolUseID };
      }

      const session = getSession();
      if (!session) {
        return {
          behavior: 'deny' as const,
          message: 'Session not found',
          toolUseID: options.toolUseID,
        };
      }

      // Store the questions input and tool use ID
      session.pendingToolUseId = options.toolUseID;
      session.pendingQuestionsInput = input as Record<string, unknown>;

      // Parse questions
      const rawQuestions = (input as { questions: unknown }).questions as Array<{
        question: string;
        header: string;
        multiSelect: boolean;
        options: Array<{ label: string; description?: string }>;
      }>;

      if (!rawQuestions || rawQuestions.length === 0) {
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

      // Check max questions
      const remainingQuestions = MAX_QUESTIONS - session.totalQuestionsAsked;
      if (remainingQuestions <= 0) {
        return { behavior: 'allow' as const, toolUseID: options.toolUseID };
      }

      const questionsToProcess = rawQuestions.slice(0, remainingQuestions);
      const questions: PendingQuestions = {
        id: createId(),
        questions: questionsToProcess.map((q) => ({
          header: q.header,
          question: q.question,
          options: q.options.map((opt) => ({
            label: opt.label,
            description: opt.description,
          })),
          multiSelect: q.multiSelect ?? false,
        })),
        round: session.questionRound + 1,
        totalAsked: session.totalQuestionsAsked + questionsToProcess.length,
        maxQuestions: MAX_QUESTIONS,
      };

      session.pendingQuestions = questions;
      session.questionRound = questions.round;
      session.totalQuestionsAsked = questions.totalAsked;
      session.status = 'waiting_user';

      // Signal that questions are ready
      if (session.questionsReadyResolver) {
        session.questionsReadyResolver();
        session.questionsReadyPromise = null;
        session.questionsReadyResolver = null;
      }

      // Create a Promise that will be resolved when user provides answers
      return new Promise<PermissionResult>((resolve) => {
        onQuestions(questions, options.toolUseID, input as Record<string, unknown>, resolve);
      });
    };
  }
}
