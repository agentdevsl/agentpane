import {
  Circle,
  ClockCounterClockwise,
  Lightning,
  ListBullets,
  SpinnerGap,
  Terminal,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useRef, useState } from 'react';
import { ResizeHandle } from '@/app/components/ui/resize-handle';
import { useLocalStorage } from '@/app/hooks/use-local-storage';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { type SessionCallbacks, subscribeToSession } from '@/lib/streams/client';
import { cn } from '@/lib/utils/cn';

// =============================================================================
// Types
// =============================================================================

interface AuditTrailPanelProps {
  task: {
    id: string;
    title: string;
    column: string;
    sessionId?: string | null;
    agentId?: string | null;
    lastAgentStatus?: string | null;
    description?: string | null;
    labels?: string[] | null;
    branch?: string | null;
  } | null;
}

type Tab = 'events' | 'stream';

interface TimelineEvent {
  id: string;
  label: string;
  color: string;
  timestamp: string;
}

interface StreamMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface SessionEventRecord {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
}

function extractSessionEvents(
  payload: SessionEventRecord[] | { data: SessionEventRecord[] }
): SessionEventRecord[] {
  return Array.isArray(payload) ? payload : payload.data;
}

// =============================================================================
// Helpers
// =============================================================================

function getStatusBadge(column: string, agentStatus?: string | null) {
  if (agentStatus === 'running' || agentStatus === 'planning') {
    return {
      label: agentStatus === 'planning' ? 'Planning' : 'Running',
      className: 'bg-success/15 text-success',
    };
  }

  switch (column) {
    case 'backlog':
      return { label: 'Backlog', className: 'bg-[var(--fg-muted)]/15 text-[var(--fg-muted)]' };
    case 'queued':
      return { label: 'Queued', className: 'bg-accent/15 text-accent' };
    case 'in_progress':
      return { label: 'In Progress', className: 'bg-attention/15 text-attention' };
    case 'waiting_approval':
      return { label: 'Waiting Approval', className: 'bg-done/15 text-done' };
    case 'done':
    case 'verified':
      return { label: 'Verified', className: 'bg-success/15 text-success' };
    default:
      return { label: column, className: 'bg-[var(--fg-muted)]/15 text-[var(--fg-muted)]' };
  }
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${Math.max(0, diffSec)}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  return new Date(timestamp).toLocaleDateString();
}

function mapEventToTimelineEntry(event: {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
}): TimelineEvent {
  const d = event.data as Record<string, unknown>;
  const ts = formatRelativeTime(event.timestamp);

  switch (event.type) {
    case 'container-agent:status':
      return {
        id: event.id,
        label: String(d?.message ?? d?.stage ?? 'Status update'),
        color: 'bg-fg-subtle',
        timestamp: ts,
      };

    case 'container-agent:started':
      return {
        id: event.id,
        label: `Agent started${d?.model ? ` (${d.model})` : ''}`,
        color: 'bg-accent',
        timestamp: ts,
      };

    case 'container-agent:tool:start':
      return {
        id: event.id,
        label: `Tool: ${String(d?.toolName ?? d?.tool ?? 'Command')}`,
        color: 'bg-fg-subtle',
        timestamp: ts,
      };

    case 'container-agent:message': {
      const content = String(d?.content ?? '');
      const truncated = content.length > 80 ? `${content.slice(0, 80)}...` : content;
      const role = String(d?.role ?? 'system');
      const color = role === 'assistant' ? 'bg-accent' : 'bg-fg-subtle';
      return {
        id: event.id,
        label: truncated || 'Message',
        color,
        timestamp: ts,
      };
    }

    case 'container-agent:plan_ready':
      return {
        id: event.id,
        label: 'Plan ready for review',
        color: 'bg-warning',
        timestamp: ts,
      };

    case 'container-agent:complete':
      return {
        id: event.id,
        label: 'Agent completed',
        color: 'bg-success',
        timestamp: ts,
      };

    case 'container-agent:error':
      return {
        id: event.id,
        label: String(d?.error ?? 'Error'),
        color: 'bg-danger',
        timestamp: ts,
      };

    case 'topology:agent_spawned':
      return {
        id: event.id,
        label: `Agent spawned: ${String(d?.name ?? 'unknown')}`,
        color: 'bg-accent',
        timestamp: ts,
      };

    case 'topology:agent_completed':
      return {
        id: event.id,
        label: 'Agent completed',
        color: 'bg-success',
        timestamp: ts,
      };

    default:
      return {
        id: event.id,
        label: event.type,
        color: 'bg-fg-subtle',
        timestamp: ts,
      };
  }
}

