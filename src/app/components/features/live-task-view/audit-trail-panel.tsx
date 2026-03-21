import {
  Circle,
  ClockCounterClockwise,
  Lightning,
  ListBullets,
  Terminal,
} from '@phosphor-icons/react';
import { useState } from 'react';
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
      return { label: 'Backlog', className: 'bg-fg-subtle/15 text-fg-subtle' };
    case 'in_progress':
      return { label: 'In Progress', className: 'bg-accent/15 text-accent' };
    case 'waiting_approval':
      return { label: 'Waiting Approval', className: 'bg-attention/15 text-attention' };
    case 'done':
      return { label: 'Done', className: 'bg-success/15 text-success' };
    default:
      return { label: column, className: 'bg-fg-subtle/15 text-fg-subtle' };
  }
}

function buildTimelineEvents(task: AuditTrailPanelProps['task']): TimelineEvent[] {
  if (!task) return [];

  const events: TimelineEvent[] = [
    {
      id: 'created',
      label: 'Task created',
      color: 'bg-fg-subtle',
      timestamp: 'Just now',
    },
  ];

  if (
    task.column === 'in_progress' ||
    task.column === 'waiting_approval' ||
    task.column === 'done'
  ) {
    events.push(
      {
        id: 'moved-ip',
        label: 'Moved to In Progress',
        color: 'bg-accent',
        timestamp: 'Just now',
      },
      {
        id: 'agent-assigned',
        label: 'Agent assigned',
        color: 'bg-accent',
        timestamp: 'Just now',
      }
    );
  }

  if (task.column === 'waiting_approval' || task.column === 'done') {
    events.push({
      id: 'plan-ready',
      label: 'Plan ready for review',
      color: 'bg-attention',
      timestamp: 'Just now',
    });
  }

  if (task.column === 'done') {
    events.push({
      id: 'completed',
      label: 'Task completed',
      color: 'bg-success',
      timestamp: 'Just now',
    });
  }

  return events;
}

// =============================================================================
// AuditTrailPanel Component
// =============================================================================

export function AuditTrailPanel({ task }: AuditTrailPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('events');

  // Empty state
  if (!task) {
    return (
      <aside
        className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface"
        data-testid="audit-trail-panel"
      >
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
  const events = buildTimelineEvents(task);

  return (
    <aside
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface"
      data-testid="audit-trail-panel"
    >
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
          <EventsTab events={events} />
        ) : (
          <StreamTab sessionId={task.sessionId} />
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

function EventsTab({ events }: { events: TimelineEvent[] }): React.JSX.Element {
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

function StreamTab({ sessionId }: { sessionId?: string | null }): React.JSX.Element {
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12">
        <Terminal size={18} className="text-fg-subtle" />
        <p className="text-[12px] text-fg-muted">No active session</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 rounded-md bg-surface-emphasis px-3 py-2">
        <Circle size={8} weight="fill" className="shrink-0 text-success animate-pulse" />
        <p className="text-[12px] font-mono text-fg-muted truncate">
          Connected to session <span className="text-fg">{sessionId.slice(0, 12)}</span>
        </p>
      </div>

      {/* Placeholder for future stream output */}
      <div className="mt-3 rounded-md border border-border-subtle bg-surface-emphasis p-3">
        <p className="text-[11px] text-fg-subtle italic">
          Session output will appear here when streaming is connected.
        </p>
      </div>
    </div>
  );
}
