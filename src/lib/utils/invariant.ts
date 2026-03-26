import { createLogger } from '../logging/logger.js';

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

  if (isProduction) {
    log.error(`Invariant violation: ${message}`, { data: context });
    return;
  }

  throw new InvariantViolation(message, context);
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