function getStableStreamId(
  event: { meta?: { eventId?: string | undefined }; cursor?: string },
  fallback: string
): string {
  return event.meta?.eventId ?? event.cursor ?? fallback;
}

// =============================================================================
// AuditTrailPanel Component
// =============================================================================

export function AuditTrailPanel({ task }: AuditTrailPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('events');
  const [panelWidth, setPanelWidth] = useLocalStorage('live-task-view:audit-width', 440);

  // Empty state
  if (!task) {
    return (
      <aside
        className="relative flex h-full shrink-0 flex-col border-l border-border bg-surface"
        style={{ width: panelWidth }}
        data-testid="audit-trail-panel"
      >
        <ResizeHandle
          side="left"
          currentWidth={panelWidth}
          onResize={setPanelWidth}
          onResizeEnd={setPanelWidth}
          minWidth={200}
          maxWidth={1200}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-emphasis">
            <ClockCounterClockwise size={20} className="text-fg-subtle" />
          </div>
          <p className="text-center text-[13px] text-fg-muted">
            Select a task to view its audit trail
          </p>
        </div>
      </aside>
    );
  }

  const badge = getStatusBadge(task.column, task.lastAgentStatus);

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-surface"
      style={{ width: panelWidth }}
      data-testid="audit-trail-panel"
    >
      <ResizeHandle
        side="left"
        currentWidth={panelWidth}
        onResize={setPanelWidth}
        onResizeEnd={setPanelWidth}
        minWidth={200}
        maxWidth={1200}
      />
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3 min-h-[52px]">
        <h3 className="flex-1 truncate text-[13px] font-semibold text-fg">{task.title}</h3>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            badge.className
          )}
        >
          {badge.label}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border-subtle">
        <TabButton
          active={activeTab === 'events'}
          onClick={() => setActiveTab('events')}
          icon={ListBullets}
          label="Events"
        />
        <TabButton
          active={activeTab === 'stream'}
          onClick={() => setActiveTab('stream')}
          icon={Terminal}
          label="Stream"
        />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'events' ? (
          <EventsTab sessionId={task.sessionId} />
        ) : (
          <StreamTab sessionId={task.sessionId} taskColumn={task.column} />
        )}
      </div>
    </aside>
  );
}

// =============================================================================
// TabButton Sub-component
// =============================================================================

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof ListBullets;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] font-medium',
        'transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
        'border-b-2 -mb-px',
        active
          ? 'border-accent bg-surface-emphasis text-fg'
          : 'border-transparent text-fg-muted hover:text-fg hover:bg-surface-subtle'
      )}
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </button>
  );
}

// =============================================================================
// EventsTab Sub-component
// =============================================================================

