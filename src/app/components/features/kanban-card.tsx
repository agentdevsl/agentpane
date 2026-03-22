import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  BookOpen,
  CheckCircle,
  Circle,
  DotsSixVertical,
  Lightning,
  Spinner,
  Square,
  User,
  Warning,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import type { Task } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import {
  formatTaskId,
  getLabelColors,
  PRIORITY_CONFIG,
  type Priority,
} from './kanban-board/constants';

const cardVariants = cva(
  'group relative cursor-pointer rounded-md border bg-[var(--bg-subtle)] p-3 text-left transition-all duration-150 ease-out',
  {
    variants: {
      isDragging: {
        true: 'opacity-50',
        false: 'hover:border-[var(--fg-subtle)]',
      },
      isSelected: {
        true: 'border-[var(--accent-fg)] bg-[var(--accent-muted)]',
        false: 'border-[var(--border-default)]',
      },
      hasAgent: {
        true: '',
        false: '',
      },
    },
    defaultVariants: {
      isDragging: false,
      isSelected: false,
      hasAgent: false,
    },
  }
);

/**
 * Last agent run status styling
 */
const LAST_RUN_STATUS_CONFIG: Record<
  NonNullable<Task['lastAgentStatus']>,
  { icon: React.ReactNode; label: string; className: string }
> = {
  completed: {
    icon: <CheckCircle className="h-3 w-3" weight="fill" />,
    label: 'Completed',
    className: 'bg-[var(--done-muted)] text-[var(--done-fg)]',
  },
  cancelled: {
    icon: <XCircle className="h-3 w-3" weight="fill" />,
    label: 'Cancelled',
    className: 'bg-[var(--bg-muted)] text-[var(--fg-muted)]',
  },
  error: {
    icon: <WarningCircle className="h-3 w-3" weight="fill" />,
    label: 'Error',
    className: 'bg-[var(--danger-muted)] text-[var(--danger-fg)]',
  },
  turn_limit: {
    icon: <Warning className="h-3 w-3" weight="fill" />,
    label: 'Turn limit',
    className: 'bg-[var(--attention-muted)] text-[var(--attention-fg)]',
  },
  planning: {
    icon: <Lightning className="h-3 w-3" weight="fill" />,
    label: 'Plan ready',
    className: 'bg-[var(--secondary-muted)] text-[var(--secondary-fg)]',
  },
};

/** Stage labels for status display */
const STAGE_LABELS: Record<string, string> = {
  initializing: 'Initializing...',
  validating: 'Validating...',
  credentials: 'Auth...',
  injecting_skills: 'Injecting Skills...',
  creating_sandbox: 'Creating Sandbox...',
  executing: 'Starting...',
  running: 'Running',
};

/**
 * Determine which badge to show on a card. Returns exactly one kind,
 * making mutual exclusivity explicit and testable.
 */
type BadgeKind = 'running' | 'waiting-approval' | 'last-run' | 'none';

function getCardBadgeKind(task: Task): BadgeKind {
  if (task.column === 'in_progress' && (task.agentId || task.sessionId)) return 'running';
  if (task.column === 'waiting_approval') return 'waiting-approval';
  if (task.lastAgentStatus && task.lastAgentStatus in LAST_RUN_STATUS_CONFIG) return 'last-run';
  return 'none';
}

/** Agent status info from real-time subscription */
interface AgentStatusInfo {
  currentStage?: string;
  statusMessage?: string;
  isStarting?: boolean;
  isRunning?: boolean;
}

interface KanbanCardProps {
  task: Task;
  onClick?: () => void;
  onSelect?: (taskId: string, isMultiSelect: boolean) => void;
  isDragging?: boolean;
  isSelected?: boolean;
  priority?: Priority;
  /** Callback to run the task immediately (only shown in backlog) */
  onRunNow?: () => void;
  /** Callback to stop a running agent */
  onStop?: () => void;
  /** Real-time agent status (from container agent) */
  agentStatus?: AgentStatusInfo;
}

