import { getRequestId } from '../context/request-context.js';
import { createLogger } from '../logging/logger.js';
import { captureException } from '../telemetry/error-sink.js';

const log = createLogger('Invariant');

export class InvariantViolation extends Error {
  readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'InvariantViolation';
    this.context = context;
  }
}

/**
 * Assert an invariant condition. In development/test, throws InvariantViolation.
 * In production, logs a structured error and continues.
 */
export function invariant(
  condition: unknown,
  message: string,
  context?: Record<string, unknown>
): asserts condition {
  if (condition) return;

  const isProduction = process.env.NODE_ENV === 'production';
  const violation = new InvariantViolation(message, context);

  // F10-04: every invariant failure — in either environment — flows through
  // the error sink so a future Sentry adapter aggregates them.
  captureException(violation, {
    source: 'invariant',
    requestId: getRequestId(),
    severity: isProduction ? 'warning' : 'error',
    ...context,
  });

  if (isProduction) {
    log.error(`Invariant violation: ${message}`, { data: context });
    return;
  }

  throw violation;
}

/**
 * Strict invariant that throws in ALL environments, including production.
 * Use for truly critical assertions where continuing would cause data corruption,
 * security violations, or other unrecoverable issues (e.g., auth checks, payment calculations).
 */
export function strictInvariant(
  condition: unknown,
  message: string,
  context?: Record<string, unknown>
): asserts condition {
  if (condition) return;
  log.error(`Critical invariant violation: ${message}`, { data: context });
  const violation = new InvariantViolation(message, context);
  captureException(violation, {
    source: 'strictInvariant',
    requestId: getRequestId(),
    severity: 'error',
    ...context,
  });
  throw violation;
}

/**
 * Soft invariant check. Never throws. Logs violation and returns false.
 * Use for non-critical assertions where the code has its own error handling.
 */
export function softInvariant(
  condition: unknown,
  message: string,
  context?: Record<string, unknown>
): condition is true {
  if (condition) return true;

  log.warn(`Soft invariant violation: ${message}`, { data: context });
  return false;
}
