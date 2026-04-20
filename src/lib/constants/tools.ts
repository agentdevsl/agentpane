/**
 * Tool groups and defaults for agent configurations.
 *
 * F06-06: The whitelist hook previously treated an empty array as
 * "allow all". The new contract requires an explicit `['*']` sentinel
 * for open access — an empty array now DENIES every tool. Callers
 * that want the legacy open-gate behaviour must use
 * `ALLOW_ALL_TOOLS` (defined below), which is `['*']`.
 */

/** Tool categories with their member tools (based on Claude Agent SDK) */
export const TOOL_GROUPS = {
  Files: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'],
  System: ['Bash', 'TaskStop'],
  Web: ['WebFetch', 'WebSearch'],
  Agent: ['Task', 'TaskOutput', 'ExitPlanMode'],
  Interactive: ['AskUserQuestion', 'TodoWrite'],
  MCP: ['Mcp', 'ListMcpResources', 'ReadMcpResource'],
} as const;

/** All available tools flattened */
export const ALL_TOOLS = Object.values(TOOL_GROUPS).flat();

/** Tool type */
export type ToolName = (typeof ALL_TOOLS)[number];

/**
 * Special sentinel indicating "allow all tools" (F06-06).
 * Pass this (or `['*']`) to the whitelist hook to opt in to open access.
 * An empty array now DENIES every tool.
 */
export const ALLOW_ALL_TOOLS: string[] = ['*'];

/** Default tools for agent execution (all tools — requires explicit ['*']) */
export const DEFAULT_AGENT_TOOLS: string[] = ALLOW_ALL_TOOLS;

/** Default tools for task creation AI (read-only, no execution) */
export const DEFAULT_TASK_CREATION_TOOLS: string[] = ['Read', 'Glob', 'Grep', 'AskUserQuestion'];

/** Default tools for workflow designer AI (read-only) */
export const DEFAULT_WORKFLOW_TOOLS: string[] = ['Read', 'Glob', 'Grep'];

/**
 * Get tools for agent execution from localStorage or default.
 */
export function getAgentTools(): string[] {
  if (typeof window === 'undefined') return DEFAULT_AGENT_TOOLS;
  const stored = localStorage.getItem('agent_tools');
  return stored ? JSON.parse(stored) : DEFAULT_AGENT_TOOLS;
}

/**
 * Get tools for task creation from localStorage or default.
 * This is the synchronous version for backwards compatibility.
 * Prefer using getTaskCreationToolsAsync() in new code.
 */
export function getTaskCreationTools(): string[] {
  if (typeof window === 'undefined') return DEFAULT_TASK_CREATION_TOOLS;
  const stored = localStorage.getItem('task_creation_tools');
  return stored ? JSON.parse(stored) : DEFAULT_TASK_CREATION_TOOLS;
}

/**
 * Get tools for task creation from the API (async version).
 * Falls back to localStorage/default if API call fails.
 * Use this in React components and async contexts.
 */
export async function getTaskCreationToolsAsync(): Promise<string[]> {
  // Server-side: return default
  if (typeof window === 'undefined') {
    return DEFAULT_TASK_CREATION_TOOLS;
  }

  // Client-side: use the settings hook helper
  const { getTaskCreationToolsAsync: fetchFromApi } = await import('@/lib/hooks/use-settings');
  return fetchFromApi();
}

/**
 * Get tools for workflow designer from localStorage or default.
 */
export function getWorkflowTools(): string[] {
  if (typeof window === 'undefined') return DEFAULT_WORKFLOW_TOOLS;
  const stored = localStorage.getItem('workflow_tools');
  return stored ? JSON.parse(stored) : DEFAULT_WORKFLOW_TOOLS;
}
