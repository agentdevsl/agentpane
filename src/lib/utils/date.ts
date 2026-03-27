/**
 * Date utility functions for SQLite date handling.
 */

/**
 * Convert a Date to an ISO string for SQLite storage.
 * Returns null for null/undefined input.
 */
export function toSqliteDate(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) return null;
  return date.toISOString();
}

/**
 * Get the current time as an ISO string for SQLite storage.
 */
export function nowSqlite(): string {
  return new Date().toISOString();
}

/**
 * Parse a SQLite date string into a Date object.
 * Returns null for null/undefined input.
 */
export function fromSqliteDate(dateStr: string | null | undefined): Date | null {
  if (dateStr === null || dateStr === undefined) return null;
  return new Date(dateStr);
}
