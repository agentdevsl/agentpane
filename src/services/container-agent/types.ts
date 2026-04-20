/**
 * Shared types, interfaces, and constants for the container-agent sub-services.
 */

import type { StoredPlanOptions } from '../../db/schema';
import type { AgentCoreBridge } from '../../lib/agents/agentcore-bridge.js';
import type { ContainerBridge } from '../../lib/agents/container-bridge.js';
import type { AgentCoreSandboxInstance } from '../../lib/sandbox/providers/agentcore-sandbox-instance.js';
import type { ExecStreamResult } from '../../lib/sandbox/providers/sandbox-provider.js';

/**
 * Agent execution phase.
 */
export type AgentPhase = 'plan' | 'execute';

/**
 * Input for starting a container agent.
 */
export interface StartAgentInput {
  codespaceId: string;
  taskId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  /** Execution phase: 'plan' for planning, 'execute' for execution (default: 'plan') */
  phase?: AgentPhase;
  /** SDK session ID to resume (for execution after plan approval) */
  sdkSessionId?: string;
}

/**
 * Configuration for an agent run.
 */
export interface AgentConfig {
  model: string;
  maxTurns: number;
  allowedTools?: string[];
}

/**
 * Running agent instance (Docker/K8s/Nomad -- container exec path).
 */
export interface RunningAgent {
  taskId: string;
  sessionId: string;
  codespaceId: string;
  sandboxId: string;
  bridge: ContainerBridge;
  execResult: ExecStreamResult;
  stopFilePath: string;
  startedAt: Date;
  stopRequested: boolean;
  phase: AgentPhase;
  worktreeId?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** Guard flag: set to true once handleAgentComplete/handleAgentError begins processing.
   *  Prevents the processAgentOutput exit-code path from racing against the bridge callback. */
  completionHandled?: boolean;
}

/**
 * Running agent instance for AgentCore (invoke + SSE path -- no container exec).
 */
export interface RunningAgentCoreAgent {
  taskId: string;
  sessionId: string;
  codespaceId: string;
  sandboxId: string;
  bridge: AgentCoreBridge;
  instance: AgentCoreSandboxInstance;
  runtimeSessionId: string;
  startedAt: Date;
  stopRequested: boolean;
  phase: AgentPhase;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * Plan data stored after planning phase completes.
 */
export interface PlanData {
  taskId: string;
  sessionId: string;
  codespaceId: string;
  plan: string;
  turnCount: number;
  sdkSessionId: string;
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  createdAt: Date;
  /** Sandbox ID at the time planning completed -- used to detect container changes before execution */
  sandboxId?: string;
  launchSwarm?: boolean;
  teammateCount?: number;
}

/**
 * Shape of task row fields used by plan-related queries.
 * Avoids duplicating inline type casts across methods.
 */
export interface TaskPlanRow {
  id: string;
  codespaceId: string;
  sessionId: string | null;
  plan: string | null;
  planOptions: StoredPlanOptions | null;
  lastAgentStatus: string | null;
}

/**
 * Dependencies shared across sub-services, injected by the facade.
 */
export interface ContainerAgentDeps {
  db: import('../../types/database.js').Database;
  provider: import('../../lib/sandbox/providers/sandbox-provider.js').SandboxProvider;
  streams: import('./../../services/durable-streams.service.js').DurableStreamsService;
  apiKeyService: import('./../../services/api-key.service.js').ApiKeyService;
  worktreeService?: import('./../../services/worktree.service.js').WorktreeService;
  githubTokenService?: import('./../../services/github-token.service.js').GitHubTokenService;
  skillTrackingService?: import('../memory/skill-tracking.service.js').SkillTrackingService | null;
}

/**
 * Enriched completion metrics from the agent-runner.
 * Shared between container-bridge (production) and shared-helpers (consumption).
 */
export interface AgentCompleteMetrics {
  skillId?: string;
  skillName?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  fileChanges?: { filesModified: number; linesAdded: number; linesRemoved: number };
}

/**
 * Result of an automated agent review of a plan.
 * Stored on the task record for UI display and audit trail.
 */
export interface AgentReviewResult {
  verdict: 'approve' | 'flag_for_review';
  reasoning: string;
  concerns?: string[];
  confidence: number;
  model: string;
  durationMs: number;
  reviewedAt: string;
}

/** TTL for pending plans in milliseconds (1 hour) */
export const PENDING_PLAN_TTL_MS = 60 * 60 * 1000;

/** Cleanup interval for expired plans (every 5 minutes) */
export const PLAN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
