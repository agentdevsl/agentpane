import { createLogger } from '../logging/logger.js';

const log = createLogger('StateMachine');

export type TransitionTelemetry = {
  machine: string;
  entityId: string;
  from: string;
  to: string;
  event: string;
  success: boolean;
  timestamp: string;
  durationInStateMs?: number;
  guardFailure?: string;
};

type AnyMachine = {
  state: string;
  context: Record<string, unknown>;
  send: (event: { type: string; [key: string]: unknown }) => {
    ok: boolean;
    state: string;
    error?: { code: string };
  };
};

export type InstrumentOptions = {
  machineName: string;
  entityId: string;
  onTransition?: (telemetry: TransitionTelemetry) => void;
};

export function instrumentMachine<M extends AnyMachine>(machine: M, options: InstrumentOptions): M {
  const { machineName, entityId, onTransition } = options;
  let lastTransitionTime = Date.now();

  const originalSend = machine.send.bind(machine);

  machine.send = ((event: { type: string }) => {
    const from = machine.state;
    const now = Date.now();
    const durationInStateMs = now - lastTransitionTime;

    const result = originalSend(event);

    const to = machine.state;
    const success = result.ok;

    const telemetry: TransitionTelemetry = {
      machine: machineName,
      entityId,
      from,
      to,
      event: event.type,
      success,
      timestamp: new Date(now).toISOString(),
      durationInStateMs,
      guardFailure: !success && result.error ? result.error.code : undefined,
    };

    if (success && from !== to) {
      lastTransitionTime = now;
      log.info(`State transition: ${machineName} ${from} -> ${to}`, { data: telemetry });
    } else if (!success) {
      log.warn(`Rejected transition: ${machineName} ${from} -x- ${event.type}`, {
        data: telemetry,
      });
    }

    onTransition?.(telemetry);

    return result;
  }) as M['send'];

  return machine;
}
