import type { AppError } from '../../errors/base.js';
import { createError } from '../../errors/base.js';
import type { Result } from '../../utils/result.js';
import { err, ok } from '../../utils/result.js';
import { clearTask, incrementTurn, setError } from './actions.js';
import { canPause, canResume, canStart, isToolAllowed, withinTurnLimit } from './guards.js';
import type { AgentLifecycleContext, AgentLifecycleEvent, AgentLifecycleState } from './types.js';

// NOTE: The `starting` state exists in AgentLifecycleState and the DB enum but is not
// modeled in transition() below — the machine transitions idle → running directly.
// The service layer (agent-execution.service.ts) sets `starting` via direct DB writes
// during the agent start sequence. This is a known modeling gap: the machine is used as
// advisory validation, not as the authoritative state manager. Future work should wire
// the machine as authoritative and add an idle → starting transition.

export type AgentMachine = {
  state: AgentLifecycleState;
  context: AgentLifecycleContext;
  send: (event: AgentLifecycleEvent) => AgentMachineResult;
};

export type AgentMachineResult = Result<AgentMachine, AppError> & {
  state: AgentLifecycleState;
  send: (event: AgentLifecycleEvent) => AgentMachineResult;
};

type AgentMachineInternal = AgentMachine & { lastResult: Result<AgentMachine, AppError> };

const nextState = <S extends AgentLifecycleState>(
  machine: AgentMachineInternal,
  state: S,
  context: AgentLifecycleContext
): AgentMachineInternal => ({
  ...machine,
  state,
  context,
  lastResult: ok({ state, context, send: machine.send }),
});

const nextError = (machine: AgentMachineInternal, error: AppError): AgentMachineInternal => ({
  ...machine,
  lastResult: err(error),
});

const createMachineResult = (
  machine: AgentMachine,
  result: Result<AgentMachine, AppError>
): AgentMachineResult => ({
  ...result,
  state: machine.state,
  send: machine.send,
});

export const createAgentLifecycleMachine = (
  initial?: Partial<AgentLifecycleContext>
): AgentMachine => {
  const context: AgentLifecycleContext = {
    status: 'idle',
    currentTurn: 0,
    maxTurns: 50,
    allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
    ...initial,
  };

  const machine: AgentMachineInternal = {
    state: context.status,
    context,
    send: null as unknown as AgentMachine['send'],
    lastResult: null as unknown as Result<AgentMachine, AppError>,
  };

  machine.send = (event) => {
    const next = transition(machine, event);
    update(next);
    return createMachineResult(next, next.lastResult);
  };

  machine.lastResult = ok({
    state: context.status,
    context,
    send: machine.send,
  });

  const update = (next: AgentMachineInternal) => {
    machine.state = next.state;
    machine.context = next.context;
    machine.lastResult = next.lastResult;
  };

  return machine;
};

const transition = (
  machine: AgentMachineInternal,
  event: AgentLifecycleEvent
): AgentMachineInternal => {
  const ctx = machine.context;

  if (!isToolAllowed(ctx, event)) {
    return nextError(machine, createError('AGENT_TOOL_NOT_ALLOWED', 'Tool not allowed', 403));
  }

  switch (machine.state) {
    case 'idle': {
      if (event.type === 'START' && canStart({ ...ctx, taskId: event.taskId })) {
        return nextState(machine, 'running', { ...ctx, status: 'running', taskId: event.taskId });
      }
      break;
    }
    case 'running': {
      if (event.type === 'STEP') {
        const nextContext = incrementTurn(ctx);
        if (!withinTurnLimit(nextContext)) {
          return nextError(
            { ...machine, context: nextContext },
            createError('AGENT_TURN_LIMIT_EXCEEDED', 'Turn limit exceeded', 200)
          );
        }
        return nextState(machine, 'running', nextContext);
      }
      if (event.type === 'PAUSE' && canPause(ctx)) {
        return nextState(machine, 'paused', { ...ctx, status: 'paused' });
      }
      if (event.type === 'COMPLETE') {
        return nextState(machine, 'completed', clearTask({ ...ctx, status: 'completed' }));
      }
      if (event.type === 'ERROR') {
        const errored = setError(ctx, event);
        return { ...machine, state: 'error', context: errored, lastResult: err(event.error) };
      }
      if (event.type === 'ABORT') {
        return nextState(machine, 'idle', clearTask({ ...ctx, status: 'idle' }));
      }
      break;
    }
    case 'paused': {
      if (event.type === 'RESUME' && canResume(ctx)) {
        return nextState(machine, 'running', { ...ctx, status: 'running' });
      }
      if (event.type === 'ABORT') {
        return nextState(machine, 'idle', clearTask({ ...ctx, status: 'idle' }));
      }
      break;
    }
    default:
      break;
  }

  return nextError(
    machine,
    createError('AGENT_INVALID_TRANSITION', 'Invalid agent transition', 400, {
      state: machine.state,
      event: event.type,
    })
  );
};
