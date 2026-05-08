/**
 * SandboxStateManager - Owns the in-memory state maps for running agents and pending plans.
 *
 * Centralizes:
 * - runningAgents map (Docker/K8s/Nomad container exec path)
 * - runningAgentCoreAgents map (AgentCore invoke + SSE path)
 * - pendingPlans map (plans awaiting user approval)
 * - startingAgents set (prevents concurrent startAgent races)
 */

import { createLogger } from '../../lib/logging/logger.js';
import type { PlanData, RunningAgent, RunningAgentCoreAgent } from './types.js';
import { PENDING_PLAN_TTL_MS, PLAN_CLEANUP_INTERVAL_MS } from './types.js';

const log = createLogger('SandboxStateManager');

export class SandboxStateManager {
  private static readonly instances = new Set<SandboxStateManager>();

  /** Map of taskId -> running agent (Docker/K8s/Nomad) */
  private runningAgents = new Map<string, RunningAgent>();

  /** Map of taskId -> running AgentCore agent */
  private runningAgentCoreAgents = new Map<string, RunningAgentCoreAgent>();

  /** Map of taskId -> pending plan data (awaiting approval) */
  private pendingPlans = new Map<string, PlanData>();

  /** Set of taskIds currently being started (prevents concurrent startAgent races) */
  private startingAgents = new Set<string>();

  /** Interval for cleaning up expired pending plans */
  private planCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    SandboxStateManager.instances.add(this);
    this.planCleanupInterval = setInterval(() => {
      this.cleanupExpiredPlans();
    }, PLAN_CLEANUP_INTERVAL_MS);
  }

  static disposeAll(): void {
    for (const instance of SandboxStateManager.instances) {
      instance.dispose();
    }
    SandboxStateManager.instances.clear();
  }

  // ---------------------------------------------------------------------------
  // Running agents (container exec path)
  // ---------------------------------------------------------------------------

  getRunningAgent(taskId: string): RunningAgent | undefined {
    return this.runningAgents.get(taskId);
  }

  setRunningAgent(taskId: string, agent: RunningAgent): void {
    if (this.runningAgents.has(taskId)) {
      log.warn('Overwriting existing running agent entry', { data: { taskId } });
    }
    this.runningAgents.set(taskId, agent);
  }

  deleteRunningAgent(taskId: string): boolean {
    return this.runningAgents.delete(taskId);
  }

  hasRunningAgent(taskId: string): boolean {
    return this.runningAgents.has(taskId);
  }

  get runningAgentCount(): number {
    return this.runningAgents.size;
  }

  getAllRunningAgents(): RunningAgent[] {
    return Array.from(this.runningAgents.values());
  }

  getRunningAgentKeys(): string[] {
    return Array.from(this.runningAgents.keys());
  }

  // ---------------------------------------------------------------------------
  // Running agents (AgentCore path)
  // ---------------------------------------------------------------------------

  getRunningAgentCoreAgent(taskId: string): RunningAgentCoreAgent | undefined {
    return this.runningAgentCoreAgents.get(taskId);
  }

  setRunningAgentCoreAgent(taskId: string, agent: RunningAgentCoreAgent): void {
    if (this.runningAgentCoreAgents.has(taskId)) {
      log.warn('Overwriting existing running AgentCore agent entry', { data: { taskId } });
    }
    this.runningAgentCoreAgents.set(taskId, agent);
  }

  deleteRunningAgentCoreAgent(taskId: string): boolean {
    return this.runningAgentCoreAgents.delete(taskId);
  }

  hasRunningAgentCoreAgent(taskId: string): boolean {
    return this.runningAgentCoreAgents.has(taskId);
  }

  get runningAgentCoreAgentCount(): number {
    return this.runningAgentCoreAgents.size;
  }

  getAllRunningAgentCoreAgents(): RunningAgentCoreAgent[] {
    return Array.from(this.runningAgentCoreAgents.values());
  }

  // ---------------------------------------------------------------------------
  // Combined helpers (both maps)
  // ---------------------------------------------------------------------------

  /** Check if a task has any running agent (container or AgentCore) */
  hasAnyRunningAgent(taskId: string): boolean {
    return this.runningAgents.has(taskId) || this.runningAgentCoreAgents.has(taskId);
  }

  /** Get running agent info from either map */
  getAnyRunningAgent(
    taskId: string
  ): { codespaceId: string; sessionId: string; startedAt: Date } | null {
    const agent = this.runningAgents.get(taskId) ?? this.runningAgentCoreAgents.get(taskId);
    if (!agent) return null;
    return {
      codespaceId: agent.codespaceId,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
    };
  }

  /** Total count of all running agents across both maps */
  get totalRunningAgentCount(): number {
    return this.runningAgents.size + this.runningAgentCoreAgents.size;
  }

  // ---------------------------------------------------------------------------
  // Pending plans
  // ---------------------------------------------------------------------------

  getPendingPlan(taskId: string): PlanData | undefined {
    return this.pendingPlans.get(taskId);
  }

  setPendingPlan(taskId: string, plan: PlanData): void {
    this.pendingPlans.set(taskId, plan);
  }

  deletePendingPlan(taskId: string): boolean {
    return this.pendingPlans.delete(taskId);
  }

  hasPendingPlan(taskId: string): boolean {
    return this.pendingPlans.has(taskId);
  }

  get pendingPlanCount(): number {
    return this.pendingPlans.size;
  }

  // ---------------------------------------------------------------------------
  // Starting agents guard set
  // ---------------------------------------------------------------------------

  isStarting(taskId: string): boolean {
    return this.startingAgents.has(taskId);
  }

  markStarting(taskId: string): void {
    this.startingAgents.add(taskId);
  }

  clearStarting(taskId: string): void {
    this.startingAgents.delete(taskId);
  }

  // ---------------------------------------------------------------------------
  // Plan cleanup
  // ---------------------------------------------------------------------------

  private cleanupExpiredPlans(): void {
    const now = Date.now();
    const expiredTaskIds: string[] = [];

    for (const [taskId, plan] of this.pendingPlans) {
      const age = now - plan.createdAt.getTime();
      if (age > PENDING_PLAN_TTL_MS) {
        expiredTaskIds.push(taskId);
      }
    }

    for (const taskId of expiredTaskIds) {
      log.info('Removing expired pending plan', {
        data: { taskId, ageMinutes: Math.round(PENDING_PLAN_TTL_MS / 60000) },
      });
      this.pendingPlans.delete(taskId);
    }
  }

  /** Stop the plan cleanup interval (for testing or shutdown). */
  dispose(): void {
    if (this.planCleanupInterval) {
      clearInterval(this.planCleanupInterval);
      this.planCleanupInterval = null;
    }
    SandboxStateManager.instances.delete(this);
  }
}
