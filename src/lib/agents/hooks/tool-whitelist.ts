import type { PreToolUseHook, PreToolUseInput, PreToolUseResult } from '../types.js';

/**
 * Sentinel for "open access — every tool is permitted". Callers MUST
 * set `allowedTools: ['*']` to opt in; an empty list now fails closed
 * (F06-06).
 */
export const ALLOW_ALL_TOOLS = '*';

/**
 * Pre-tool-use hook that enforces a whitelist of tool names.
 *
 * F06-06: An empty `allowedTools` array was previously treated as
 * "allow all" (failure-open). Since the Claude Agent SDK tool surface
 * includes Bash/Write/Edit/WebFetch, any misconfiguration of this
 * hook effectively granted arbitrary code execution. The new contract
 * is:
 *
 *   - `[]`         → DENY every tool
 *   - `['*']`      → ALLOW every tool (sentinel)
 *   - `['X','Y']`  → ALLOW only X and Y
 *
 * Callers that legitimately want an open whitelist must pass `['*']`
 * explicitly; silent defaults no longer grant permissions.
 */
export function createToolWhitelistHook(allowedTools: string[]): PreToolUseHook {
  return {
    hooks: [
      async (input: PreToolUseInput): Promise<PreToolUseResult> => {
        // Explicit open-gate sentinel — callers must opt in.
        if (allowedTools.includes(ALLOW_ALL_TOOLS)) {
          return {};
        }

        // Empty list or name-not-in-list both DENY. This is the
        // failure-closed mode that F06-06 requires.
        if (!allowedTools.includes(input.tool_name)) {
          return {
            decision: 'block',
            message:
              allowedTools.length === 0
                ? `Tool "${input.tool_name}" is not allowed. No tools are whitelisted (pass ['*'] for open access).`
                : `Tool "${input.tool_name}" is not allowed. Allowed tools: ${allowedTools.join(', ')}`,
          };
        }

        return {};
      },
    ],
  };
}
