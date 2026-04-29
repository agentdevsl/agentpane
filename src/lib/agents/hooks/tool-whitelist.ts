import { WILDCARD_TOOL } from '../../constants/tools.js';
import type { PreToolUseHook, PreToolUseInput, PreToolUseResult } from '../types.js';

/**
 * Pre-tool-use hook that enforces a whitelist of tool names.
 *
 * F06-06 / arch29-W2-P (F12-02): An empty `allowedTools` array was previously
 * treated as "allow all" (failure-open). Since the Claude Agent SDK tool
 * surface includes Bash/Write/Edit/WebFetch, any misconfiguration of this
 * hook effectively granted arbitrary code execution. The new contract is:
 *
 *   - `[]`         → DENY every tool
 *   - `['*']`      → ALLOW every tool (the WILDCARD_TOOL sentinel)
 *   - `['X','Y']`  → ALLOW only X and Y
 *
 * Callers that legitimately want an open whitelist must pass `['*']`
 * explicitly (the `ALLOW_ALL_TOOLS` constant in `lib/constants/tools.ts`
 * is exactly that array); silent defaults no longer grant permissions.
 *
 * Previously this file also exported `ALLOW_ALL_TOOLS = '*'` (a bare string)
 * which collided with the array form in `lib/constants/tools.ts`. The bare
 * sentinel is now `WILDCARD_TOOL` (also re-exported from `lib/constants/tools`)
 * and the array form `ALLOW_ALL_TOOLS = ['*']` is the only canonical sentinel
 * for `allowedTools` lists.
 */
export function createToolWhitelistHook(allowedTools: string[]): PreToolUseHook {
  return {
    hooks: [
      async (input: PreToolUseInput): Promise<PreToolUseResult> => {
        // Explicit open-gate sentinel — callers must opt in.
        if (allowedTools.includes(WILDCARD_TOOL)) {
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
