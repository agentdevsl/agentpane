import type { PreToolUseHook, PreToolUseInput, PreToolUseResult } from '../types.js';

/**
 * Creates a pre-tool-use hook that blocks tools not in the whitelist.
 * An empty whitelist allows all tools.
 */
export function createToolWhitelistHook(allowedTools: string[]): PreToolUseHook {
  return {
    hooks: [
      async (input: PreToolUseInput): Promise<PreToolUseResult> => {
        if (allowedTools.length === 0) {
          return {};
        }

        if (allowedTools.includes(input.tool_name)) {
          return {};
        }

        return {
          decision: 'block',
          message: `Tool "${input.tool_name}" is not allowed. Allowed tools: ${allowedTools.join(', ')}`,
        };
      },
    ],
  };
}
