import { useCallback, useMemo, useState } from 'react';
import type { SessionStatus } from '@/db/schema';
import { apiClient } from '@/lib/api/client';
import { extractSessionEvents, type TopologyEvent } from '@/lib/topology/build-from-events';
import { SessionDetailView } from './components/session-detail-view';
import { SessionTimeline } from './components/session-timeline';
import type { ExportFormat, SessionDetail, SessionListItem } from './types';
import { formatDuration } from './utils/format-duration';
import { calculateTotalDuration, groupSessionsByDate } from './utils/group-by-date';

/**
 * Raw session data from API - more flexible type that accepts
 * what the API actually returns (Session with presence and summary data)
 */
export interface RawSession {
  id: string;
  codespaceId: string;
  taskId?: string | null;
  agentId?: string | null;
  title?: string | null;
  url: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  presence?: unknown[];
  // Summary fields (enriched from API)
  turnsUsed?: number;
  tokensUsed?: number;
  filesModified?: number;
  linesAdded?: number;
  linesRemoved?: number;
  sandboxProvider?: string | null;
  sandboxContainerId?: string | null;
  costUsd?: number | null;
}

function mapSessionEvents(events: TopologyEvent[]): SessionDetail['events'] {
  return events.map((event) => ({
    id: event.id,
    type: event.type as SessionDetail['events'][0]['type'],
    timestamp: event.timestamp,
    data: event.data,
  }));
}

function mergeSessionEvents(
  existingEvents: SessionDetail['events'],
  newEvents: SessionDetail['events']
): SessionDetail['events'] {
  if (newEvents.length === 0) {
    return existingEvents;
  }

  const seenIds = new Set(existingEvents.map((event) => event.id));
  return [...existingEvents, ...newEvents.filter((event) => !seenIds.has(event.id))];
}

/** Project for filtering */
export interface ProjectOption {
  id: string;
  name: string;
}

export interface SessionHistoryProps {
  /** Sessions to display (accepts raw API response or SessionListItem[]) */
  sessions: RawSession[] | SessionListItem[];
  /** Available projects for filtering */
  projects?: ProjectOption[];
  /** Currently selected project ID for filtering */
  selectedProjectId?: string | null;
  /** Callback when project filter changes */
  onProjectChange?: (projectId: string | null) => void;
  /** Callback when session is opened (e.g., for navigation) */
  onOpen?: (sessionId: string) => void;
  /** Callback to navigate to the linked task */
  onViewTask?: (taskId: string, projectId: string) => void;
  /** Loading state */
  isLoading?: boolean;
}

/**
 * Transform raw API session to SessionListItem format
 */
function toSessionListItem(raw: RawSession, projectMap: Map<string, string>): SessionListItem {
  const createdAt = raw.createdAt ?? new Date().toISOString();
  const closedAt = raw.closedAt ?? null;
  const duration =
    closedAt && createdAt ? new Date(closedAt).getTime() - new Date(createdAt).getTime() : null;

  return {
    id: raw.id,
    title: raw.title ?? null,
    agentName: null, // Would need join to populate
    agentId: raw.agentId ?? null,
    taskId: raw.taskId ?? null,
    taskTitle: null, // Would need join to populate
    status: raw.status as SessionStatus,
    createdAt,
    closedAt,
    duration,
    turnsUsed: raw.turnsUsed ?? 0,
    tokensUsed: raw.tokensUsed ?? 0,
    codespaceId: raw.codespaceId,
    codespaceName: projectMap.get(raw.codespaceId) ?? null,
    sandboxProvider: raw.sandboxProvider ?? null,
    sandboxContainerId: raw.sandboxContainerId ?? null,
    costUsd: raw.costUsd ?? null,
  };
}

