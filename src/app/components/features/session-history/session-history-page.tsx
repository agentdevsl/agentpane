import { Calendar, Clock, Export, Funnel } from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { SESSION_STATUS } from '@/db/schema';
import { apiClient } from '@/lib/api/client';
import { SessionDetailView } from './components/session-detail-view';
import { SessionTimeline } from './components/session-timeline';
import { useSessionDetail, useSessions } from './hooks/use-session-events';
import { useSessionFilters } from './hooks/use-session-filters';
import type { ExportFormat, SessionHistoryPageProps } from './types';
import { formatDuration } from './utils/format-duration';
import { calculateTotalDuration, groupSessionsByDate } from './utils/group-by-date';

export function SessionHistoryPage({
  codespaceId,
  taskId: initialTaskId,
  initialFilters,
  compact: _compact = false,
}: SessionHistoryPageProps): React.JSX.Element {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Filter and sort state (synced with URL)
  const { filters, sort, setFilters, clearFilters, hasActiveFilters } = useSessionFilters();

  // Apply initial filters
  const effectiveFilters = useMemo(
    () => ({
      ...initialFilters,
      ...filters,
      taskId: initialTaskId ?? filters.taskId,
    }),
    [filters, initialFilters, initialTaskId]
  );

  // Fetch sessions list
  const {
    data: sessionsData,
    isLoading: sessionsLoading,
    error: _sessionsError,
    refetch: refetchSessions,
  } = useSessions(codespaceId, effectiveFilters, sort);

  // Fetch selected session detail
  const { data: sessionDetailData, isLoading: detailLoading } = useSessionDetail(selectedSessionId);

  // Group sessions by date
  const sessionGroups = useMemo(() => {
    if (!sessionsData?.sessions) return [];
    return groupSessionsByDate(sessionsData.sessions);
  }, [sessionsData?.sessions]);

  // Calculate total duration
  const totalDuration = useMemo(() => {
    if (!sessionsData?.sessions) return '0h';
    const totalMs = calculateTotalDuration(sessionsData.sessions);
    return formatDuration(totalMs);
  }, [sessionsData?.sessions]);

  // Handle session selection
  const handleSessionSelect = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
  }, []);

  // Handle export
  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!sessionDetailData?.session) return;

      const sessionId = sessionDetailData.session.id;

      try {
        const result = await apiClient.sessions.export(sessionId, format);

        if (result.ok && result.data) {
          const { content, contentType, filename } = result.data;
          const blob = new Blob([content], { type: contentType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          console.error('Export failed:', result.ok ? 'No data' : result.error?.message);
        }
      } catch (err) {
        console.error('Export error:', err);
      }
    },
    [sessionDetailData?.session]
  );

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!selectedSessionId) return;

    try {
      const result = await apiClient.sessions.delete(selectedSessionId);
      if (result.ok) {
        setSelectedSessionId(null);
        await refetchSessions();
      } else {
        console.error('Delete failed:', result.error?.message);
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  }, [selectedSessionId, refetchSessions]);

  // Handle status filter change
  const handleStatusChange = useCallback(
    (value: string) => {
      if (value === 'all') {
        setFilters({ status: undefined });
      } else {
        setFilters({ status: [value as (typeof SESSION_STATUS)[number]] });
      }
    },
    [setFilters]
  );

  // Handle export all
  const handleExportAll = useCallback(() => {
    if (!sessionsData?.sessions) return;

    const blob = new Blob([JSON.stringify(sessionsData.sessions, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sessions-${codespaceId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionsData?.sessions, codespaceId]);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="session-history-page">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface p-4 md:p-6">
        <div className="flex items-center gap-3">
          <Clock className="h-6 w-6 text-fg-muted" />
          <h1 className="text-lg font-semibold text-fg md:text-xl">Session History</h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Status filter */}
          <Select value={filters.status?.[0] ?? 'all'} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-[140px]">
              <Funnel className="h-4 w-4 text-fg-muted" />
              <SelectValue placeholder="All Sessions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sessions</SelectItem>
              {SESSION_STATUS.map((status) => (
                <SelectItem key={status} value={status}>
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Date range placeholder */}
          <Button variant="outline" size="sm" disabled>
            <Calendar className="h-4 w-4 text-fg-muted" />
            <span className="hidden sm:inline">Date Range</span>
          </Button>

          {/* Clear filters */}
          {hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear Filters
            </Button>
          ) : null}

          {/* Export all */}
          <Button
            variant="default"
            size="sm"
            onClick={handleExportAll}
            disabled={!sessionsData?.sessions?.length}
          >
            <Export className="h-4 w-4" />
            Export All
          </Button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Timeline (left panel) */}
        <SessionTimeline
          groups={sessionGroups}
          selectedSessionId={selectedSessionId ?? undefined}
          onSessionSelect={handleSessionSelect}
          totalCount={sessionsData?.total ?? 0}
          totalDuration={totalDuration}
          isLoading={sessionsLoading}
        />

        {/* Detail view (right panel) */}
        <SessionDetailView
          session={sessionDetailData?.session ?? null}
          isLoading={detailLoading}
          onExport={handleExport}
          onDelete={handleDelete}
        />
      </main>
    </div>
  );
}

export { ExportDropdown } from './components/export-dropdown';
export { SessionCard } from './components/session-card';
export { SessionDetailView } from './components/session-detail-view';
export { SessionSummary } from './components/session-summary';
export { SessionTimeline } from './components/session-timeline';
export { StreamEntry } from './components/stream-entry';
export { StreamViewer } from './components/stream-viewer';
// Re-export types and components for external use
export type {
  ExportFormat,
  SessionDetail,
  SessionFilters,
  SessionHistoryPageProps,
  SessionListItem,
} from './types';
