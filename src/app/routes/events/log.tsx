import { Funnel } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { EventLogDetail } from '@/app/components/features/events/event-log-detail';
import { EventLogTimeline } from '@/app/components/features/events/event-log-timeline';
import { useMountEffect, useWatchEffect } from '@/app/hooks/use-effect-factories';
import { type EventStreamEvent, useEventStream } from '@/app/hooks/use-event-stream';
import { EVENT_LOG_STATUS } from '@/db/schema/shared/enums';
import { apiClient } from '@/lib/api/client';
import type { EventLogEntry, EventSource } from '@/lib/events/types';

export const Route = createFileRoute('/events/log')({
  component: EventLogPage,
});

function EventLogPage(): React.JSX.Element {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [sources, setSources] = useState<EventSource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Filters
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');

  // Track whether initial load has completed
  const initialLoadDone = useRef(false);

  const fetchEvents = useCallback(
    async (cursor?: string) => {
      const params: {
        eventSourceId?: string;
        status?: string;
        eventType?: string;
        cursor?: string;
        limit?: number;
      } = { limit: 50 };
      if (sourceFilter) params.eventSourceId = sourceFilter;
      if (statusFilter) params.status = statusFilter;
      if (eventTypeFilter) params.eventType = eventTypeFilter;
      if (cursor) params.cursor = cursor;

      const res = await apiClient.events.log.list(params);
      if (res.ok) {
        if (cursor) {
          setEvents((prev) => [...prev, ...res.data.items]);
        } else {
          setEvents(res.data.items);
        }
        setNextCursor(res.data.nextCursor);
        setHasMore(res.data.hasMore);
      } else {
        console.error('[EventLog] Failed to fetch events:', res.error);
      }
    },
    [sourceFilter, statusFilter, eventTypeFilter]
  );

  // Initial load: fetch events + sources
  useMountEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [, sourcesRes] = await Promise.all([fetchEvents(), apiClient.events.sources.list()]);
        if (cancelled) return;
        if (sourcesRes.ok) setSources(sourcesRes.data.items);
      } catch (err) {
        console.error('[EventLog] Initial load failed:', err);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          initialLoadDone.current = true;
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  });

  // Refetch when dropdown filters change (after initial load)
  useWatchEffect(() => {
    if (!initialLoadDone.current) return;
    setSelectedId(null);
    setNextCursor(null);
    setIsLoading(true);
    void fetchEvents().finally(() => setIsLoading(false));
  }, [sourceFilter, statusFilter, fetchEvents]);

  const handleEventTypeSearch = useCallback(() => {
    if (!initialLoadDone.current) return;
    setSelectedId(null);
    setNextCursor(null);
    setIsLoading(true);
    void fetchEvents().finally(() => setIsLoading(false));
  }, [fetchEvents]);

  // SSE: prepend new events in real-time (debounced)
  const sseDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEventStream({
    onEvent: useCallback(
      (event: EventStreamEvent) => {
        if (event.type === 'event:processed' && event.data?.eventLogId) {
          clearTimeout(sseDebounceRef.current);
          sseDebounceRef.current = setTimeout(() => fetchEvents(), 500);
        }
      },
      [fetchEvents]
    ),
  });

  // Clean up debounce timer on unmount
  useMountEffect(() => {
    return () => clearTimeout(sseDebounceRef.current);
  });

  const selectedEvent = events.find((e) => e.id === selectedId) ?? null;

  if (isLoading && events.length === 0) {
    return (
      <output className="flex flex-1 items-center justify-center" aria-label="Loading events">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </output>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-fg">Event Log</h2>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Funnel className="h-4 w-4 text-fg-muted" />
        <select
          aria-label="Filter by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All Sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">All Statuses</option>
          {EVENT_LOG_STATUS.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter by event type"
          type="text"
          value={eventTypeFilter}
          onChange={(e) => setEventTypeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleEventTypeSearch();
          }}
          onBlur={handleEventTypeSearch}
          placeholder="Event type..."
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Two-panel layout */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Left: Timeline */}
        <div className="flex w-80 flex-shrink-0 flex-col overflow-hidden rounded-lg border border-border">
          <EventLogTimeline
            events={events}
            selectedId={selectedId ?? undefined}
            onSelect={setSelectedId}
          />
          {hasMore && (
            <button
              type="button"
              onClick={() => fetchEvents(nextCursor ?? undefined)}
              className="border-t border-border px-3 py-2 text-xs font-medium text-accent hover:bg-surface-subtle"
            >
              Load more
            </button>
          )}
        </div>

        {/* Right: Detail */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-border">
          {selectedEvent ? (
            <EventLogDetail
              event={selectedEvent}
              sourceName={sources.find((s) => s.id === selectedEvent.eventSourceId)?.name}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
              Select an event to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
