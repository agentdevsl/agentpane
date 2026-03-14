import {
  ArrowBendUpRight,
  CheckCircle,
  Eye,
  Pause,
  Play,
  SignIn,
  SignOut,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';

// Activity item types
export type ActivityItemType =
  | 'join' // User joined session
  | 'leave' // User left session
  | 'watch' // User watching
  | 'start' // Session started
  | 'pause' // Agent paused
  | 'resume' // Agent resumed
  | 'complete' // Agent completed
  | 'error'; // Error occurred

export interface ActivityItem {
  id: string;
  type: ActivityItemType;
  userId?: string;
  displayName?: string;
  message: string;
  timestamp: number;
}

interface ActivitySidebarProps {
  items: ActivityItem[];
  onLeaveSession: () => void;
  onEndSession: () => void;
  canEndSession: boolean;
  sessionMetadata?: {
    projectName?: string;
    agentName?: string;
    startedAt?: number;
  };
}

const activityIconVariants = cva(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
  {
    variants: {
      type: {
        join: 'bg-success/15 text-success',
        leave: 'bg-surface-subtle text-fg-muted',
        watch: 'bg-done/15 text-done',
        start: 'bg-accent/15 text-accent',
        pause: 'bg-warning/15 text-warning',
        resume: 'bg-success/15 text-success',
        complete: 'bg-success/15 text-success',
        error: 'bg-danger/15 text-danger',
      },
    },
    defaultVariants: {
      type: 'start',
    },
  }
);

const activityIcons: Record<ActivityItemType, React.ElementType> = {
  join: SignIn,
  leave: SignOut,
  watch: Eye,
  start: Play,
  pause: Pause,
  resume: ArrowBendUpRight,
  complete: CheckCircle,
  error: WarningCircle,
};

function formatRelativeTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSeconds < 30) {
    return 'Just now';
  }
  if (diffMins < 1) {
    return `${diffSeconds}s ago`;
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function ActivityItemRow({ item }: { item: ActivityItem }): React.JSX.Element {
  const Icon = activityIcons[item.type];

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border last:border-b-0">
      <div className={activityIconVariants({ type: item.type })}>
        <Icon className="h-4 w-4" weight="bold" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg leading-snug">
          {item.displayName && <strong className="font-medium">{item.displayName}</strong>}{' '}
          {item.message}
        </p>
        <p className="text-xs text-fg-subtle mt-0.5">{formatRelativeTime(item.timestamp)}</p>
      </div>
    </div>
  );
}

// Action button variants for sidebar
const actionButtonVariants = cva(
  'flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-all',
  {
    variants: {
      intent: {
        danger:
          'border border-danger/40 bg-danger/10 text-danger hover:bg-danger hover:text-white hover:border-danger',
        secondary:
          'border border-border bg-surface-subtle text-fg-muted hover:bg-surface hover:text-fg',
      },
    },
    defaultVariants: {
      intent: 'secondary',
    },
  }
);

export function ActivitySidebar({
  items,
  onLeaveSession,
  onEndSession,
  canEndSession,
  sessionMetadata,
}: ActivitySidebarProps): React.JSX.Element {
  return (
    <aside className="flex h-full w-80 flex-col border-l border-border bg-surface">
      {/* Header */}
      <div className="border-b border-border px-4 py-4">
        <h2 className="text-sm font-semibold text-fg">Activity</h2>
      </div>

      {/* Session metadata */}
      {sessionMetadata && (
        <div className="border-b border-border px-4 py-3 space-y-2">
          {sessionMetadata.projectName && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-muted">Project</span>
              <span className="text-fg font-medium truncate max-w-[180px]">
                {sessionMetadata.projectName}
              </span>
            </div>
          )}
          {sessionMetadata.agentName && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-muted">Agent</span>
              <span className="text-fg font-medium truncate max-w-[180px]">
                {sessionMetadata.agentName}
              </span>
            </div>
          )}
          {sessionMetadata.startedAt && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-muted">Started</span>
              <span className="text-fg">{formatRelativeTime(sessionMetadata.startedAt)}</span>
            </div>
          )}
        </div>
      )}

      {/* Activity feed */}
      <div className="flex-1 overflow-y-auto px-4">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center py-12">
            <p className="text-sm text-fg-muted">No activity yet</p>
          </div>
        ) : (
          <div>
            {items.map((item) => (
              <ActivityItemRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* Session actions */}
      <div className="border-t border-border p-4 space-y-2">
        {canEndSession && (
          <button
            type="button"
            onClick={onEndSession}
            className={actionButtonVariants({ intent: 'danger' })}
          >
            <XCircle className="h-4 w-4" weight="bold" />
            End Session
          </button>
        )}
        <button
          type="button"
          onClick={onLeaveSession}
          className={actionButtonVariants({ intent: 'secondary' })}
        >
          <SignOut className="h-4 w-4" weight="bold" />
          Leave Session
        </button>
      </div>
    </aside>
  );
}

// Export for use in other components
export { activityIcons, activityIconVariants, formatRelativeTime };
