import Anthropic from '@anthropic-ai/sdk';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';
import type { SettingsService } from '../../services/settings.service.js';
import type { OAuthCredentials } from '../../types/credentials.js';
import { DEFAULT_TASK_CREATION_MODEL, getFullModelId } from '../constants/models.js';
import { PlanModeErrors } from '../errors/plan-mode-errors.js';
import { getPromptDefaultText, resolvePromptServer } from '../prompts/index.js';
import { errorMessage } from '../utils/error-message';
import { readCredentialsFile } from '../utils/resolve-anthropic-key.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import type { ClaudeMessage, PlanTurn, UserInteraction } from './types.js';
import { askUserQuestionTool, createGitHubIssueTool } from './types.js';

/**
 * Zod schema for AskUserQuestion tool input
 */
const askUserQuestionSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string(),
        })
      ),
      multiSelect: z.boolean(),
    })
  ),
});

/**
 * Zod schema for CreateGitHubIssue tool input
 */
const createGitHubIssueSchema = z.object({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
});

/**
 * Claude client configuration
 */
export interface ClaudeClientConfig {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  settingsService?: SettingsService;
}

/**
 * Tool call result from Claude
 */
export interface ToolCallResult {
  type: 'tool_use';
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

/**
 * Text result from Claude
 */
export interface TextResult {
  type: 'text';
  text: string;
}

/**
 * Streaming callback for tokens
 */
export type TokenCallback = (delta: string) => void;

/**
 * Result of a Claude API call
 */
export type ClaudeResult = TextResult | ToolCallResult;

const DEFAULT_MODEL = getFullModelId(DEFAULT_TASK_CREATION_MODEL);
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Load OAuth credentials from disk using the shared credential reader.
 * Wraps readCredentialsFile() with Result-based error types for plan mode.
 */
export async function loadCredentials(): Promise<
  Result<OAuthCredentials, typeof PlanModeErrors.CREDENTIALS_NOT_FOUND>
> {
  const credentials = await readCredentialsFile();
  if (!credentials) {
    return err(PlanModeErrors.CREDENTIALS_NOT_FOUND);
  }
  return ok(credentials);
}

/**
 * Claude API client for plan mode
 *
 * Uses credentials from ~/.claude/.credentials.json where the accessToken
 * field is used as the Anthropic API key. This is the standard format used
 * by Claude Code CLI for storing authentication credentials.
 */
export class ClaudeClient {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private systemPrompt: string | null;
  private settingsService?: SettingsService;
  private resolvedPrompt: string | null = null;

  constructor(credentials: OAuthCredentials, config?: ClaudeClientConfig) {
    // The accessToken from Claude credentials file is used as the API key
    this.client = new Anthropic({
      apiKey: credentials.accessToken,
    });
    this.model = config?.model ?? DEFAULT_MODEL;
    this.maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.systemPrompt = config?.systemPrompt ?? null;
    this.settingsService = config?.settingsService;
  }

  /**
   * Lazily resolve the system prompt from settings or default.
   * Caches the result after first resolution.
   */
  private async getSystemPrompt(): Promise<string> {
    if (this.resolvedPrompt) return this.resolvedPrompt;

    if (this.systemPrompt) {
      this.resolvedPrompt = this.systemPrompt;
    } else if (this.settingsService) {
      this.resolvedPrompt = await resolvePromptServer('plan-mode-default', this.settingsService);
    } else {
      this.resolvedPrompt = getPromptDefaultText('plan-mode-default');
    }
    return this.resolvedPrompt;
  }

  /**
   * Convert plan turns to Claude message format
   */
  private turnsToMessages(turns: PlanTurn[]): ClaudeMessage[] {
    const messages: ClaudeMessage[] = [];

    for (const turn of turns) {
      if (turn.role === 'user') {
        // User turn - could be initial prompt or answer to interaction
        if (turn.interaction?.answers) {
          // Format answers nicely
          const answerText = Object.entries(turn.interaction.answers)
            .map(([q, a]) => `Q: ${q}\nA: ${a}`)
            .join('\n\n');
          messages.push({ role: 'user', content: answerText });
        } else {
          messages.push({ role: 'user', content: turn.content });
        }
      } else {
        // Assistant turn
        messages.push({ role: 'assistant', content: turn.content });
      }
    }

    return messages;
  }

