import { useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import type { TopologyNode } from '@/lib/topology/types';
import { STATUS_COLORS } from '../nodes/agent-node-types';

interface ActivityTabProps {
  node: TopologyNode;
  sessionId?: string;
}

interface ActivityEntry {
  id: string;
  label: string;
  timestamp: number;
  isCurrent: boolean;
  isFailed: boolean;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mapEventToActivity(event: {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
}): ActivityEntry | null {
  const d = event.data as Record<string, unknown>;

  switch (event.type) {
    case 'container-agent:status':
      return {
        id: event.id,
        label: String(d?.message ?? d?.stage ?? 'Status update'),
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: false,
      };
    case 'container-agent:started':
      return {
        id: event.id,
        label: `Agent started${d?.model ? ` (${d.model})` : ''}`,
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: false,
      };
    case 'container-agent:tool:start': {
      const toolName = String(d?.toolName ?? d?.tool ?? 'Tool');
      return {
        id: event.id,
        label: toolName,
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: false,
      };
    }
    case 'container-agent:plan_ready':
      return {
        id: event.id,
        label: 'Plan ready for review',
        timestamp: event.timestamp,
        isCurrent: true,
        isFailed: false,
      };
    case 'container-agent:complete':
      return {
        id: event.id,
        label: 'Completed',
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: false,
      };
    case 'container-agent:error':
      return {
        id: event.id,
        label: String(d?.error ?? 'Error'),
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: true,
      };
    case 'topology:agent_spawned':
      return {
        id: event.id,
        label: `Spawned: ${String(d?.name ?? 'agent')}`,
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: false,
      };
    case 'topology:agent_completed':
      return {
        id: event.id,
        label: 'Agent completed',
        timestamp: event.timestamp,
        isCurrent: false,
        isFailed: false,
      };
    default:
      // Skip message events and unknown types to keep activity concise
      return null;
  }
}

export function ActivityTab({ node, sessionId }: ActivityTabProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const statusColor = STATUS_COLORS[node.status];

  useWatchEffect(() => {
    if (!sessionId) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    apiClient.sessions
      .getEvents(sessionId, { limit: 500 })
      .then((result) => {
        if (cancelled || !result.ok) return;
        const mapped: ActivityEntry[] = [];
        for (const event of result.data) {
          const entry = mapEventToActivity(event);
          if (entry) mapped.push(entry);
        }
        // Mark last non-failed entry as current if none explicitly set
        if (mapped.length > 0 && !mapped.some((e) => e.isCurrent)) {
          const last = mapped[mapped.length - 1];
          if (last && !last.isFailed) last.isCurrent = true;
        }
        setEntries(mapped);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="text-xs text-fg-muted">Loading activity...</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="text-xs text-fg-muted">No activity yet</span>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="relative">
        {entries.map((entry, i) => {
          const isLast = i === entries.length - 1;
          const dotColor = entry.isFailed
            ? STATUS_COLORS.failed
            : entry.isCurrent
              ? statusColor
              : '#475569';

          return (
            <div key={entry.id} className="relative flex gap-3 pb-4">
              {/* Vertical line */}
              {!isLast && (
                <div className="absolute left-[5px] top-3 bottom-0 w-px border-l border-border" />
              )}
              {/* Dot */}
              <div
                className="relative mt-1 h-[10px] w-[10px] shrink-0 rounded-full"
                style={{ backgroundColor: dotColor }}
              />
              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className={entry.isFailed ? 'text-xs text-red-400' : 'text-xs text-fg'}>
                  {entry.label}
                </div>
                <div className="text-xs text-fg-subtle">{formatTimestamp(entry.timestamp)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
