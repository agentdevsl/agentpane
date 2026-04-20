import { Circle, Copy, Robot, User, X } from '@phosphor-icons/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva } from 'class-variance-authority';
import { useState } from 'react';
import type { Task, TaskColumn } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import type { TaskViewer } from './index';

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider',
  {
    variants: {
      column: {
        backlog: 'bg-surface-muted/80 text-fg-muted border border-border/50',
        queued: 'bg-secondary-muted text-secondary border border-secondary/20',
        in_progress: 'bg-accent-muted text-accent border border-accent/20',
        waiting_approval: 'bg-attention-muted text-attention border border-attention/20',
        verified: 'bg-success-muted text-success border border-success/20',
      },
    },
    defaultVariants: {
      column: 'backlog',
    },
  }
);

const priorityVariants = cva(
  cn(
    'relative inline-flex h-8 items-center justify-center gap-1.5 px-3',
    'text-[11px] font-semibold uppercase tracking-wider',
    'transition-all duration-200 ease-out cursor-pointer',
    'border-y first:border-l first:rounded-l-md last:border-r last:rounded-r-md',
    'hover:z-10'
  ),
  {
    variants: {
      priority: {
        high: 'border-danger/20 text-danger/70 hover:text-danger hover:bg-danger/10',
        medium: 'border-attention/20 text-attention/70 hover:text-attention hover:bg-attention/10',
        low: 'border-success/20 text-success/70 hover:text-success hover:bg-success/10',
      },
      selected: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      {
        priority: 'high',
        selected: true,
        className: 'bg-danger/15 text-danger shadow-[inset_0_-2px_0_0_var(--danger-fg)]',
      },
      {
        priority: 'medium',
        selected: true,
        className: 'bg-attention/15 text-attention shadow-[inset_0_-2px_0_0_var(--attention-fg)]',
      },
      {
        priority: 'low',
        selected: true,
        className: 'bg-success/15 text-success shadow-[inset_0_-2px_0_0_var(--success-fg)]',
      },
    ],
    defaultVariants: {
      priority: 'medium',
      selected: false,
    },
  }
);

function getColumnLabel(column: TaskColumn): string {
  switch (column) {
    case 'backlog':
      return 'Backlog';
    case 'queued':
      return 'Queued';
    case 'in_progress':
      return 'In Progress';
    case 'waiting_approval':
      return 'Awaiting Review';
    case 'verified':
      return 'Verified';
    default:
      return column;
  }
}

function formatTaskId(id: string): string {
  const shortId = id.slice(-4).toUpperCase();
  return `TSK-${shortId}`;
}

interface TaskHeaderProps {
  task: Task;
  viewers: TaskViewer[];
  onPriorityChange: (priority: 'high' | 'medium' | 'low') => void;
}

export function TaskHeader({
  task,
  viewers,
  onPriorityChange,
}: TaskHeaderProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const currentPriority =
    (task as Task & { priority?: 'high' | 'medium' | 'low' }).priority ?? 'medium';

  const handleCopyId = () => {
    navigator.clipboard.writeText(task.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative flex flex-col gap-4 border-b border-border bg-gradient-to-b from-surface to-surface-subtle p-5">
      {/* Subtle top accent line */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 h-[2px]',
          'bg-gradient-to-r from-transparent via-accent/50 to-transparent'
        )}
      />

      {/* Top row: status, task ID, viewers, close */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Status badge with pulse indicator */}
          <span className={statusBadgeVariants({ column: task.column })}>
            <span className="relative flex h-2 w-2">
              <Circle weight="fill" className="h-2 w-2" />
              {task.column === 'in_progress' && (
                <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-40" />
              )}
            </span>
            {getColumnLabel(task.column)}
          </span>

          {/* Task ID with copy feedback */}
          <button
            type="button"
            onClick={handleCopyId}
            className={cn(
              'group flex items-center gap-1.5 px-2 py-1 -ml-2 rounded-md',
              'font-mono text-[11px] font-medium tracking-wide',
              'text-fg-subtle hover:text-fg-muted hover:bg-surface-muted/50',
              'transition-all duration-150'
            )}
            title="Copy full task ID"
          >
            <span className="opacity-50">#</span>
            <span>{formatTaskId(task.id)}</span>
            <Copy
              className={cn(
                'h-3 w-3 transition-all duration-150',
                copied ? 'text-success opacity-100 scale-110' : 'opacity-0 group-hover:opacity-60'
              )}
            />
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Viewers avatar stack */}
          {viewers.length > 0 && (
            <div className="flex items-center -space-x-2">
              {viewers.slice(0, 3).map((viewer, idx) => (
                <div
                  key={viewer.userId}
                  style={{ zIndex: 3 - idx }}
                  className={cn(
                    'relative h-7 w-7 rounded-full',
                    'border-2 border-surface bg-accent-muted',
                    'flex items-center justify-center',
                    'ring-2 ring-surface',
                    'transition-transform hover:scale-110 hover:z-10'
                  )}
                  title={viewer.displayName}
                >
                  {viewer.avatarUrl ? (
                    <img
                      src={viewer.avatarUrl}
                      alt={viewer.displayName}
                      className="h-full w-full rounded-full object-cover"
                    />
                  ) : (
                    <span className="text-[10px] font-semibold text-accent">
                      {viewer.displayName.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
              ))}
              {viewers.length > 3 && (
                <div
                  className={cn(
                    'relative h-7 w-7 rounded-full',
                    'border-2 border-surface bg-surface-emphasis',
                    'flex items-center justify-center',
                    'ring-2 ring-surface'
                  )}
                >
                  <span className="text-[10px] font-semibold text-fg-muted">
                    +{viewers.length - 3}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Close button */}
          <DialogPrimitive.Close
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg',
              'text-fg-muted hover:text-fg-default',
              'hover:bg-surface-muted/80 active:bg-surface-emphasis',
              'transition-all duration-150',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            )}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
      </div>

      {/* Title - larger, bolder */}
      <h2 className="text-xl font-bold tracking-tight text-fg leading-tight pr-8">{task.title}</h2>

      {/* Controls row: Priority and Approval Mode */}
      <div className="flex items-end justify-between gap-6 pt-1">
        {/* Priority selector - segmented control style */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">
            Priority
          </span>
          <div className="flex items-center">
            {(['high', 'medium', 'low'] as const).map((priority) => (
              <button
                key={priority}
                type="button"
                onClick={() => onPriorityChange(priority)}
                className={priorityVariants({
                  priority,
                  selected: currentPriority === priority,
                })}
              >
                {priority === 'high' && '●'}
                {priority === 'medium' && '◐'}
                {priority === 'low' && '○'}
                <span className="ml-1">{priority}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Approval mode indicator */}
        {task.approvalMode && (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">
              Approval
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider',
                task.approvalMode === 'human'
                  ? 'bg-done-muted text-done border border-done/20'
                  : 'bg-attention-muted text-attention border border-attention/20'
              )}
            >
              {task.approvalMode === 'human' ? (
                <User className="h-3.5 w-3.5" weight="bold" />
              ) : (
                <Robot className="h-3.5 w-3.5" weight="bold" />
              )}
              {task.approvalMode === 'human' ? 'Human' : 'Auto'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
