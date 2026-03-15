import type { TopologyAgentRole } from './types.js';

/**
 * Map an SDK agent_type or task description to a TopologyAgentRole.
 * Uses the subagent name/description from the SDK to determine the visual role.
 */
export function mapAgentRole(agentType?: string, description?: string): TopologyAgentRole {
  const text = `${agentType ?? ''} ${description ?? ''}`.toLowerCase();

  if (text.includes('deploy')) return 'deployer';
  if (text.includes('plan')) return 'planner';
  if (text.includes('review') || text.includes('code-review')) return 'reviewer';
  if (text.includes('test') || text.includes('pr-test')) return 'tester';
  if (text.includes('scan') || text.includes('security') || text.includes('silent-failure'))
    return 'scanner';
  if (
    text.includes('orchestrat') ||
    text.includes('lead') ||
    text.includes('team') ||
    text.includes('coordinator')
  )
    return 'orchestrator';

  // Default: anything doing implementation work
  return 'coder';
}

/**
 * Derive a display name from the SDK task description or agent_type.
 * Prefers description as it's more specific (e.g. "Review authentication module").
 */
export function deriveAgentName(agentType?: string, description?: string): string {
  if (description) {
    // Truncate long descriptions to a reasonable label
    return description.length > 40 ? `${description.slice(0, 37)}...` : description;
  }
  if (agentType) {
    // Convert kebab-case to title case: "code-reviewer" → "Code Reviewer"
    return agentType
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return 'Agent';
}