function EventsTab({ sessionId }: { sessionId?: string | null }): React.JSX.Element {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  useWatchEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setLoading(false);
      setError(null);
      seenEventIdsRef.current = new Set();
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    seenEventIdsRef.current = new Set();

    apiClient.sessions
      .getEvents(sessionId, { limit: 200 })
      .then((result) => {
        if (cancelled) return;

        if (!result.ok) {
          setError(result.error?.message ?? 'Failed to fetch events');
          setEvents([]);
        } else {
          const raw = extractSessionEvents(
            result.data as SessionEventRecord[] | { data: SessionEventRecord[] }
          );
          seenEventIdsRef.current = new Set(raw.map((event) => event.id));
          const mapped = raw.map(mapEventToTimelineEntry);
          setEvents(mapped);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unexpected error');
        setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useWatchEffect(() => {
    if (!sessionId) return;

    const callbacks: SessionCallbacks = {
      onContainerAgentStatus: (event) => {
        const id = getStableStreamId(event, `stream-status-${event.data.timestamp}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'container-agent:status',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onContainerAgentToolStart: (event) => {
        const id = getStableStreamId(event, `stream-tool-start-${event.data.toolId}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'container-agent:tool:start',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onContainerAgentMessage: (event) => {
        const id = getStableStreamId(event, `stream-message-${event.data.timestamp}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'container-agent:message',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onContainerAgentPlanReady: (event) => {
        const id = getStableStreamId(event, `stream-plan-ready-${event.data.timestamp}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'container-agent:plan_ready',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onContainerAgentComplete: (event) => {
        const id = getStableStreamId(event, `stream-complete-${event.data.timestamp}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'container-agent:complete',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onContainerAgentError: (event) => {
        const id = getStableStreamId(event, `stream-error-${event.data.timestamp}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'container-agent:error',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onTopologyAgentSpawned: (event) => {
        const id = getStableStreamId(event, `stream-topology-spawned-${event.data.agentId}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'topology:agent_spawned',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
      onTopologyAgentCompleted: (event) => {
        const id = getStableStreamId(event, `stream-topology-completed-${event.data.agentId}`);
        if (seenEventIdsRef.current.has(id)) return;
        seenEventIdsRef.current.add(id);
        setEvents((prev) => [
          ...prev,
          mapEventToTimelineEntry({
            id,
            type: 'topology:agent_completed',
            timestamp: event.data.timestamp,
            data: event.data,
          }),
        ]);
      },
    };

    const subscription = subscribeToSession(sessionId, callbacks);

    return () => {
      subscription.unsubscribe();
    };
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <Lightning size={18} className="text-fg-subtle" />
        <p className="text-[12px] text-fg-muted">No session attached</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <SpinnerGap size={18} className="text-fg-subtle animate-spin" />
        <p className="text-[12px] text-fg-muted">Loading events...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <WarningCircle size={18} className="text-danger" />
        <p className="text-[12px] text-danger">{error}</p>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <Lightning size={18} className="text-fg-subtle" />
        <p className="text-[12px] text-fg-muted">No events yet</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="relative">
        {events.map((event, index) => {
          const isLast = index === events.length - 1;

          return (
            <div key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
              {/* Timeline connector */}
              <div className="relative flex flex-col items-center">
                {/* Dot */}
                <div
                  className={cn(
                    'relative z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full',
                    event.color
                  )}
                />
                {/* Vertical line */}
                {!isLast && <div className="absolute top-3 bottom-0 w-px bg-border-subtle" />}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pt-px">
                <p className="text-[12px] font-medium text-fg">{event.label}</p>
                <p className="text-[11px] text-fg-subtle mt-0.5">{event.timestamp}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// StreamTab Sub-component
// =============================================================================

function StreamTab({
  sessionId,
  taskColumn,
}: {
  sessionId?: string | null;
  taskColumn: string;
}): React.JSX.Element {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [currentDelta, setCurrentDelta] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seenStreamEventIdsRef = useRef<Set<string>>(new Set());
  const isLive = taskColumn === 'in_progress';

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  // Fetch historical messages from session events
  useWatchEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setCurrentDelta('');
      seenStreamEventIdsRef.current = new Set();
      return;
    }

    let cancelled = false;
    setLoading(true);
    setCurrentDelta('');
    seenStreamEventIdsRef.current = new Set();

    apiClient.sessions
      .getEvents(sessionId, { limit: 500 })
      .then((result) => {
        if (cancelled || !result.ok) return;
        const msgs: StreamMessage[] = [];
        const seenIds = new Set<string>();
        for (const event of extractSessionEvents(
          result.data as SessionEventRecord[] | { data: SessionEventRecord[] }
        )) {
          if (event.type === 'container-agent:message') {
            const d = event.data as Record<string, unknown>;
            const content = String(d?.content ?? '');
            if (content) {
              seenIds.add(event.id);
              msgs.push({
                id: event.id,
                role: (d?.role as StreamMessage['role']) ?? 'system',
                content,
                timestamp: event.timestamp,
              });
            }
          }
        }
        seenStreamEventIdsRef.current = seenIds;
        setMessages(msgs);
        scrollToBottom();
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, scrollToBottom]);

  // Subscribe to live SSE when task is actively running
  useWatchEffect(() => {
    if (!sessionId || !isLive) {
      setConnected(false);
      return;
    }

    const callbacks: SessionCallbacks = {
      onConnectionStateChange: (state) => {
        setConnected(state === 'connected');
      },
      onContainerAgentMessage: (event) => {
        const id = getStableStreamId(
          event,
          `stream-message-${event.data.role}:${event.data.timestamp}:${event.data.content}`
        );
        if (seenStreamEventIdsRef.current.has(id)) {
          return;
        }

        seenStreamEventIdsRef.current.add(id);
        setMessages((prev) => [
          ...prev,
          {
            id,
            role: event.data.role,
            content: event.data.content,
            timestamp: event.data.timestamp,
          },
        ]);
        setCurrentDelta('');
        scrollToBottom();
      },
      onContainerAgentToken: (event) => {
        const id = getStableStreamId(
          event,
          `stream-token-${event.data.timestamp}:${event.data.delta}`
        );
        if (seenStreamEventIdsRef.current.has(id)) {
          return;
        }

        seenStreamEventIdsRef.current.add(id);
        setCurrentDelta((prev) => prev + event.data.delta);
        scrollToBottom();
      },
      onChunk: (event) => {
        const id = getStableStreamId(
          event,
          `stream-chunk-${event.data.timestamp}:${event.data.text}`
        );
        if (seenStreamEventIdsRef.current.has(id)) {
          return;
        }

        seenStreamEventIdsRef.current.add(id);
        setCurrentDelta((prev) => prev + event.data.text);
        scrollToBottom();
      },
    };

    const subscription = subscribeToSession(sessionId, callbacks);
    return () => {
      subscription.unsubscribe();
    };
  }, [sessionId, isLive, scrollToBottom]);

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <Terminal size={18} className="text-fg-subtle" />
        <p className="text-[12px] text-fg-muted">No active session</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <SpinnerGap size={18} className="text-fg-subtle animate-spin" />
        <p className="text-[12px] text-fg-muted">Loading messages...</p>
      </div>
    );
  }

  const hasContent = messages.length > 0 || currentDelta.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Status indicator */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle">
        <Circle
          size={8}
          weight="fill"
          className={cn(
            'shrink-0',
            isLive && connected
              ? 'text-success animate-pulse'
              : isLive
                ? 'text-fg-subtle'
                : 'text-fg-subtle'
          )}
        />
        <p className="text-[11px] font-mono text-fg-muted truncate">
          {isLive && connected ? (
            <>
              Live <span className="text-fg">{sessionId.slice(0, 12)}</span>
            </>
          ) : isLive ? (
            'Connecting...'
          ) : (
            <>
              Session <span className="text-fg">{sessionId.slice(0, 12)}</span>
            </>
          )}
        </p>
        {!isLive && messages.length > 0 && (
          <span className="ml-auto text-[10px] text-fg-subtle">{messages.length} messages</span>
        )}
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-surface-emphasis font-mono">
        {!hasContent ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
            <Terminal size={18} className="text-fg-subtle" />
            <p className="text-[12px] text-fg-muted italic">
              {isLive ? 'Listening for events...' : 'No messages in this session'}
            </p>
          </div>
        ) : (
          <div className="px-3 py-2 space-y-2">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className="rounded-md border border-border-subtle bg-surface px-3 py-2"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={cn(
                      'text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded',
                      msg.role === 'assistant'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-fg-subtle/15 text-fg-subtle'
                    )}
                  >
                    {msg.role}
                  </span>
                  <span className="text-[10px] text-fg-subtle">
                    {formatRelativeTime(msg.timestamp)}
                  </span>
                </div>
                <p className="text-[11px] text-fg/90 whitespace-pre-wrap break-words leading-relaxed">
                  {msg.content}
                </p>
              </div>
            ))}

            {/* Current streaming delta */}
            {currentDelta.length > 0 && (
              <div className="rounded-md border border-accent/20 bg-accent/5 px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent/15 text-accent">
                    assistant
                  </span>
                  <SpinnerGap size={10} className="text-accent animate-spin" />
                </div>
                <p className="text-[11px] text-fg/90 whitespace-pre-wrap break-words leading-relaxed">
                  {currentDelta}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
