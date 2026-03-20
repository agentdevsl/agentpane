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
  return String(error);
}
