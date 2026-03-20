import type { TopologyNode } from '@/lib/topology/types';
import { STATUS_COLORS } from '../nodes/agent-node-types';

interface ActivityTabProps {
  node: TopologyNode;
}

interface ActivityEntry {
  label: string;
  timestamp: number | null;
  isCurrent: boolean;
  isFailed: boolean;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// TODO: [CQ-018] Replace with real activity events from the backend
function buildActivityEntries(node: TopologyNode): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const baseTime = node.startedAt ?? Date.now();

  if (node.startedAt) {
    entries.push({
      label: 'Started',
      timestamp: node.startedAt,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.progress >= 10) {
    entries.push({
      label: 'Scanning workspace',
      timestamp: baseTime + 10_000,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.progress >= 25) {
    entries.push({
      label: 'Planning implementation',
      timestamp: baseTime + 30_000,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.progress >= 40) {
    entries.push({
      label: 'Writing code',
      timestamp: baseTime + 60_000,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.progress >= 60) {
    entries.push({
      label: 'Running tests',
      timestamp: baseTime + 120_000,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.progress >= 80) {
    entries.push({
      label: 'Code review',
      timestamp: baseTime + 180_000,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.status === 'verifying') {
    entries.push({
      label: 'Verifying results',
      timestamp: baseTime + 240_000,
      isCurrent: true,
      isFailed: false,
    });
  }
  if (node.status === 'completed') {
    entries.push({
      label: 'Completed successfully',
      timestamp: node.completedAt,
      isCurrent: false,
      isFailed: false,
    });
  }
  if (node.status === 'failed') {
    entries.push({
      label: 'Failed',
      timestamp: node.completedAt ?? Date.now(),
      isCurrent: false,
      isFailed: true,
    });
  }

  // Mark the latest non-failed entry as current if no explicit current
  if (
    entries.length > 0 &&
    !entries.some((e) => e.isCurrent) &&
    node.status !== 'completed' &&
    node.status !== 'failed'
  ) {
    const last = entries[entries.length - 1];
    if (last) last.isCurrent = true;
  }

  return entries;
}

export function ActivityTab({ node }: ActivityTabProps) {
  const entries = buildActivityEntries(node);
  const statusColor = STATUS_COLORS[node.status];

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
            <div key={entry.label} className="relative flex gap-3 pb-4">
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
                {entry.timestamp && (
                  <div className="text-xs text-fg-subtle">{formatTimestamp(entry.timestamp)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
