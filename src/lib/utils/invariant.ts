import { createLogger } from '../logging/logger.js';

const log = createLogger('Invariant');

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
