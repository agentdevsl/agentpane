/**
 * Standardized error message extraction utility.
 *
 * Replaces the duplicated `error instanceof Error ? error.message : String(error)`
 * pattern found across 150+ locations in the codebase.
 *
 * @see CQ-002 in specs/reviews/2026-03-architecture/FINDINGS-MATRIX.md
 */

/**
 * Extract a human-readable message from an unknown error value.
 *
 * @param error - The caught error (typically `unknown` from a catch block)
 * @returns A string error message
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  // Handle ErrorEvent and similar objects with a message property
  if (error != null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  const str = String(error);
  // Avoid unhelpful "[object Object]" or "[object ErrorEvent]"
  if (str.startsWith('[object ')) {
    return JSON.stringify(error) !== '{}' ? JSON.stringify(error) : str;
  }
  return str;
}
