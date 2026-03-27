import type { AgentHooks } from '../types.js';
import { createAuditHook } from './audit.js';
import { createStreamingHooks } from './streaming.js';
import { createToolWhitelistHook } from './tool-whitelist.js';

interface CreateAgentHooksOptions {
  agentId: string;
  sessionId: string;
  agentRunId: string;
  taskId: string;
  codespaceId: string;
  allowedTools: string[];
  db: { insert: (...args: unknown[]) => { values: (v: unknown) => Promise<unknown> } };
  sessionService: {
    publish: (sessionId: string, event: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * Creates the full set of agent hooks combining whitelist, streaming, and audit hooks.
 */
export function createAgentHooks(options: CreateAgentHooksOptions): AgentHooks {
  const { agentId, sessionId, agentRunId, taskId, codespaceId, allowedTools, db, sessionService } =
    options;

  const whitelistHook = createToolWhitelistHook(allowedTools);
  const streamingHooks = createStreamingHooks(agentId, sessionId, sessionService);
  const auditHook = createAuditHook(db, agentId, agentRunId, taskId, codespaceId);

  return {
    PreToolUse: [whitelistHook, streamingHooks.PreToolUse],
    PostToolUse: [auditHook, streamingHooks.PostToolUse],
  };
}
