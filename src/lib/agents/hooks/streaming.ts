import { createLogger } from '../../../lib/logging/logger.js';
import type { SessionEvent } from '../../../services/session.service.js';
import type {
  PostToolUseHook,
  PostToolUseInput,
  PreToolUseHook,
  PreToolUseInput,
} from '../types.js';

const log = createLogger('StreamingHooks');

export type AgentStepEvent =
  | {
      type: 'tool:start';
      sessionId: string;
      tool: string;
      input: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: 'tool:result';
      sessionId: string;
      tool: string;
      input: Record<string, unknown>;
      output: unknown;
      duration: number;
      timestamp: number;
    };

type SessionPublisher = {
  publish: (sessionId: string, event: SessionEvent) => Promise<unknown>;
};

/**
 * Creates a unique key for tracking in-flight tool calls.
 * Uses tool name + stringified input to match PreToolUse with PostToolUse.
 *
 * Note: If the same tool is invoked twice with identical inputs before
 * either completes, pairing may be incorrect (FIFO assumption).
 */
function createToolCallKey(toolName: string, toolInput: Record<string, unknown>): string {
  try {
    return `${toolName}:${JSON.stringify(toolInput)}`;
  } catch (error) {
    // Fallback uses timestamp which won't match any PostToolUse,
    // causing the tool result to become an orphan (no pairing)
    const fallbackKey = `${toolName}:${Date.now()}:unmatched`;
    log.error('Failed to serialize tool input for pairing - tool events will not be paired', {
      data: { tool: toolName, fallbackKey },
      error,
    });
    return fallbackKey;
  }
}

export function createStreamingHooks(
  agentId: string,
  sessionId: string,
  sessionService: SessionPublisher
): { PreToolUse: PreToolUseHook; PostToolUse: PostToolUseHook } {
  // Track in-flight tool calls to pair start/result events
  const inFlightToolCalls = new Map<string, string>();

  return {
    PreToolUse: {
      hooks: [
        async (input: PreToolUseInput): Promise<Record<string, never>> => {
          // Generate a unique ID for this tool call
          const toolCallId = crypto.randomUUID();
          const toolCallKey = createToolCallKey(input.tool_name, input.tool_input);

          // Store the toolCallId for pairing with PostToolUse
          inFlightToolCalls.set(toolCallKey, toolCallId);

          // Publish tool start event to session
          try {
            await sessionService.publish(sessionId, {
              id: crypto.randomUUID(),
              type: 'tool:start',
              timestamp: Date.now(),
              data: {
                id: toolCallId,
                agentId,
                tool: input.tool_name,
                input: input.tool_input,
              },
            });
          } catch (error) {
            log.error('Failed to publish tool:start event', {
              data: { tool: input.tool_name, sessionId },
              error,
            });
            // Continue execution - event publishing is non-fatal
          }

          return {};
        },
      ],
    },

    PostToolUse: {
      hooks: [
        async (input: PostToolUseInput): Promise<Record<string, never>> => {
          // Retrieve the toolCallId from the matching PreToolUse
          const toolCallKey = createToolCallKey(input.tool_name, input.tool_input);
          const toolCallId = inFlightToolCalls.get(toolCallKey);

          if (!toolCallId) {
            log.warn('PostToolUse without matching PreToolUse', {
              data: { tool: input.tool_name, sessionId },
            });
          }

          // Clean up the in-flight tracking
          inFlightToolCalls.delete(toolCallKey);

          // Extract error message if the tool call failed
          const isError = input.tool_response.is_error ?? false;
          const errorMessage = isError
            ? input.tool_response.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && !!c.text)
                .map((c) => c.text)
                .join('\n') || 'Tool execution failed'
            : undefined;

          // Publish tool completion event
          try {
            await sessionService.publish(sessionId, {
              id: crypto.randomUUID(),
              type: 'tool:result',
              timestamp: Date.now(),
              data: {
                id: toolCallId ?? crypto.randomUUID(),
                agentId,
                tool: input.tool_name,
                input: input.tool_input,
                output: input.tool_response,
                duration: input.duration_ms,
                isError,
                error: errorMessage,
              },
            });
          } catch (error) {
            log.error('Failed to publish tool:result event', {
              data: { tool: input.tool_name, sessionId },
              error,
            });
            // Continue execution - event publishing is non-fatal
          }

          return {};
        },
      ],
    },
  };
}
