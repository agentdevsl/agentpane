import type { TaskWorkflowContext } from './types.js';

export const canAssign = (ctx: TaskWorkflowContext) =>
  (ctx.column === 'backlog' || ctx.column === 'queued') && !ctx.agentId;

export const withinConcurrencyLimit = (ctx: TaskWorkflowContext) =>
  ctx.runningAgents < ctx.maxConcurrentAgents;

export const hasDiff = (ctx: TaskWorkflowContext) =>
  !!ctx.diffSummary && ctx.diffSummary.filesChanged > 0;

export const canApprove = (ctx: TaskWorkflowContext) => ctx.column === 'waiting_approval';

export const canReject = (ctx: TaskWorkflowContext) => ctx.column === 'waiting_approval';
