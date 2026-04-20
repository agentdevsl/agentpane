import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import type { PlanSession as DbPlanSession, NewPlanSession } from '../db/schema';
import { codespaces, planSessions, tasks } from '../db/schema';
import type { PlanModeError } from '../lib/errors/plan-mode-errors.js';
import { PlanModeErrors } from '../lib/errors/plan-mode-errors.js';
import type { GitHubIssueCreator } from '../lib/github/issue-creator.js';
import { createLogger } from '../lib/logging/logger.js';
import type { ClaudeClient, ToolCallResult } from '../lib/plan-mode/claude-client.js';
import { createClaudeClient } from '../lib/plan-mode/claude-client.js';
import type { InteractionHandler } from '../lib/plan-mode/interaction-handler.js';
import { createInteractionHandler } from '../lib/plan-mode/interaction-handler.js';
import type {
  CreatePlanSessionInput,
  PlanSession,
  PlanTurn,
  RespondToInteractionInput,
} from '../lib/plan-mode/types.js';
import { errorMessage } from '../lib/utils/error-message.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { DurableStreamsService } from './durable-streams.service.js';

/**
 * Token streaming callback
 */
const log = createLogger('PlanModeService');

export type PlanTokenCallback = (delta: string) => void;

/**
 * Configuration for PlanModeService
 */
export interface PlanModeServiceConfig {
  maxTurns?: number;
  model?: string;
}

/**
 * GitHub configuration for issue creation
 */
export interface GitHubConfig {
  owner: string;
  repo: string;
}

/**
 * PlanModeService handles multi-turn planning sessions using the Claude API directly.
 *
 * Unlike implementation mode, plan mode does not require sandbox isolation as it
 * only generates plans without executing code. The planning conversation supports
 * AskUserQuestion-style interactions and can optionally create GitHub issues
 * from the completed plan.
 */
export class PlanModeService {
  private claudeClient: ClaudeClient | null = null;
  private claudeClientPromise: Promise<Result<ClaudeClient, PlanModeError>> | null = null;
  private interactionHandler: InteractionHandler;
  private maxTurns: number;

  /**
   * Counter for stream/publish events that were dropped due to errors in catch blocks.
   * Incremented each time a non-critical publish (stream events, tokens) fails silently.
   * Use getMetrics() to inspect at runtime. F05-02: now also logs per-increment.
   */
  private droppedEventCount = 0;
  /** F05-02: per-event-type drop counter for the admin metrics endpoint. */
  private droppedByEventType = new Map<string, number>();
  /** F05-02: per-error-code drop counter for the admin metrics endpoint. */
  private droppedByReason = new Map<string, number>();

  /**
   * F05-02: structured log + counter bump for a dropped stream publish.
   * Called from every in-catch publish-failure site so operators have an
   * actionable signal instead of a silent increment.
   */
  private recordDroppedEvent(
    eventType: string,
    streamId: string,
    streamError: unknown,
    context: Record<string, unknown> = {}
  ): void {
    this.droppedEventCount++;
    this.droppedByEventType.set(eventType, (this.droppedByEventType.get(eventType) ?? 0) + 1);
    const code = this.extractErrorCode(streamError);
    this.droppedByReason.set(code, (this.droppedByReason.get(code) ?? 0) + 1);
    log.warn('plan-mode: stream event publish dropped', {
      data: {
        eventType,
        streamId,
        errorCode: code,
        errorMessage: streamError instanceof Error ? streamError.message : String(streamError),
        ...context,
      },
    });
  }

