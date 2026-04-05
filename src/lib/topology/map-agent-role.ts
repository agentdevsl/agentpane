/**
 * Map SDK task_type to a visual role category (icon/color only).
 * The actual agent type is stored separately as `agentType` on the node.
 */
export function mapAgentRole(agentType?: string): string {
  if (!agentType) return 'agent';
  const t = agentType.toLowerCase();
  // Use suffix after last separator to avoid false matches in toolkit prefixes
  // (e.g., "pr-review-toolkit:pr-test-analyzer" should be tester, not reviewer)
  const sep = t.lastIndexOf(':');
  const m = sep >= 0 ? t.slice(sep + 1) : t.includes('.') ? t.slice(t.lastIndexOf('.') + 1) : t;
  if (m.includes('plan')) return 'planner';
  if (m.includes('test') || m.includes('verif')) return 'tester';
  if (m.includes('scan') || m.includes('security') || m.includes('hunter')) return 'scanner';
  if (m.includes('review') || m.includes('analyz')) return 'reviewer';
  if (m.includes('deploy')) return 'deployer';
  return 'agent';
}

/**
 * Use the SDK description as the node name. Falls back to agentType, then "Agent".
 */
export function deriveAgentName(agentType?: string, description?: string): string {
  if (description) {
    return description.length > 50 ? `${description.slice(0, 47)}...` : description;
  }
  return agentType || 'Agent';
}
