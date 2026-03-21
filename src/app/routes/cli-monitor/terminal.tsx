import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCliMonitor } from '@/app/components/features/cli-monitor/cli-monitor-context';
import { SessionPicker } from '@/app/components/features/cli-monitor/session-picker';
import { TerminalGrid } from '@/app/components/features/cli-monitor/terminal-grid';
import { TerminalStatusBar } from '@/app/components/features/cli-monitor/terminal-status-bar';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';

export const Route = createFileRoute('/cli-monitor/terminal')({
  component: TerminalView,
});

function TerminalView(): React.JSX.Element {
  const { sessions, pageState } = useCliMonitor();
  const [paneAssignments, setPaneAssignments] = useState<Map<number, string>>(new Map());
  const [showPicker] = useState(true);

  // Non-subagent sessions
  const activeSessions = useMemo(() => sessions.filter((s) => !s.isSubagent), [sessions]);

  // Track previous session IDs to avoid unnecessary pane re-assignments
  const prevActiveIdsRef = useRef<string>('');
  const activeIdsKey = useMemo(
    () =>
      activeSessions
        .map((s) => s.sessionId)
        .sort()
        .join(','),
    [activeSessions]
  );

  // Auto-assign first 4 sessions on mount or when session IDs actually change
  useWatchEffect(() => {
    if (activeIdsKey === prevActiveIdsRef.current) return;
    prevActiveIdsRef.current = activeIdsKey;

    setPaneAssignments((prev) => {
      // Keep existing valid assignments
      const next = new Map<number, string>();
      const activeIds = new Set(activeSessions.map((s) => s.sessionId));

      for (const [pane, sid] of prev) {
        if (activeIds.has(sid)) {
          next.set(pane, sid);
        }
      }

      // Fill empty panes with unassigned sessions
      const assignedIds = new Set(next.values());
      const unassigned = activeSessions.filter((s) => !assignedIds.has(s.sessionId));
      let unassignedIdx = 0;

      for (let pane = 0; pane < 4; pane++) {
        if (!next.has(pane) && unassignedIdx < unassigned.length) {
          const session = unassigned[unassignedIdx];
          if (session) {
            next.set(pane, session.sessionId);
          }
          unassignedIdx++;
        }
      }

      return next;
    });
  }, [activeSessions, activeIdsKey]);

  const handleAssign = useCallback((sessionId: string) => {
    setPaneAssignments((prev) => {
      const next = new Map(prev);

      // If already assigned, remove it
      for (const [pane, sid] of next) {
        if (sid === sessionId) {
          next.delete(pane);
          return next;
        }
      }

      // Assign to first empty pane
      for (let pane = 0; pane < 4; pane++) {
        if (!next.has(pane)) {
          next.set(pane, sessionId);
          return next;
        }
      }

      return next;
    });
  }, []);

  if (pageState !== 'active') {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        {pageState === 'install'
          ? 'Start the CLI monitor daemon to use terminal view'
          : 'Waiting for sessions...'}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TerminalGrid paneAssignments={paneAssignments} sessions={sessions} />
      <TerminalStatusBar sessions={sessions} />
      {showPicker ? (
        <SessionPicker
          sessions={sessions}
          paneAssignments={paneAssignments}
          onAssign={handleAssign}
        />
      ) : null}
    </div>
  );
}
