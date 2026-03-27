import type { PostToolUseHook, PostToolUseInput } from '../types.js';

/**
 * Creates a post-tool-use hook that logs tool executions to an audit table.
 */
export function createAuditHook(
  db: { insert: (...args: unknown[]) => { values: (v: unknown) => Promise<unknown> } },
  agentId: string,
  agentRunId: string,
  taskId: string,
  codespaceId: string
): PostToolUseHook {
  let turnNumber = 0;

  return {
    hooks: [
      async (input: PostToolUseInput) => {
        turnNumber++;
        await db.insert('agent_audit_log' as never).values({
          agentId,
          agentRunId,
          taskId,
          codespaceId,
          toolName: input.tool_name,
          toolInput: input.tool_input,
          turnNumber,
          durationMs: input.duration_ms,
          isError: input.tool_response.is_error ?? false,
        });
        return {};
      },
    ],
  };
}
