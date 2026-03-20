/**
 * Container Agent sub-service barrel export.
 *
 * Re-exports the facade class and public types so all existing imports
 * from `'../services/container-agent.service'` continue to work
 * via the backward-compatible re-export in the original file.
 */

export { ContainerAgentService, createContainerAgentService } from './container-agent.service.js';
export type { AgentConfig, AgentPhase, PlanData, StartAgentInput } from './types.js';
