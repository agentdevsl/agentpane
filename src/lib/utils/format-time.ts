/**
 * Shared relative time formatting utility.
 *
 * Consolidates the duplicate formatRelativeTime implementations that were
 * scattered across project-card, task-activity, task-metadata, etc.
 */

/**
 * Format a date/timestamp as a human-readable relative time string.
 *
 * Accepts Date objects, ISO date strings, or numeric timestamps (ms since epoch).
 * Returns '-' for null/undefined inputs.
 *
 * Examples: "just now", "5m ago", "3h ago", "2d ago", "Jan 12"
 */
export function formatRelativeTime(date: Date | string | number | null | undefined): string {
  if (date == null) return '-';

  const d =
    typeof date === 'number' ? new Date(date) : typeof date === 'string' ? new Date(date) : date;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
