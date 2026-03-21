/**
 * Derive a deterministic agent node ID for container-agent sessions.
 * Both the historical event fetch and SSE stream must use the same
 * derivation to avoid duplicate nodes in the topology.
 */
export function deriveContainerAgentNodeId(params: {
  agentId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
}): string {
  if (params.taskId) return `agent-${params.taskId}`;
  if (params.agentId) return params.agentId;
  return `agent-${params.sessionId ?? 'unknown'}`;
}
