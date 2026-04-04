import type { TopologyAgentRole } from './types.js';

/**
 * Map SDK task_type to a visual role category (icon/color only).
 * The actual agent type is stored separately as `agentType` on the node.
 */
export function mapAgentRole(agentType?: string): TopologyAgentRole {
  if (!agentType) return 'coder';
  const t = agentType.toLowerCase();
  if (t.includes('plan')) return 'planner';
  if (t.includes('review') || t.includes('analyz')) return 'reviewer';
  if (t.includes('test') || t.includes('verif')) return 'tester';
  if (t.includes('scan') || t.includes('security') || t.includes('hunter')) return 'scanner';
  if (t.includes('deploy')) return 'deployer';
  return 'coder';
}

/**
 * Use the SDK description as the node name. Falls back to agentType, then "Agent".
 */
export function deriveAgentName(agentType?: string, description?: string): string {
  if (description) {
    return description.length > 50 ? `${description.slice(0, 47)}...` : description;
  }
  return agentType ?? 'Agent';
}
