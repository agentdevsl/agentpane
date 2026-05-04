import { getValidTransitions } from '../../services/task-transitions.js';
import { createError } from './base.js';

export const TaskErrors = {
  NOT_FOUND: createError('TASK_NOT_FOUND', 'Task not found', 404),
  NOT_IN_COLUMN: (expected: string, actual: string) =>
    createError('TASK_NOT_IN_COLUMN', `Task is in "${actual}" but expected "${expected}"`, 400, {
      expected,
      actual,
    }),
  ALREADY_ASSIGNED: (agentId: string) =>
    createError('TASK_ALREADY_ASSIGNED', 'Task is already assigned to an agent', 409, {
      agentId,
    }),
  NO_DIFF: createError('TASK_NO_DIFF', 'No changes to approve', 400),
  ALREADY_APPROVED: createError('TASK_ALREADY_APPROVED', 'Task has already been approved', 409),
  NOT_WAITING_APPROVAL: (currentColumn: string) =>
    createError(
      'TASK_NOT_WAITING_APPROVAL',
      `Task is not waiting for approval (current: ${currentColumn})`,
      400,
      { currentColumn }
    ),
  INVALID_TRANSITION: (from: string, to: string) =>
    createError('TASK_INVALID_TRANSITION', `Cannot move task from "${from}" to "${to}"`, 400, {
      from,
      to,
      allowedTransitions: getValidTransitions(from),
    }),
  POSITION_CONFLICT: createError(
    'TASK_POSITION_CONFLICT',
    'Position conflict in column. Please refresh and try again.',
    409
  ),
  AGENT_NOT_RUNNING: createError(
    'TASK_AGENT_NOT_RUNNING',
    'No agent is currently running for this task',
    400
  ),
  AGENT_STOP_FAILED: createError(
    'TASK_AGENT_STOP_FAILED',
    'Failed to stop agent for this task',
    500
  ),
  PLAN_NOT_EXECUTED: createError(
    'TASK_PLAN_NOT_EXECUTED',
    'Cannot approve changes while plan is pending approval. Approve or reject the plan first.',
    400
  ),
  NO_GITHUB_REPO: createError(
    'TASK_NO_GITHUB_REPO',
    'Codespace has no GitHub repository linked. Configure a repository in codespace settings before running agents in K8s or Nomad sandbox mode.',
    400
  ),
  EXECUTION_NOT_READY: createError(
    'TASK_EXECUTION_NOT_READY',
    'Agent execution is not ready yet. Wait for sandbox initialization and retry.',
    503
  ),
} as const;

export type TaskError =
  | typeof TaskErrors.NOT_FOUND
  | ReturnType<typeof TaskErrors.NOT_IN_COLUMN>
  | ReturnType<typeof TaskErrors.ALREADY_ASSIGNED>
  | typeof TaskErrors.NO_DIFF
  | typeof TaskErrors.ALREADY_APPROVED
  | ReturnType<typeof TaskErrors.NOT_WAITING_APPROVAL>
  | ReturnType<typeof TaskErrors.INVALID_TRANSITION>
  | typeof TaskErrors.POSITION_CONFLICT
  | typeof TaskErrors.AGENT_NOT_RUNNING
  | typeof TaskErrors.AGENT_STOP_FAILED
  | typeof TaskErrors.PLAN_NOT_EXECUTED
  | typeof TaskErrors.NO_GITHUB_REPO
  | typeof TaskErrors.EXECUTION_NOT_READY;