  private extractErrorCode(streamError: unknown): string {
    if (streamError && typeof streamError === 'object' && 'code' in streamError) {
      const code = (streamError as { code: unknown }).code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
    if (streamError instanceof Error && streamError.name !== 'Error') {
      return streamError.name;
    }
    return 'UNKNOWN';
  }

  constructor(
    private db: Database,
    private streams: DurableStreamsService,
    private issueCreator: GitHubIssueCreator | null,
    private githubConfig: GitHubConfig | null,
    config?: PlanModeServiceConfig
  ) {
    this.interactionHandler = createInteractionHandler();
    this.maxTurns = config?.maxTurns ?? 20;
  }

  /**
   * Initialize the Claude client (lazy initialization with race condition protection)
   *
   * Uses a promise-based singleton pattern to prevent multiple concurrent
   * initialization attempts from creating duplicate clients.
   */
  private async getClaudeClient(): Promise<Result<ClaudeClient, PlanModeError>> {
    // Already initialized
    if (this.claudeClient) {
      return ok(this.claudeClient);
    }

    // Initialization in progress - wait for it
    if (this.claudeClientPromise) {
      return this.claudeClientPromise;
    }

    // Start initialization and store the promise to prevent races
    this.claudeClientPromise = createClaudeClient();
    const result = await this.claudeClientPromise;

    if (result.ok) {
      this.claudeClient = result.value;
    }

    // Clear the promise after completion (allows retry on failure)
    this.claudeClientPromise = null;

    return result;
  }

  /**
   * Return runtime metrics for observability.
   * F05-02: now includes per-event-type and per-reason breakdowns so the
   * admin endpoint (GET /api/admin/metrics/plan-mode) can surface detail.
   */
  getMetrics(): {
    droppedEventCount: number;
    droppedByEventType: Record<string, number>;
    droppedByReason: Record<string, number>;
  } {
    return {
      droppedEventCount: this.droppedEventCount,
      droppedByEventType: Object.fromEntries(this.droppedByEventType),
      droppedByReason: Object.fromEntries(this.droppedByReason),
    };
  }

  /**
   * Start a new plan session
   */
  async start(
    input: CreatePlanSessionInput,
    onToken?: PlanTokenCallback
  ): Promise<Result<PlanSession, PlanModeError>> {
    // Verify codespace exists
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, input.codespaceId),
    });

    if (!codespace) {
      return err(PlanModeErrors.PROJECT_NOT_FOUND);
    }

    // Verify task exists
    const task = await this.db.query.tasks.findFirst({
      where: eq(tasks.id, input.taskId),
    });

    if (!task) {
      return err(PlanModeErrors.TASK_NOT_FOUND);
    }

    // Get Claude client
    const clientResult = await this.getClaudeClient();
    if (!clientResult.ok) {
      return clientResult;
    }

    // Create initial turn
    const initialTurn: PlanTurn = {
      id: createId(),
      role: 'user',
      content: input.initialPrompt,
      timestamp: new Date().toISOString(),
    };

    // Create session in database
    const sessionData: NewPlanSession = {
      taskId: input.taskId,
      codespaceId: input.codespaceId,
      status: 'active',
      turns: [initialTurn],
    };

    let dbSession: DbPlanSession;
    try {
      const [inserted] = await this.db.insert(planSessions).values(sessionData).returning();
      if (!inserted) {
        return err(PlanModeErrors.DATABASE_ERROR('insert', 'No session returned after insert'));
      }
      dbSession = inserted;
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.DATABASE_ERROR('insert', message));
    }

    const session = this.dbSessionToSession(dbSession);

    // Use plan:-prefixed stream ID to avoid FK constraint violations.
    // Bare CUIDs (without ':') are treated as session IDs and persisted to
    // session_events, which FK-references sessions.id. Plan session IDs come
    // from planSessions.id, not sessions.id, so we must prefix with 'plan:'.
    const streamId = `plan:${session.id}`;

    // Create the stream for real-time events
    try {
      await this.streams.createStream(streamId, {
        type: 'plan-session',
        taskId: input.taskId,
        codespaceId: input.codespaceId,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:create-stream', streamId, streamError, {
        taskId: input.taskId,
      });
    }

    // Publish start event
    try {
      await this.streams.publishPlanStarted(streamId, {
        sessionId: session.id,
        taskId: session.taskId,
        codespaceId: session.codespaceId,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:started', streamId, streamError, {
        sessionId: session.id,
      });
    }

    // Get initial response from Claude
    const responseResult = await this.processNextTurn(session, onToken);
    if (!responseResult.ok) {
      return responseResult;
    }

    return ok(responseResult.value);
  }

  /**
   * Respond to an interaction (user answering a question)
   */
  async respondToInteraction(
    input: RespondToInteractionInput,
    onToken?: PlanTokenCallback
  ): Promise<Result<PlanSession, PlanModeError>> {
    // Get session
    const dbSession = await this.db.query.planSessions.findFirst({
      where: eq(planSessions.id, input.sessionId),
    });

    if (!dbSession) {
      return err(PlanModeErrors.SESSION_NOT_FOUND);
    }

    const session = this.dbSessionToSession(dbSession);

    if (session.status !== 'waiting_user') {
      return err(PlanModeErrors.NOT_WAITING_FOR_USER);
    }

    // Process the answer
    const answerResult = this.interactionHandler.answerInteraction(
      session,
      input.interactionId,
      input.answers
    );

    if (!answerResult.ok) {
      return answerResult;
    }

    const { updatedSession, responseTurn } = answerResult.value;

    // Publish the user response turn
    try {
      await this.streams.publishPlanTurn(`plan:${updatedSession.id}`, {
        sessionId: updatedSession.id,
        turnId: responseTurn.id,
        role: responseTurn.role,
        content: responseTurn.content,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:turn', `plan:${updatedSession.id}`, streamError, {
        sessionId: updatedSession.id,
        turnId: responseTurn.id,
      });
    }

    // Update database
    try {
      await this.db
        .update(planSessions)
        .set({
          turns: updatedSession.turns,
          status: 'active',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(planSessions.id, updatedSession.id));
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.DATABASE_ERROR('update', message));
    }

    // Continue conversation
    return this.processNextTurn(updatedSession, onToken);
  }

  /**
   * Cancel a plan session
   */
  async cancel(sessionId: string): Promise<Result<PlanSession, PlanModeError>> {
    const dbSession = await this.db.query.planSessions.findFirst({
      where: eq(planSessions.id, sessionId),
    });

    if (!dbSession) {
      return err(PlanModeErrors.SESSION_NOT_FOUND);
    }

    if (dbSession.status === 'completed' || dbSession.status === 'cancelled') {
      return err(PlanModeErrors.SESSION_COMPLETED(sessionId));
    }

    try {
      const [updated] = await this.db
        .update(planSessions)
        .set({
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(planSessions.id, sessionId))
        .returning();

      if (!updated) {
        return err(PlanModeErrors.DATABASE_ERROR('update', 'No session returned after cancel'));
      }

      return ok(this.dbSessionToSession(updated));
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.DATABASE_ERROR('update', message));
    }
  }

  /**
   * Get a plan session by ID
   */
  async getById(sessionId: string): Promise<Result<PlanSession, PlanModeError>> {
    const dbSession = await this.db.query.planSessions.findFirst({
      where: eq(planSessions.id, sessionId),
    });

    if (!dbSession) {
      return err(PlanModeErrors.SESSION_NOT_FOUND);
    }

    return ok(this.dbSessionToSession(dbSession));
  }

  /**
   * Get plan session by task ID
   */
  async getByTaskId(taskId: string): Promise<Result<PlanSession | null, never>> {
    const dbSession = await this.db.query.planSessions.findFirst({
      where: eq(planSessions.taskId, taskId),
    });

    if (!dbSession) {
      return ok(null);
    }

    return ok(this.dbSessionToSession(dbSession));
  }

  /**
   * Process the next turn in the conversation
   */
  private async processNextTurn(
    session: PlanSession,
    onToken?: PlanTokenCallback
  ): Promise<Result<PlanSession, PlanModeError>> {
    // Check turn limit
    if (session.turns.length >= this.maxTurns * 2) {
      return err(PlanModeErrors.MAX_TURNS_EXCEEDED(this.maxTurns));
    }

    // Get Claude client
    const clientResult = await this.getClaudeClient();
    if (!clientResult.ok) {
      return clientResult;
    }

    const client = clientResult.value;

    // Token streaming wrapper
    let accumulated = '';
    const tokenCallback = onToken
      ? (delta: string) => {
          accumulated += delta;
          onToken(delta);
          // Publish token event (fire-and-forget with error logging)
          this.streams
            .publishPlanToken(`plan:${session.id}`, {
              sessionId: session.id,
              delta,
            })
            .catch((streamError: unknown) => {
              this.recordDroppedEvent('plan:token', `plan:${session.id}`, streamError, {
                sessionId: session.id,
              });
            });
        }
      : undefined;

    // Send message to Claude
    const response = await client.sendMessage(session.turns, tokenCallback);

    if (!response.ok) {
      try {
        await this.streams.publishPlanError(`plan:${session.id}`, {
          sessionId: session.id,
          error: response.error.message,
          code: response.error.code,
        });
      } catch (streamError) {
        this.recordDroppedEvent('plan:error', `plan:${session.id}`, streamError, {
          sessionId: session.id,
        });
      }
      return response;
    }

    const result = response.value;

    // Handle tool use
    if (result.type === 'tool_use') {
      return this.handleToolUse(session, result, accumulated);
    }

    // Regular text response
    const assistantTurn: PlanTurn = {
      id: createId(),
      role: 'assistant',
      content: result.text,
      timestamp: new Date().toISOString(),
    };

    const updatedTurns = [...session.turns, assistantTurn];
    const updatedSession: PlanSession = {
      ...session,
      turns: updatedTurns,
    };

    // Update database
    try {
      await this.db
        .update(planSessions)
        .set({
          turns: updatedTurns,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(planSessions.id, session.id));
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.DATABASE_ERROR('update', message));
    }

    // Publish turn event
    try {
      await this.streams.publishPlanTurn(`plan:${session.id}`, {
        sessionId: session.id,
        turnId: assistantTurn.id,
        role: assistantTurn.role,
        content: assistantTurn.content,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:turn', `plan:${session.id}`, streamError, {
        sessionId: session.id,
        turnId: assistantTurn.id,
      });
    }

    return ok(updatedSession);
  }

  /**
   * Handle tool use from Claude
   */
  private async handleToolUse(
    session: PlanSession,
    toolCall: ToolCallResult,
    streamedContent: string
  ): Promise<Result<PlanSession, PlanModeError>> {
    if (toolCall.toolName === 'AskUserQuestion') {
      return this.handleAskUserQuestion(session, toolCall, streamedContent);
    }

    if (toolCall.toolName === 'CreateGitHubIssue') {
      return this.handleCreateGitHubIssue(session, toolCall, streamedContent);
    }

    // Unknown tool - create error turn
    return err(PlanModeErrors.PARSING_ERROR(`Unknown tool: ${toolCall.toolName}`));
  }

  /**
   * Handle AskUserQuestion tool
   */
  private async handleAskUserQuestion(
    session: PlanSession,
    toolCall: ToolCallResult,
    streamedContent: string
  ): Promise<Result<PlanSession, PlanModeError>> {
    const clientResult = await this.getClaudeClient();
    if (!clientResult.ok) {
      return clientResult;
    }

    const client = clientResult.value;
    const interaction = client.parseAskUserQuestion(toolCall.input);

    // Create assistant turn with interaction
    const assistantTurn = this.interactionHandler.createInteractionTurn(
      streamedContent || 'I have some questions for you:',
      interaction
    );

    const updatedTurns = [...session.turns, assistantTurn];
    const updatedSession: PlanSession = {
      ...session,
      turns: updatedTurns,
      status: 'waiting_user',
    };

    // Update database
    try {
      await this.db
        .update(planSessions)
        .set({
          turns: updatedTurns,
          status: 'waiting_user',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(planSessions.id, session.id));
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.DATABASE_ERROR('update', message));
    }

    // Publish interaction event
    try {
      await this.streams.publishPlanInteraction(`plan:${session.id}`, {
        sessionId: session.id,
        interactionId: interaction.id,
        questions: interaction.questions,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:interaction', `plan:${session.id}`, streamError, {
        sessionId: session.id,
        interactionId: interaction.id,
      });
    }

    // Publish turn event
    try {
      await this.streams.publishPlanTurn(`plan:${session.id}`, {
        sessionId: session.id,
        turnId: assistantTurn.id,
        role: assistantTurn.role,
        content: assistantTurn.content,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:turn', `plan:${session.id}`, streamError, {
        sessionId: session.id,
        turnId: assistantTurn.id,
      });
    }

    return ok(updatedSession);
  }

  /**
   * Handle CreateGitHubIssue tool
   */
  private async handleCreateGitHubIssue(
    session: PlanSession,
    toolCall: ToolCallResult,
    streamedContent: string
  ): Promise<Result<PlanSession, PlanModeError>> {
    if (!this.issueCreator || !this.githubConfig) {
      // No GitHub configuration - notify user and complete without creating issue
      try {
        await this.streams.publishPlanError(`plan:${session.id}`, {
          sessionId: session.id,
          error:
            'Plan completed but GitHub issue was not created: GitHub configuration (owner/repo) is not set. Configure GitHub settings to enable automatic issue creation.',
          code: 'GITHUB_CONFIG_MISSING',
        });
      } catch (streamError) {
        this.recordDroppedEvent('plan:error', `plan:${session.id}`, streamError, {
          sessionId: session.id,
          reason: 'GITHUB_CONFIG_MISSING',
        });
      }
      return this.completeSession(session, streamedContent);
    }

    const clientResult = await this.getClaudeClient();
    if (!clientResult.ok) {
      return clientResult;
    }

    const client = clientResult.value;
    const issueInput = client.parseCreateGitHubIssue(toolCall.input);

    // Create GitHub issue
    const issueResult = await this.issueCreator.createFromToolInput(
      issueInput,
      this.githubConfig.owner,
      this.githubConfig.repo
    );

    if (!issueResult.ok) {
      // Emit error event so user is informed the issue wasn't created
      try {
        await this.streams.publishPlanError(`plan:${session.id}`, {
          sessionId: session.id,
          error: `Plan completed but GitHub issue creation failed: ${issueResult.error.message}`,
          code: 'GITHUB_ISSUE_CREATION_FAILED',
        });
      } catch (streamError) {
        this.recordDroppedEvent('plan:error', `plan:${session.id}`, streamError, {
          sessionId: session.id,
          reason: 'GITHUB_ISSUE_CREATION_FAILED',
        });
      }
      // Complete session but include indication that issue creation failed
      return this.completeSession(session, streamedContent);
    }

    // Complete session with issue info
    return this.completeSession(session, streamedContent, {
      issueUrl: issueResult.value.url,
      issueNumber: issueResult.value.number,
    });
  }

  /**
   * Complete a plan session
   */
  private async completeSession(
    session: PlanSession,
    finalContent: string,
    issueInfo?: { issueUrl: string; issueNumber: number }
  ): Promise<Result<PlanSession, PlanModeError>> {
    // Create final assistant turn
    const assistantTurn: PlanTurn = {
      id: createId(),
      role: 'assistant',
      content: finalContent || 'Plan completed.',
      timestamp: new Date().toISOString(),
    };

    const updatedTurns = [...session.turns, assistantTurn];
    const completedSession: PlanSession = {
      ...session,
      turns: updatedTurns,
      status: 'completed',
      githubIssueUrl: issueInfo?.issueUrl,
      githubIssueNumber: issueInfo?.issueNumber,
      completedAt: new Date().toISOString(),
    };

    // Update database
    try {
      await this.db
        .update(planSessions)
        .set({
          turns: updatedTurns,
          status: 'completed',
          githubIssueUrl: issueInfo?.issueUrl,
          githubIssueNumber: issueInfo?.issueNumber,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(planSessions.id, session.id));
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.DATABASE_ERROR('update', message));
    }

    // Publish turn event
    try {
      await this.streams.publishPlanTurn(`plan:${session.id}`, {
        sessionId: session.id,
        turnId: assistantTurn.id,
        role: assistantTurn.role,
        content: assistantTurn.content,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:turn', `plan:${session.id}`, streamError, {
        sessionId: session.id,
        turnId: assistantTurn.id,
        phase: 'complete',
      });
    }

    // Publish completion event
    try {
      await this.streams.publishPlanCompleted(`plan:${session.id}`, {
        sessionId: session.id,
        issueUrl: issueInfo?.issueUrl,
        issueNumber: issueInfo?.issueNumber,
      });
    } catch (streamError) {
      this.recordDroppedEvent('plan:completed', `plan:${session.id}`, streamError, {
        sessionId: session.id,
      });
    }

    return ok(completedSession);
  }

  /**
   * Convert database session to domain model
   */
  private dbSessionToSession(dbSession: DbPlanSession): PlanSession {
    return {
      id: dbSession.id,
      taskId: dbSession.taskId,
      codespaceId: dbSession.codespaceId,
      status: dbSession.status,
      turns: (dbSession.turns ?? []) as PlanTurn[],
      githubIssueUrl: dbSession.githubIssueUrl ?? undefined,
      githubIssueNumber: dbSession.githubIssueNumber ?? undefined,
      createdAt: dbSession.createdAt,
      completedAt: dbSession.completedAt ?? undefined,
    };
  }
}

/**
 * Create a PlanModeService
 */
export function createPlanModeService(
  db: Database,
  streams: DurableStreamsService,
  issueCreator: GitHubIssueCreator | null,
  githubConfig: GitHubConfig | null,
  config?: PlanModeServiceConfig
): PlanModeService {
  return new PlanModeService(db, streams, issueCreator, githubConfig, config);
}
