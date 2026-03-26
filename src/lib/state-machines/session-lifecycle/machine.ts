import type { AppError } from '../../errors/base.js';
import { createError } from '../../errors/base.js';
import type { Result } from '../../utils/result.js';
import { err, ok } from '../../utils/result.js';
import { canClose, hasCapacity, isParticipant, isStale } from './guards.js';
import type {
  SessionLifecycleContext,
  SessionLifecycleEvent,
  SessionLifecycleState,
} from './types.js';

export type SessionMachine = {
  state: SessionLifecycleState;
  context: SessionLifecycleContext;
  send: (event: SessionLifecycleEvent) => SessionMachineResult;
};

export type SessionMachineResult = Result<SessionMachine, AppError> & {
  state: SessionLifecycleState;
  send: (event: SessionLifecycleEvent) => SessionMachineResult;
};

type SessionMachineInternal = SessionMachine & { lastResult: Result<SessionMachine, AppError> };

const nextState = <S extends SessionLifecycleState>(
  machine: SessionMachineInternal,
  state: S,
  context: SessionLifecycleContext
): SessionMachineInternal => ({
  ...machine,
  state,
  context,
  lastResult: ok({ state, context, send: machine.send }),
});

const nextError = (machine: SessionMachineInternal, error: AppError): SessionMachineInternal => ({
  ...machine,
  lastResult: err(error),
});

const createMachineResult = (
  machine: SessionMachine,
  result: Result<SessionMachine, AppError>
): SessionMachineResult => ({
  ...result,
  state: machine.state,
  send: machine.send,
});

export const createSessionLifecycleMachine = (
  initial?: Partial<SessionLifecycleContext>
): SessionMachine => {
  const context: SessionLifecycleContext = {
    status: 'idle',
    participants: [],
    maxParticipants: 4,
    lastActivity: Date.now(),
    ...initial,
  };

  const machine: SessionMachineInternal = {
    state: context.status,
    context,
    send: null as unknown as SessionMachine['send'],
    lastResult: null as unknown as Result<SessionMachine, AppError>,
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

  const update = (next: SessionMachineInternal) => {
    machine.state = next.state;
    machine.context = next.context;
    machine.lastResult = next.lastResult;
  };

  return machine;
};

const transition = (
  machine: SessionMachineInternal,
  event: SessionLifecycleEvent
): SessionMachineInternal => {
  const ctx = machine.context;

  switch (machine.state) {
    case 'idle':
      if (event.type === 'INITIALIZE') {
        return nextState(machine, 'initializing', { ...ctx, status: 'initializing' });
      }
      break;
    case 'initializing':
      if (event.type === 'READY') {
        return nextState(machine, 'active', { ...ctx, status: 'active' });
      }
      break;
    case 'active':
      if (event.type === 'JOIN') {
        if (!hasCapacity(ctx)) {
          return nextError(machine, createError('SESSION_CAPACITY_REACHED', 'Session full', 409));
        }
        const nextParticipants = ctx.participants.concat(event.userId);
        return nextState(machine, 'active', {
          ...ctx,
          participants: nextParticipants,
          lastActivity: Date.now(),
        });
      }
      if (event.type === 'LEAVE') {
        if (!isParticipant(ctx, event.userId)) {
          return nextError(
            machine,
            createError('SESSION_NOT_PARTICIPANT', 'User not in session', 400)
          );
        }
        const nextParticipants = ctx.participants.filter((id) => id !== event.userId);
        return nextState(machine, 'active', {
          ...ctx,
          participants: nextParticipants,
          lastActivity: Date.now(),
        });
      }
      if (event.type === 'HEARTBEAT') {
        return nextState(machine, 'active', { ...ctx, lastActivity: Date.now() });
      }
      if (event.type === 'PAUSE') {
        return nextState(machine, 'paused', { ...ctx, status: 'paused' });
      }
      if (event.type === 'TIMEOUT' && isStale(ctx)) {
        return nextState(machine, 'closing', { ...ctx, status: 'closing' });
      }
      if (event.type === 'CLOSE' && canClose(ctx)) {
        return nextState(machine, 'closing', { ...ctx, status: 'closing' });
      }
      break;
    case 'paused':
      if (event.type === 'RESUME') {
        return nextState(machine, 'active', { ...ctx, status: 'active' });
      }
      if (event.type === 'CLOSE' && canClose(ctx)) {
        return nextState(machine, 'closing', { ...ctx, status: 'closing' });
      }
      break;
    case 'closing':
      if (event.type === 'CLOSE') {
        return nextState(machine, 'closed', { ...ctx, status: 'closed' });
      }
      break;
    case 'error':
      if (event.type === 'CLOSE') {
        return nextState(machine, 'closed', { ...ctx, status: 'closed' });
      }
      break;
    default:
      break;
  }

  if (event.type === 'ERROR' && machine.state !== 'closed') {
    return {
      ...machine,
      state: 'error',
      context: { ...ctx, status: 'error', error: event.error },
      lastResult: err(event.error),
    };
  }

  return nextError(
    machine,
    createError('SESSION_INVALID_TRANSITION', 'Invalid session transition', 400, {
      state: machine.state,
      event: event.type,
    })
  );
};
