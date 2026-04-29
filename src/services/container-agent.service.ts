/**
 * Backward-compatible re-export.
 *
 * The monolithic ContainerAgentService has been decomposed into focused
 * sub-services under src/services/container-agent/. This file re-exports
 * the facade so all existing imports continue to work unchanged.
 *
 * @see ./container-agent/container-agent.service.ts  (facade)
 * @see ./container-agent/types.ts                    (shared types)
 * @see ./container-agent/sandbox-state.ts            (state management)
 * @see ./container-agent/worktree-init.service.ts    (worktree operations)
 * @see ./container-agent/container-exec.service.ts   (container lifecycle)
 * @see ./container-agent/agentcore-bridge.service.ts (AgentCore SSE bridge)
 * @see ./container-agent/plan-approval.service.ts    (plan approve/reject)
 */

export type {
  AgentConfig,
  AgentPhase,
  PlanData,
  StartAgentInput,
} from './container-agent/index.js';
export {
  ContainerAgentService,
  createContainerAgentService,
} from './container-agent/index.js';
