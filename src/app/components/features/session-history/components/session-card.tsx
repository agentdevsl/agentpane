import { ChatCircle, Clock, Coins, Wrench } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { ExecutionBadge } from '@/app/components/ui/execution-badge';
import { cn } from '@/lib/utils/cn';
import type { SessionCardProps } from '../types';
import { SESSION_STATUS_COLORS } from '../types';
import {
  formatDuration,
  formatRelativeTime,
  formatTimeOfDay,
  formatTokens,
} from '../utils/format-duration';

const cardVariants = cva(
  'relative ml-5 cursor-pointer rounded-md border bg-surface-subtle p-2.5 transition-all duration-fast ease-out',
  {
    variants: {
      isSelected: {
        true: 'border-accent bg-accent/10',
        false: 'border-border hover:border-fg-subtle hover:bg-surface-muted',
      },
    },
    defaultVariants: {
      isSelected: false,
    },
  }
);

const dotVariants = cva(
  'absolute left-[-17px] top-3 h-2 w-2 rounded-full border-2 transition-all duration-fast ease-out',
  {
    variants: {
      isSelected: {
        true: 'border-accent bg-accent',
        false: 'border-border bg-surface-muted',
      },
    },
    defaultVariants: {
      isSelected: false,
    },
  }
);

export function SessionCard({
  session,
  isSelected = false,
  onClick,
  compact = false,
}: SessionCardProps): React.JSX.Element {
  const statusColors = SESSION_STATUS_COLORS[session.status];
  const isActive = session.status === 'active';

  return (
    <button
      type="button"
      className={cardVariants({ isSelected })}
      onClick={onClick}
      data-testid="session-card"
      data-session-id={session.id}
      aria-pressed={isSelected}
    >
      {/* Timeline dot */}
      <span className={cn(dotVariants({ isSelected }), !isSelected && statusColors.dot)} />

      {/* Header: ID + Time + Project */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-xs font-medium text-accent">
            #{session.id.slice(0, 7)}
          </span>
          {session.projectName && (
            <>
              <span className="text-fg-subtle">·</span>
              <span className="truncate text-xs text-fg-muted">{session.projectName}</span>
            </>
          )}
        </div>
        <span className="shrink-0 text-xs text-fg-subtle">
          {formatTimeOfDay(session.createdAt)}
        </span>
      </div>

      {/* Agent name */}
      {!compact && session.agentName && (
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-fg">
          <Wrench className="h-3 w-3 text-fg-muted" />
          {session.agentName}
        </div>
      )}

      {/* Task info */}
      {session.taskId && (
        <div className="mb-1.5 text-xs text-fg-muted line-clamp-1">
          <span className="font-mono text-done">#{session.taskId.slice(0, 7)}</span>
          {session.taskTitle && <span className="opacity-70"> {session.taskTitle}</span>}
        </div>
      )}

      {/* Session title (if no task) */}
      {!session.taskId && session.title && (
        <div className="mb-1.5 text-xs text-fg-muted line-clamp-1">{session.title}</div>
      )}

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
        {/* Duration */}
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {session.duration != null
            ? formatDuration(session.duration)
            : isActive
              ? 'In progress'
              : formatRelativeTime(session.createdAt)}
        </span>

        {/* Turns */}
        <span className="flex items-center gap-1">
          <ChatCircle className="h-3 w-3" />
          {session.turnsUsed}/50
        </span>

        {/* Tokens */}
        {session.tokensUsed > 0 && (
          <span className="flex items-center gap-1">
            <Coins className="h-3 w-3" />
            {formatTokens(session.tokensUsed)}
          </span>
        )}

        {/* Execution badge */}
        <ExecutionBadge
          sandboxProvider={session.sandboxProvider}
          sandboxContainerId={session.sandboxContainerId}
          size="compact"
        />

        {/* Status badge */}
        <span
          className={cn(
            'ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium',
            statusColors.badge,
            statusColors.text
          )}
        >
          {session.status === 'closed' || session.status === 'error'
            ? session.status === 'error'
              ? 'Failed'
              : 'Success'
            : session.status.charAt(0).toUpperCase() + session.status.slice(1)}
        </span>
      </div>
    </button>
  );
}
