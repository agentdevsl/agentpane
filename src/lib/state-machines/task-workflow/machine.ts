import type { AppError } from '../../errors/base.js';
import { createError } from '../../errors/base.js';
import type { Result } from '../../utils/result.js';
import { err, ok } from '../../utils/result.js';
import { canApprove, canAssign, canReject, hasDiff, withinConcurrencyLimit } from './guards.js';
import type { TaskWorkflowContext, TaskWorkflowEvent, TaskWorkflowState } from './types.js';

export type TaskMachine = {
  state: TaskWorkflowState;
  context: TaskWorkflowContext;
  send: (event: TaskWorkflowEvent) => TaskMachineResult;
};

export type TaskMachineResult = Result<TaskMachine, AppError> & {
  state: TaskWorkflowState;
  send: (event: TaskWorkflowEvent) => TaskMachineResult;
};

type TaskMachineInternal = TaskMachine & { lastResult: Result<TaskMachine, AppError> };

const nextState = <S extends TaskWorkflowState>(
  machine: TaskMachineInternal,
  state: S,
  context: TaskWorkflowContext
): TaskMachineInternal => ({
  ...machine,
  state,
  context,
  lastResult: ok({ state, context, send: machine.send }),
});

const nextError = (machine: TaskMachineInternal, error: AppError): TaskMachineInternal => ({
  ...machine,
  lastResult: err(error),
});

const createMachineResult = (
  machine: TaskMachine,
  result: Result<TaskMachine, AppError>
): TaskMachineResult => ({
  ...result,
  state: machine.state,
  send: machine.send,
});

export const createTaskWorkflowMachine = (
  initial: Partial<TaskWorkflowContext> & { taskId: string }
): TaskMachine => {
  const { taskId, ...rest } = initial;
  const context: TaskWorkflowContext = {
    taskId,
    column: 'backlog',
    runningAgents: 0,
    maxConcurrentAgents: 3,
    diffSummary: null,
    ...rest,
  };

  const machine: TaskMachineInternal = {
    state: context.column,
    context,
    send: null as unknown as TaskMachine['send'],
    lastResult: null as unknown as Result<TaskMachine, AppError>,
  };

  machine.send = (event) => {
    const next = transition(machine, event);
    update(next);
    return createMachineResult(next, next.lastResult);
  };

  machine.lastResult = ok({
    state: context.column,
    context,
    send: machine.send,
  });

  const update = (next: TaskMachineInternal) => {
    machine.state = next.state;
    machine.context = next.context;
    machine.lastResult = next.lastResult;
  };

  return machine;
};

const transition = (
  machine: TaskMachineInternal,
  event: TaskWorkflowEvent
): TaskMachineInternal => {
  const ctx = machine.context;

  switch (machine.state) {
    case 'backlog':
      if (event.type === 'QUEUE') {
        return nextState(machine, 'queued', { ...ctx, column: 'queued' });
      }
      if (event.type === 'ASSIGN') {
        if (!canAssign(ctx)) {
          return nextError(
            machine,
            createError('TASK_ALREADY_ASSIGNED', 'Task already assigned', 409)
          );
        }
        if (!withinConcurrencyLimit(ctx)) {
          return nextError(
            machine,
            createError('CONCURRENCY_LIMIT_EXCEEDED', 'Concurrency limit exceeded', 429)
          );
        }
        return nextState(machine, 'in_progress', {
          ...ctx,
          column: 'in_progress',
          agentId: event.agentId,
        });
      }
      break;
    case 'queued':
      if (event.type === 'ASSIGN') {
        if (!canAssign(ctx)) {
          return nextError(
            machine,
            createError('TASK_ALREADY_ASSIGNED', 'Task already assigned', 409)
          );
        }
        if (!withinConcurrencyLimit(ctx)) {
          return nextError(
            machine,
            createError('CONCURRENCY_LIMIT_EXCEEDED', 'Concurrency limit exceeded', 429)
          );
        }
        return nextState(machine, 'in_progress', {
          ...ctx,
          column: 'in_progress',
          agentId: event.agentId,
        });
      }
      if (event.type === 'DEQUEUE' || event.type === 'CANCEL') {
        return nextState(machine, 'backlog', { ...ctx, column: 'backlog' });
      }
      break;
    case 'in_progress':
      if (event.type === 'COMPLETE') {
        return nextState(machine, 'waiting_approval', { ...ctx, column: 'waiting_approval' });
      }
      if (event.type === 'CANCEL') {
        return nextState(machine, 'backlog', { ...ctx, column: 'backlog', agentId: undefined });
      }
      break;
    case 'waiting_approval':
      if (event.type === 'APPROVE') {
        if (!canApprove(ctx)) {
          return nextError(
            machine,
            createError('TASK_NOT_WAITING_APPROVAL', 'Not waiting approval', 400)
          );
        }
        if (!hasDiff(ctx)) {
          return nextError(machine, createError('TASK_NO_DIFF', 'No changes to approve', 400));
        }
        return nextState(machine, 'verified', { ...ctx, column: 'verified' });
      }
      if (event.type === 'REJECT') {
        if (!canReject(ctx)) {
          return nextError(
            machine,
            createError('TASK_NOT_WAITING_APPROVAL', 'Not waiting approval', 400)
          );
        }
        return nextState(machine, 'in_progress', { ...ctx, column: 'in_progress' });
      }
      if (event.type === 'CANCEL') {
        return nextState(machine, 'backlog', { ...ctx, column: 'backlog', agentId: undefined });
      }
      break;
    case 'verified':
      if (event.type === 'REOPEN') {
        return nextState(machine, 'backlog', { ...ctx, column: 'backlog', agentId: undefined });
      }
      break;
    default:
      break;
  }

  return nextError(
    machine,
    createError('TASK_INVALID_TRANSITION', 'Invalid task transition', 400, {
      state: machine.state,
      event: event.type,
    })
  );
};
