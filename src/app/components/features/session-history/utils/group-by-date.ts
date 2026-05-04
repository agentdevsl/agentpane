import type { SessionDateGroup, SessionListItem } from '../types';

/**
 * Get date label for grouping (Today, Yesterday, or formatted date)
 */
function getDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();

  // Reset times to midnight for comparison
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (dateDay.getTime() === today.getTime()) {
    return 'Today';
  }

  if (dateDay.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  // Format as "Jan 14, 2026" or "Jan 14" if same year
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Get ISO date string (YYYY-MM-DD) for grouping
 */
function getDateKey(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toISOString().split('T')[0] ?? '';
}

/**
 * Group sessions by date
 * Returns groups sorted by date (most recent first)
 */
export function groupSessionsByDate(sessions: SessionListItem[]): SessionDateGroup[] {
  const groupMap = new Map<string, { label: string; sessions: SessionListItem[] }>();

  // A session row is created once per task and reused on every re-run, so
  // `createdAt` reflects when the task was first run, not the latest agent
  // activity. Group/label/sort by `lastActivityAt` (server-provided) when
  // available so the "Today" / "Yesterday" buckets reflect actual recent
  // work; fall back to `createdAt` for backwards compatibility.
  const recencyOf = (s: SessionListItem): string => s.lastActivityAt ?? s.createdAt;

  for (const session of sessions) {
    const recency = recencyOf(session);
    const dateKey = getDateKey(recency);
    const label = getDateLabel(recency);

    const existing = groupMap.get(dateKey);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groupMap.set(dateKey, { label, sessions: [session] });
    }
  }

  // Convert to array and sort by date (most recent first)
  const groups: SessionDateGroup[] = Array.from(groupMap.entries())
    .map(([date, { label, sessions: groupSessions }]) => ({
      date,
      label,
      // Sort sessions within group by recency (most recent first)
      sessions: groupSessions.sort(
        (a, b) => new Date(recencyOf(b)).getTime() - new Date(recencyOf(a)).getTime()
      ),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return groups;
}

/**
 * Calculate total duration from a list of sessions
 * Returns duration in milliseconds
 */
export function calculateTotalDuration(sessions: SessionListItem[]): number {
  return sessions.reduce((total, session) => {
    if (session.duration != null) {
      return total + session.duration;
    }
    // For sessions without duration, calculate from createdAt to closedAt
    if (session.closedAt) {
      const start = new Date(session.createdAt).getTime();
      const end = new Date(session.closedAt).getTime();
      return total + Math.max(0, end - start);
    }
    return total;
  }, 0);
}
