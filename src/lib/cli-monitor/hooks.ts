/**
 * CLI Monitor Hooks
 *
 * Reactive hooks for accessing CLI session data from TanStack DB collections.
 */

import { eq } from '@tanstack/db';
import { useCollectionQuery } from '../db/use-collection-query.js';
import { cliSessionsCollection } from './collections.js';
import type { CliSession } from './schema.js';

/**
 * Hook to get all CLI sessions with live updates
 */
export function useCliSessions(): CliSession[] {
  const { data } = useCollectionQuery<CliSession>((q) =>
    q.from({ sessions: cliSessionsCollection })
  );
  return data ?? [];
}

/**
 * Hook to get a single CLI session by ID with live updates
 */
export function useCliSession(sessionId: string): CliSession | null {
  const { data } = useCollectionQuery<CliSession>(
    (q) =>
      q
        .from({ sessions: cliSessionsCollection })
        .where(({ sessions }: { sessions: CliSession }) => eq(sessions.sessionId, sessionId)),
    [sessionId]
  );
  return data?.[0] ?? null;
}

/**
 * Hook to get only top-level (non-subagent) CLI sessions
 */
export function useActiveCliSessions(): CliSession[] {
  const { data } = useCollectionQuery<CliSession>((q) =>
    q
      .from({ sessions: cliSessionsCollection })
      .where(({ sessions }: { sessions: CliSession }) => eq(sessions.isSubagent, false))
  );
  return data ?? [];
}
