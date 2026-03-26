/**
 * Agent SDK Utilities
 *
 * Common utilities for working with the Claude Agent SDK.
 * Used by both task creation and workflow analyzer.
 */

import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_TASK_CREATION_MODEL, getFullModelId } from '../constants/models.js';

// =============================================================================
// Types
// =============================================================================

export interface AgentQueryOptions {
  /** Model to use for the query */
  model?: string;
  /** Optional callback for streaming tokens */
  onToken?: (delta: string) => void;
}

export interface AgentQueryResult {
  /** The complete response text */
  text: string;
  /** Token usage information */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Model used for the response */
  model?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_MODEL = getFullModelId(DEFAULT_TASK_CREATION_MODEL);

// =============================================================================
// Environment Helpers
// =============================================================================

/**
 * Build a clean env object for Claude Agent SDK subprocess sessions.
 * Strips CLAUDECODE (prevents "nested session" crash) and sensitive vars.
 */
export function buildSdkEnv(extra: Record<string, string> = {}): Record<string, string> {
  const blocked =
    /^(CLAUDECODE|DATABASE_URL|DB_.*|ENCRYPTION_KEY|SESSION_SECRET|GITHUB_APP_PRIVATE_KEY)$/i;
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !blocked.test(key))
  ) as Record<string, string>;
  return { ...base, ...extra };
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Send a single query to the Claude Agent SDK and get a complete response.
 *
 * Uses the same session-based approach as task creation, ensuring consistent
 * API key handling (automatically reads ANTHROPIC_API_KEY from environment).
 *
 * @param prompt - The prompt to send (can include system prompt if needed)
 * @param options - Optional configuration
 * @returns The complete response from the agent
 *
 * @example
 * ```ts
 * const result = await agentQuery("Analyze this template and generate a workflow...");
 * console.log(result.text);
 * ```
 */
export async function agentQuery(
  prompt: string,
  options: AgentQueryOptions = {}
): Promise<AgentQueryResult> {
  const { model = DEFAULT_MODEL, onToken } = options;

  // Create session with Agent SDK (reads API key from env automatically)
  // Enable the task system for structured task tracking
  const session = unstable_v2_createSession({
    model,
    env: buildSdkEnv({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
  });

  try {
    // Send the prompt
    await session.send(prompt);

    let accumulated = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = '';

    // Stream response and collect text
    for await (const msg of session.stream()) {
      // Handle partial streaming messages
      if (msg.type === 'stream_event') {
        const event = msg.event as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        // Capture message_start for model info
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

        // Capture text deltas
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          const delta = event.delta.text;
          accumulated += delta;

          if (onToken) {
            onToken(delta);
          }
        }
      }

      // Handle complete assistant messages
      if (msg.type === 'assistant') {
        const text = getAssistantText(msg);
        if (text) {
          accumulated = text;
        }

        // Extract model and usage from assistant message
        const message = msg.message as {
          model?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (message?.model) {
          modelUsed = message.model;
        }
        if (message?.usage) {
          inputTokens = message.usage.input_tokens ?? 0;
          outputTokens = message.usage.output_tokens ?? 0;
        }
      }

      // Handle result messages which may contain usage info
      if (msg.type === 'result') {
        const result = msg as {
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (result.usage) {
          inputTokens = result.usage.input_tokens ?? inputTokens;
          outputTokens = result.usage.output_tokens ?? outputTokens;
        }
      }
    }

    return {
      text: accumulated,
      usage: inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : undefined,
      model: modelUsed || model,
    };
  } finally {
    session.close();
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract text content from an assistant message.
 */
function getAssistantText(msg: unknown): string | null {
  const message = (msg as { message?: unknown }).message as {
    content?: Array<{ type: string; text?: string }>;
  };

  if (!message?.content) return null;

  const textBlocks = message.content.filter(
    (block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string'
  );

  return textBlocks.map((b) => b.text).join('') || null;
}