  /**
   * Send a message and get a response
   * Supports streaming via callback
   */
  async sendMessage(
    turns: PlanTurn[],
    onToken?: TokenCallback
  ): Promise<
    Result<
      ClaudeResult,
      | ReturnType<typeof PlanModeErrors.API_ERROR>
      | ReturnType<typeof PlanModeErrors.TOOL_INPUT_PARSE_ERROR>
    >
  > {
    const messages = this.turnsToMessages(turns);

    try {
      if (onToken) {
        // Streaming mode
        return await this.streamMessage(messages, onToken);
      } else {
        // Non-streaming mode
        return await this.sendNonStreaming(messages);
      }
    } catch (error) {
      const message = errorMessage(error);
      return err(PlanModeErrors.API_ERROR(message));
    }
  }

  private async sendNonStreaming(
    messages: ClaudeMessage[]
  ): Promise<Result<ClaudeResult, ReturnType<typeof PlanModeErrors.API_ERROR>>> {
    const systemPrompt = await this.getSystemPrompt();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: messages as Anthropic.MessageParam[],
      tools: [askUserQuestionTool as Anthropic.Tool, createGitHubIssueTool as Anthropic.Tool],
    });

    // Check for tool use
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        return ok({
          type: 'tool_use',
          toolName: block.name,
          toolId: block.id,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    // Extract text
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const text = textBlocks.map((b) => b.text).join('');

    return ok({ type: 'text', text });
  }

  private async streamMessage(
    messages: ClaudeMessage[],
    onToken: TokenCallback
  ): Promise<
    Result<
      ClaudeResult,
      | ReturnType<typeof PlanModeErrors.API_ERROR>
      | ReturnType<typeof PlanModeErrors.TOOL_INPUT_PARSE_ERROR>
    >
  > {
    let accumulated = '';
    let toolUse: ToolCallResult | null = null;
    let toolInputJson = '';

    const systemPrompt = await this.getSystemPrompt();
    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: messages as Anthropic.MessageParam[],
      tools: [askUserQuestionTool as Anthropic.Tool, createGitHubIssueTool as Anthropic.Tool],
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolUse = {
            type: 'tool_use',
            toolName: event.content_block.name,
            toolId: event.content_block.id,
            input: {},
          };
          toolInputJson = '';
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          accumulated += event.delta.text;
          onToken(event.delta.text);
        } else if (event.delta.type === 'input_json_delta' && toolUse) {
          // Accumulate JSON delta for tool input - parse at content_block_stop
          toolInputJson += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        // Parse accumulated JSON when the content block ends
        if (toolUse && toolInputJson) {
          try {
            toolUse.input = JSON.parse(toolInputJson) as Record<string, unknown>;
          } catch (parseError) {
            // JSON parsing failure is a critical error - the tool cannot be used without valid input
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            return err(
              PlanModeErrors.TOOL_INPUT_PARSE_ERROR(
                toolUse.toolName,
                `Invalid JSON: ${message}. Partial input: ${toolInputJson.slice(0, 100)}`
              )
            );
          }
        }
      }
    }

    if (toolUse) {
      return ok(toolUse);
    }

    return ok({ type: 'text', text: accumulated });
  }

  /**
   * Parse AskUserQuestion tool input into UserInteraction
   * Validates input with Zod schema before returning
   */
  parseAskUserQuestion(input: Record<string, unknown>): UserInteraction {
    const parsed = askUserQuestionSchema.parse(input);

    return {
      id: createId(),
      type: 'question',
      questions: parsed.questions,
    };
  }

  /**
   * Parse CreateGitHubIssue tool input
   * Validates input with Zod schema before returning
   */
  parseCreateGitHubIssue(input: Record<string, unknown>): {
    title: string;
    body: string;
    labels?: string[];
  } {
    const parsed = createGitHubIssueSchema.parse(input);
    return {
      title: parsed.title,
      body: parsed.body,
      labels: parsed.labels,
    };
  }
}

/**
 * Create a Claude client using credentials from ~/.claude/.credentials.json
 */
export async function createClaudeClient(
  config?: ClaudeClientConfig
): Promise<
  Result<
    ClaudeClient,
    | typeof PlanModeErrors.CREDENTIALS_NOT_FOUND
    | typeof PlanModeErrors.CREDENTIALS_EXPIRED
    | ReturnType<typeof PlanModeErrors.API_ERROR>
  >
> {
  const credentials = await loadCredentials();
  if (!credentials.ok) {
    return credentials;
  }

  return ok(new ClaudeClient(credentials.value, config));
}