export function KanbanCard({
  task,
  onClick,
  onSelect,
  isDragging: isDraggingProp,
  isSelected = false,
  priority,
  onRunNow,
  onStop,
  agentStatus,
}: KanbanCardProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Multi-select mode
      e.preventDefault();
      e.stopPropagation();
      onSelect?.(task.id, true);
    } else {
      onClick?.();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        onSelect?.(task.id, true);
      } else {
        onClick?.();
      }
    }
  };

  const taskPriority = (task.priority as Priority) ?? priority ?? 'medium';
  const priorityConfig = PRIORITY_CONFIG[taskPriority];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit provides role via attributes spread
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        cardVariants({
          isDragging: isDraggingProp ?? isDragging,
          isSelected,
          hasAgent: Boolean(task.agentId),
        }),
        'touch-none' // Prevent scroll interference during drag
      )}
      {...attributes}
      {...listeners}
      data-testid="task-card"
      data-selected={isSelected ? 'true' : undefined}
      data-queued={task.column === 'in_progress' && !task.agentId ? 'true' : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Labels row */}
      {task.labels && task.labels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid="task-labels">
          {task.labels.map((label) => {
            const colors = getLabelColors(label);
            return (
              <span
                key={label}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
                  colors.bg,
                  colors.text
                )}
                data-testid="task-label"
              >
                {label}
              </span>
            );
          })}
        </div>
      )}

      {/* Header with priority and title */}
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-1 flex-shrink-0 cursor-grab text-[var(--fg-subtle)] opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100"
          data-testid="drag-handle"
          aria-label="Drag to reorder"
          {...listeners}
        >
          <DotsSixVertical className="h-4 w-4" />
        </button>

        <div
          className={cn(
            'mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ring-1 ring-black/10',
            priorityConfig.color
          )}
          title={`${priorityConfig.label} priority`}
          data-testid="priority-indicator"
        />

        <div className="min-w-0 flex-1">
          <p
            className="text-sm font-medium leading-snug text-[var(--fg-default)]"
            data-testid="task-card-title"
          >
            {task.title}
          </p>
        </div>
      </div>

      {/* Skill badge */}
      {task.skillName && (
        <div className="mt-2 flex" data-testid="task-skill-badge">
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-fg)]">
            <BookOpen className="h-3 w-3" weight="bold" />
            {task.skillName}
          </span>
        </div>
      )}

      {/* Footer with ID, status badges, and run button */}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-[var(--fg-muted)]" data-testid="task-id">
          {formatTaskId(task.id)}
        </span>

        <div className="flex items-center gap-1.5">
          {/* Status badge — exactly one of: last-run, running, waiting-approval, or none */}
          {(() => {
            const badgeKind = getCardBadgeKind(task);
            if (badgeKind === 'last-run') {
              // biome-ignore lint/style/noNonNullAssertion: lastAgentStatus is guaranteed when badgeKind is 'last-run'
              const config = LAST_RUN_STATUS_CONFIG[task.lastAgentStatus!];
              return (
                <div
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    config.className
                  )}
                  data-testid="last-run-status"
                >
                  {config.icon}
                  <span>{config.label}</span>
                </div>
              );
            }
            if (badgeKind === 'running') {
              return (
                <div
                  className="flex items-center gap-1.5 rounded bg-[var(--attention-muted)] px-2 py-1 text-xs text-[var(--attention-fg)]"
                  data-testid="agent-status-indicator"
                >
                  {agentStatus?.isStarting ? (
                    <Spinner className="h-3 w-3 animate-spin" />
                  ) : (
                    <Circle weight="fill" className="h-1.5 w-1.5 animate-pulse" />
                  )}
                  <span>
                    {agentStatus?.currentStage
                      ? (STAGE_LABELS[agentStatus.currentStage] ?? agentStatus.currentStage)
                      : 'Running'}
                  </span>
                </div>
              );
            }
            if (badgeKind === 'waiting-approval') {
              return (
                <div
                  className="flex items-center gap-1.5 rounded bg-[var(--secondary-muted)] px-2 py-1 text-xs text-[var(--secondary-fg)]"
                  data-testid="waiting-approval-indicator"
                >
                  <User className="h-3 w-3" weight="fill" />
                  <span>Waiting Approval</span>
                </div>
              );
            }
            return null;
          })()}

          {/* Run Now button — shown when onRunNow callback is provided */}
          {onRunNow && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRunNow();
              }}
              className={cn(
                // Base layout - compact pill shape
                'group/run relative inline-flex items-center gap-1.5',
                'h-6 px-2.5 rounded-full',
                // Typography
                'text-[11px] font-medium tracking-wide',
                // Colors - Claude brand accent
                'bg-[var(--claude-subtle)] text-[var(--claude)]',
                'border border-[var(--claude)]/20',
                // Hover state - energetic glow
                'hover:bg-[var(--claude-muted)] hover:border-[var(--claude)]/40',
                'hover:shadow-[0_0_12px_rgba(217,119,87,0.25)]',
                // Active state
                'active:scale-[0.97] active:shadow-none',
                // Focus ring
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--claude)]/50 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-subtle)]',
                // Smooth transitions
                'transition-all duration-150 ease-out'
              )}
              data-testid="run-now-button"
              aria-label="Run task now"
            >
              <Lightning
                className="h-3 w-3 transition-transform duration-150 group-hover/run:scale-110"
                weight="fill"
              />
              <span>Run</span>
            </button>
          )}
        </div>
      </div>

      {/* Agent status bar (when running) */}
      {task.agentId && task.column === 'in_progress' && (
        <div
          className="mt-2 flex items-center gap-2 rounded bg-[var(--attention-muted)] px-2 py-1.5 text-xs text-[var(--attention-fg)]"
          data-testid="agent-running-status"
        >
          <Spinner className="h-3 w-3 animate-spin" />
          <span className="flex-1 truncate">Processing...</span>
          {onStop && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStop();
              }}
              className="rounded p-0.5 transition-colors hover:bg-[var(--attention-fg)]/20 active:scale-95"
              title="Stop agent"
              data-testid="stop-agent-button"
            >
              <Square className="h-3 w-3" weight="fill" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
