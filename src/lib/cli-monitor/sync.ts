/**
 * CLI Monitor SSE Sync
 *
 * Manages the EventSource connection to the CLI monitor stream endpoint
 * and routes events into the TanStack DB collection.
 */

import { bulkSyncSessions, removeCliSession, upsertCliSession } from './collections.js';
import type { CliSession } from './schema.js';

type PageState = 'install' | 'waiting' | 'active';

export type CliMonitorSyncCallbacks = {
  onDaemonConnected?: () => void;
  onDaemonDisconnected?: () => void;
  onSessionUpdate?: (session: CliSession, previousStatus?: string) => void;
  onSessionNew?: (session: CliSession) => void;
  onSessionRemoved?: (sessionId: string) => void;
  onConnectionOpen?: () => void;
  onConnectionError?: () => void;
  onPageStateChange?: (state: PageState) => void;
};

/**
 * Start SSE sync for CLI monitor sessions.
 * Returns a cleanup function to close the connection.
 */
export function startCliMonitorSync(
  streamUrl: string,
  callbacks: CliMonitorSyncCallbacks
): () => void {
  let reconnectCount = 0;
  const source = new EventSource(streamUrl);

  source.onopen = () => {
    reconnectCount = 0;
    callbacks.onConnectionOpen?.();
  };

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'cli-monitor:snapshot': {
          const sessions: CliSession[] = data.sessions || [];
          bulkSyncSessions(sessions);

          if (sessions.length > 0) {
            // Show active view when sessions exist (live or historical from DB)
            callbacks.onPageStateChange?.('active');
          } else if (data.connected) {
            // Daemon connected but no sessions yet
            callbacks.onPageStateChange?.('waiting');
          } else {
            // No daemon, no sessions — show install prompt
            callbacks.onPageStateChange?.('install');
          }

          if (data.connected) {
            callbacks.onDaemonConnected?.();
          }
          break;
        }

        case 'cli-monitor:daemon-connected':
          callbacks.onDaemonConnected?.();
          break;

        case 'cli-monitor:daemon-disconnected':
          // Don't clear sessions — historical DB data should remain visible
          callbacks.onDaemonDisconnected?.();
          break;

        case 'cli-monitor:session-update': {
          const session = data.session as CliSession;
          const previousStatus = data.previousStatus as string | undefined;

          upsertCliSession(session);
          callbacks.onPageStateChange?.('active');

          if (previousStatus) {
            callbacks.onSessionUpdate?.(session, previousStatus);
          } else {
            callbacks.onSessionNew?.(session);
          }
          break;
        }

        case 'cli-monitor:session-removed': {
          const sessionId = data.sessionId as string;
          removeCliSession(sessionId);
          callbacks.onSessionRemoved?.(sessionId);
          break;
        }
      }
    } catch {
      // Invalid JSON — ignore
    }
  };

  source.onerror = () => {
    reconnectCount++;
    // RS-012: Close EventSource when max retries (5) exceeded to prevent
    // the browser from continuing to retry indefinitely and exhausting
    // the HTTP/1.1 connection limit.
    if (reconnectCount >= 5) {
      source.close();
      callbacks.onConnectionError?.();
    }
  };

  return () => {
    source.close();
  };
}
