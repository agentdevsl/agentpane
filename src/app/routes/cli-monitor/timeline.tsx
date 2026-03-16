import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useCliMonitor } from '@/app/components/features/cli-monitor/cli-monitor-context';
import { SummaryStrip } from '@/app/components/features/cli-monitor/summary-strip';
import { TimelineDetailPanel } from '@/app/components/features/cli-monitor/timeline-detail-panel';
import { TimelineSwimlane } from '@/app/components/features/cli-monitor/timeline-swimlane';
import type { TimeRange } from '@/app/components/features/cli-monitor/timeline-time-axis';

export const Route = createFileRoute('/cli-monitor/timeline')({
  component: TimelineView,
});

const TIME_RANGES: TimeRange[] = ['1h', '3h', '12h', '24h'];

function TimelineView(): React.JSX.Element {
  const { sessions, pageState } = useCliMonitor();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('3h');

  const selectedSession = sessions.find((s) => s.sessionId === selectedSessionId);

  // Close detail panel if session disappears
  useEffect(() => {
    if (selectedSessionId && !sessions.some((s) => s.sessionId === selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }, [selectedSessionId, sessions]);

  // Escape to close - handled via onKeyDown on container
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && selectedSessionId) {
        setSelectedSessionId(null);
      }
    },
    [selectedSessionId]
  );

  if (pageState !== 'active') {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
        {pageState === 'install'
          ? 'Start the CLI monitor daemon to use timeline view'
          : 'Waiting for sessions...'}
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 flex-col overflow-hidden"
      role="application"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Time range selector + summary */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-default shrink-0">
        <div className="flex items-center gap-0.5 rounded border border-border bg-subtle overflow-hidden">
          {TIME_RANGES.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1 text-xs font-medium border-r border-border last:border-r-0 transition-colors ${
                timeRange === range
                  ? 'bg-accent/15 text-accent font-semibold'
                  : 'text-fg-muted hover:text-fg hover:bg-muted'
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      <SummaryStrip sessions={sessions} />

      {/* Swimlane timeline */}
      <TimelineSwimlane
        sessions={sessions}
        timeRange={timeRange}
        selectedSessionId={selectedSessionId}
        onSelectSession={setSelectedSessionId}
      />

      {/* Detail panel */}
      {selectedSession ? (
        <TimelineDetailPanel session={selectedSession} onClose={() => setSelectedSessionId(null)} />
      ) : null}
    </div>
  );
}
