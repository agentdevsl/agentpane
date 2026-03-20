// Types

export type { CreateAgentHooksInput } from './hooks/index.js';
// Hooks
export {
  createAgentHooks,
  createAuditHook,
  createStreamingHooks,
  createToolWhitelistHook,
} from './hooks/index.js';
export type { AgentExecutionContext, RecoveryAction, RecoveryResult } from './recovery.js';
// Recovery
export { handleAgentError } from './recovery.js';
export type { AgentRunResult, StreamHandlerOptions } from './stream-handler.js';
// Stream Handler
export { runAgentExecution, runAgentPlanning } from './stream-handler.js';
export type {
  BashArgs,
  EditFileArgs,
  GlobArgs,
  GrepArgs,
  ReadFileArgs,
  ToolArgs,
  ToolDefinition,
  ToolName,
  WriteFileArgs,
} from './tools/index.js';
// Tools
export {
  bashTool,
  editFile,
  getAvailableTools,
  getToolHandler,
  globTool,
  grepTool,
  readFile,
  TOOL_REGISTRY,
  writeFile,
} from './tools/index.js';
export type {
  AgentHooks,
  AgentMessage,
  AgentQueryOptions,
  PostToolUseHook,
  PostToolUseInput,
  PreToolUseHook,
  PreToolUseInput,
  PreToolUseResult,
  ToolContext,
  ToolResponse,
} from './types.js';
export { agentMessageSchema } from './types.js';
