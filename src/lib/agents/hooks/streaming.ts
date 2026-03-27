import type {
  PostToolUseHook,
  PostToolUseInput,
  PreToolUseHook,
  PreToolUseInput,
} from '../types.js';

interface SessionService {
  publish: (sessionId: string, event: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Creates streaming hooks that publish tool events to a session service.
 */
export function createStreamingHooks(
  agentId: string,
  sessionId: string,
  sessionService: SessionService
): { PreToolUse: PreToolUseHook; PostToolUse: PostToolUseHook } {
  return {
    PreToolUse: {
      hooks: [
        async (input: PreToolUseInput) => {
          await sessionService.publish(sessionId, {
            type: 'tool:start',
            data: {
              agentId,
              tool: input.tool_name,
              input: input.tool_input,
            },
          });
          return {};
        },
      ],
    },
    PostToolUse: {
      hooks: [
        async (input: PostToolUseInput) => {
          await sessionService.publish(sessionId, {
            type: 'tool:result',
            data: {
              agentId,
              tool: input.tool_name,
              duration: input.duration_ms,
              isError: input.tool_response.is_error ?? false,
            },
          });
          return {};
        },
      ],
    },
  };
}