export function SessionHistory({
  sessions: rawSessions,
  projects,
  selectedProjectId,
  onProjectChange,
  onViewTask,
  isLoading = false,
}: SessionHistoryProps): React.JSX.Element {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Build project ID to name lookup
  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects ?? []) {
      map.set(p.id, p.name);
    }
    return map;
  }, [projects]);

  // Transform raw sessions to SessionListItem format
  const sessions = useMemo(() => {
    return rawSessions.map((s) => {
      // Check if already in SessionListItem format (has turnsUsed field)
      if ('turnsUsed' in s) {
        return s as SessionListItem;
      }
      return toSessionListItem(s as RawSession, projectMap);
    });
  }, [rawSessions, projectMap]);

  // Group sessions by date
  const sessionGroups = useMemo(() => groupSessionsByDate(sessions), [sessions]);

  // Calculate total duration
  const totalDuration = useMemo(() => {
    const totalMs = calculateTotalDuration(sessions);
    return formatDuration(totalMs);
  }, [sessions]);

  // Fetch session detail when selected
  const handleSessionSelect = useCallback(
    async (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setDetailLoading(true);

      const previousDetail = sessionDetail?.id === sessionId ? sessionDetail : null;

      const loadEvents = async (): Promise<{
        mode: 'full' | 'incremental';
        result: Awaited<ReturnType<typeof apiClient.sessions.getEvents>>;
      }> => {
        const lastEvent = previousDetail?.events[previousDetail.events.length - 1];
        const lastEventId = lastEvent?.id;

        if (!lastEventId) {
          return {
            mode: 'full',
            result: await apiClient.sessions.getEvents(sessionId, { limit: 1000 }),
          };
        }

        const incrementalResult = await apiClient.sessions.getEvents(sessionId, {
          limit: 1000,
          afterEventId: lastEventId,
        });

        if (
          !incrementalResult.ok &&
          incrementalResult.error.code === 'SESSION_RESUME_POINT_NOT_FOUND'
        ) {
          return {
            mode: 'full',
            result: await apiClient.sessions.getEvents(sessionId, { limit: 1000 }),
          };
        }

        return {
          mode: 'incremental',
          result: incrementalResult,
        };
      };

      try {
        // Fetch session, events, and summary in parallel
        const [sessionResult, eventsLoad, summaryResult] = await Promise.all([
          apiClient.sessions.get(sessionId),
          loadEvents(),
          apiClient.sessions.getSummary(sessionId),
        ]);

        const sessionData = sessionResult?.ok ? sessionResult.data : null;
        if (sessionData) {
          // Transform API response to SessionDetail format
          const session = sessionData as RawSession;
          const createdAt = session.createdAt ?? new Date().toISOString();

          let events = previousDetail?.events ?? [];
          if (eventsLoad.result.ok && eventsLoad.result.data) {
            const fetchedEvents = mapSessionEvents(
              extractSessionEvents(
                eventsLoad.result.data as TopologyEvent[] | { data: TopologyEvent[] }
              )
            );
            events =
              eventsLoad.mode === 'incremental' && previousDetail
                ? mergeSessionEvents(previousDetail.events, fetchedEvents)
                : fetchedEvents;
          } else if (!eventsLoad.result.ok) {
            console.error('Failed to fetch session events:', eventsLoad.result.error.message);
          }

          // Get metrics from summary
          const summary = summaryResult?.ok ? summaryResult.data : null;

          // Calculate total tokens and turns from events
          let totalTokensFromEvents = 0;
          let turnsFromEvents = 0;
          for (const event of events) {
            const eventData = event.data as { role?: string; usage?: { totalTokens?: number } };
            if (eventData?.usage?.totalTokens) {
              totalTokensFromEvents += eventData.usage.totalTokens;
            }
            // Count assistant messages as turns
            if (eventData?.role === 'assistant') {
              turnsFromEvents++;
            }
          }

          const detail: SessionDetail = {
            id: session.id,
            title: session.title ?? null,
            agentName: null, // Would need join to populate
            agentId: session.agentId ?? null,
            taskId: session.taskId ?? null,
            taskTitle: null, // Would need join to populate
            status: session.status as SessionStatus,
            createdAt,
            closedAt: session.closedAt ?? null,
            duration:
              summary?.durationMs ??
              previousDetail?.duration ??
              (session.closedAt
                ? new Date(session.closedAt).getTime() - new Date(createdAt).getTime()
                : null),
            turnsUsed: turnsFromEvents || summary?.turnsCount || previousDetail?.turnsUsed || 0,
            tokensUsed:
              totalTokensFromEvents || summary?.tokensUsed || previousDetail?.tokensUsed || 0,
            codespaceId: session.codespaceId,
            codespaceName: projectMap.get(session.codespaceId) ?? null,
            url: session.url,
            events,
            sandboxProvider: session.sandboxProvider ?? null,
            sandboxContainerId: session.sandboxContainerId ?? null,
            filesModified: summary?.filesModified ?? previousDetail?.filesModified ?? 0,
            linesAdded: summary?.linesAdded ?? previousDetail?.linesAdded ?? 0,
            linesRemoved: summary?.linesRemoved ?? previousDetail?.linesRemoved ?? 0,
            skillId: previousDetail?.skillId ?? null,
            skillName: previousDetail?.skillName ?? null,
            testsRun: previousDetail?.testsRun ?? 0,
            testsPassed: previousDetail?.testsPassed ?? 0,
            costUsd:
              (summary as { costUsd?: number | null } | null)?.costUsd ??
              previousDetail?.costUsd ??
              null,
          };
          setSessionDetail(detail);
        }
      } catch (err) {
        console.error('Failed to fetch session detail:', err);
      } finally {
        setDetailLoading(false);
      }
    },
    [projectMap, sessionDetail]
  );

  // Handle export
  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!selectedSessionId) return;

      try {
        const result = await apiClient.sessions.export(selectedSessionId, format);
        if (result.ok && result.data) {
          const { content, contentType, filename } = result.data;
          const blob = new Blob([content], { type: contentType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch (err) {
        console.error('Export error:', err);
      }
    },
    [selectedSessionId]
  );

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!selectedSessionId) return;

    try {
      const result = await apiClient.sessions.delete(selectedSessionId);
      if (result.ok) {
        setSelectedSessionId(null);
        setSessionDetail(null);
        // Note: Parent component should refetch sessions list
      } else {
        console.error('Delete failed:', result.error?.message);
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  }, [selectedSessionId]);

  return (
    <div className="flex h-full flex-1 overflow-hidden border-t border-border">
      {/* Timeline (left panel) */}
      <SessionTimeline
        groups={sessionGroups}
        selectedSessionId={selectedSessionId ?? undefined}
        onSessionSelect={handleSessionSelect}
        totalCount={sessions.length}
        totalDuration={totalDuration}
        isLoading={isLoading}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onProjectChange={onProjectChange}
      />

      {/* Detail view (right panel) */}
      <SessionDetailView
        session={sessionDetail}
        isLoading={detailLoading}
        onExport={handleExport}
        onDelete={handleDelete}
        onRefresh={selectedSessionId ? () => handleSessionSelect(selectedSessionId) : undefined}
        onViewTask={onViewTask}
      />
    </div>
  );
}
