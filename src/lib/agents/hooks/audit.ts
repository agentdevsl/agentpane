import type { Database } from '../../../types/database.js';
import type { PostToolUseHook, PostToolUseInput } from '../types.js';

export function createAuditHook(
  db: Database,
  agentId: string,
  agentRunId: string,
  taskId: string | null,
  codespaceId: string
): PostToolUseHook {
  let turnNumber = 0;

  return {
    hooks: [
      async (input: PostToolUseInput): Promise<Record<string, never>> => {
        turnNumber++;

        try {
          // Dynamic import to avoid circular dependencies
          const { auditLogs } = await import('../../../db/schema/index.js');

          await db.insert(auditLogs).values({
            agentId,
            agentRunId,
            taskId,
            codespaceId,
            tool: input.tool_name,
            status: input.tool_response.is_error ? 'error' : 'complete',
            input: input.tool_input as Record<string, unknown>,
            output: input.tool_response.content as unknown as Record<string, unknown>,
            errorMessage: input.tool_response.is_error
              ? (input.tool_response.content[0] as { text?: string })?.text
              : null,
            durationMs: input.duration_ms,
            turnNumber,
          });
        } catch (_error) {}

        return {};
      },
    ],
  };
}
