import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowsClockwise,
  BookOpen,
  CheckCircle,
  Lightning,
  Square,
  Warning,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react';
import React, { useCallback } from 'react';
import { ExecutionBadge } from '@/app/components/ui/execution-badge';
import { PriorityIcon } from '@/app/components/ui/priority-icon';
import type { AgentStatusInfo } from '@/app/hooks/use-container-agent-statuses';
import type { Task } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { formatRelativeTime } from '@/lib/utils/format-time';
import { LABEL_TYPES, type Priority } from './constants';
import { agentStatusVariants, cardVariants, labelVariants, lastRunStatusVariants } from './styles';

interface KanbanCardProps {
  /** Task data */
  task: Task;
  /** Whether card is selected */
  isSelected: boolean;
  /** Whether card is being dragged */
  isDragging: boolean;
  /** Callback for selection */
  onSelect: (multiSelect: boolean) => void;
  /** Callback to open task detail */
  onOpen: () => void;
  /** Callback to run the task immediately (moves to in_progress and triggers agent) */
  onRunNow?: () => void;
  /** Callback to stop a running agent */
  onStop?: () => void;
  /** Callback to cancel an in-progress task (stop agent + move to backlog) */
  onCancel?: () => void;
  /** Real-time agent status info */
  agentStatus?: AgentStatusInfo;
}

/**
 * Get the label type for styling
 */
function getLabelType(label: string): 'bug' | 'feature' | 'enhancement' | 'docs' | 'default' {
  const normalized = label.toLowerCase();
  const mapping = LABEL_TYPES as Record<string, string>;
  const mapped = mapping[normalized];
  if (mapped === 'bug') return 'bug';
  if (mapped === 'feature') return 'feature';
  if (mapped === 'enhancement') return 'enhancement';
  if (mapped === 'docs') return 'docs';
  return 'default';
}

/**
 * Extract priority from task
 */
function getPriority(task: Task): Priority {
  return (task.priority as Priority) ?? 'medium';
}

/**
 * Format task ID for display
 */
function formatTaskId(id: string): string {
  return `#TSK-${id.slice(-3).toUpperCase()}`;
}

/**
 * Get icon and label for last agent run status
 */
function getLastRunStatusInfo(status: Task['lastAgentStatus']): {
  icon: React.ReactNode;
  label: string;
} | null {
  if (!status) return null;

  switch (status) {
    case 'completed':
      return { icon: <CheckCircle className="w-3 h-3" weight="fill" />, label: 'Completed' };
    case 'cancelled':
      return { icon: <XCircle className="w-3 h-3" weight="fill" />, label: 'Cancelled' };
    case 'error':
      return { icon: <WarningCircle className="w-3 h-3" weight="fill" />, label: 'Error' };
    case 'turn_limit':
      return { icon: <Warning className="w-3 h-3" weight="fill" />, label: 'Turn limit' };
    case 'planning':
      return { icon: <Lightning className="w-3 h-3" weight="fill" />, label: 'Plan ready' };
    case 'agent_reviewing':
      return {
        icon: <ArrowsClockwise className="w-3 h-3 animate-spin" weight="bold" />,
        label: 'Agent reviewing',
      };
    default:
      return null;
  }
}

/** Map stage to display label (fallback when statusMessage is not available) */
const stageLabels: Record<string, string> = {
  initializing: 'Initializing...',
  validating: 'Validating...',
  credentials: 'Auth...',
  injecting_skills: 'Injecting Skills...',
  creating_sandbox: 'Creating Sandbox...',
  executing: 'Starting...',
  running: 'Running',
};

/** Derive display text from agent status — prefer statusMessage for phase-aware labels */
function getAgentStageLabel(agentStatus?: AgentStatusInfo): string {
  if (!agentStatus?.currentStage) return 'Agent running...';
  // Use statusMessage when available — it contains phase info like "Planning..." or "Executing..."
  if (agentStatus.statusMessage) return agentStatus.statusMessage;
  return stageLabels[agentStatus.currentStage] ?? 'Starting...';
}

export const KanbanCard = React.memo(function KanbanCard({
  task,
  isSelected,
  isDragging,
  onSelect,
  onOpen,
  onRunNow,
  onStop,
  onCancel,
  agentStatus,
}: KanbanCardProps): React.JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: sortableIsDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // All hooks must be called before any early return
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(e.metaKey || e.ctrlKey);
    },
    [onSelect]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpen();
    },
    [onOpen]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onOpen();
      } else if (e.key === ' ') {
        e.preventDefault();
        onSelect(e.metaKey || e.ctrlKey);
      }
    },
    [onOpen, onSelect]
  );

  const handleRunNow = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRunNow?.();
    },
    [onRunNow]
  );

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onStop?.();
    },
    [onStop]
  );

  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCancel?.();
    },
    [onCancel]
  );

  // Render ghost placeholder when this card is being dragged
  if (sortableIsDragging) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="relative rounded-md border-2 border-dashed border-primary/20 bg-primary/5 min-h-[100px] w-full"
      />
    );
  }

  const cardState =
    isDragging || sortableIsDragging ? 'dragging' : isSelected ? 'selected' : 'default';

  const priority = getPriority(task);
  const labels = task.labels ?? [];
  const canRunNow = task.column === 'backlog' && onRunNow;
  const lastRunStatus = getLastRunStatusInfo(task.lastAgentStatus);
  // Agent is running if in_progress with a session/agent, but NOT if lastAgentStatus
  // already indicates a terminal state (completed, error, cancelled, etc.)
  const isAgentRunning =
    task.column === 'in_progress' &&
    (Boolean(task.agentId) || Boolean(task.sessionId)) &&
    !lastRunStatus;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cardVariants({ state: cardState })}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      aria-grabbed={isDragging || sortableIsDragging}
      {...attributes}
      {...listeners}
    >
      {/* Labels */}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {labels.map((label) => (
            <span key={label} className={labelVariants({ type: getLabelType(label) })}>
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Header with priority and title */}
      <div className="flex items-start gap-2">
        <PriorityIcon priority={priority} className="mt-1" />
        <div className="flex-1 text-sm font-medium leading-snug text-fg">{task.title}</div>
      </div>

      {/* Description preview */}
      {task.description && (
        <p className="mt-1.5 text-xs text-fg-muted line-clamp-2">{task.description}</p>
      )}

      {/* Skill badge */}
      {task.skillName && (
        <div className="mt-2 flex">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-accent">
            <BookOpen className="h-3 w-3" weight="bold" />
            {task.skillName}
          </span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-fg-muted">{formatTaskId(task.id)}</span>
          <span
            className="inline-flex items-center gap-0.5 text-[11px] text-fg-subtle"
            title={`Created: ${new Date(task.createdAt).toLocaleString()}`}
          >
            Created {formatRelativeTime(task.createdAt)}
          </span>
          {task.updatedAt !== task.createdAt && (
            <span
              className="inline-flex items-center gap-0.5 text-[11px] text-fg-muted"
              title={`Updated: ${new Date(task.updatedAt).toLocaleString()}`}
            >
              Updated {formatRelativeTime(task.updatedAt)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Last run status badge (only show when not running) */}
          {lastRunStatus && !isAgentRunning && (
            <div className={lastRunStatusVariants({ status: task.lastAgentStatus })}>
              {lastRunStatus.icon}
              <span>{lastRunStatus.label}</span>
            </div>
          )}

          {/* Run Now button for backlog tasks */}
          {canRunNow && (
            <button
              type="button"
              onClick={handleRunNow}
              className={cn(
                // Base layout - compact pill shape
                'group/run relative inline-flex items-center gap-1.5',
                'h-6 px-2.5 rounded-full',
                // Typography
                'text-[11px] font-medium tracking-wide',
                // Colors - Claude brand accent
                'bg-claude-subtle text-claude',
                'border border-claude/20',
                // Hover state - energetic glow
                'hover:bg-claude-muted hover:border-claude/40',
                'hover:shadow-[0_0_12px_rgba(217,119,87,0.25)]',
                // Active state
                'active:scale-[0.97] active:shadow-none',
                // Focus ring
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-subtle',
                // Smooth transitions
                'transition-all duration-150 ease-out'
              )}
              aria-label="Run task now"
            >
              <Lightning
                className="w-3 h-3 transition-transform duration-150 group-hover/run:scale-110"
                weight="fill"
              />
              <span>Run</span>
            </button>
          )}
        </div>
      </div>

      {/* Agent Status Badge with real-time status */}
      {isAgentRunning && (
        <div className={agentStatusVariants({ status: 'running' })}>
          <div className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
          <span className="flex-1 truncate">{getAgentStageLabel(agentStatus)}</span>
          <ExecutionBadge
            sandboxProvider={agentStatus?.sandboxProvider}
            sandboxContainerId={agentStatus?.sandboxContainerId}
            size="compact"
          />
          {onStop && (
            <button
              type="button"
              onClick={handleStop}
              className="rounded p-0.5 transition-colors hover:bg-attention/20 active:scale-95"
              title="Stop agent"
              data-testid="stop-agent-button"
            >
              <Square className="h-3 w-3" weight="fill" />
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              onClick={handleCancel}
              className="rounded p-0.5 transition-colors hover:bg-danger/20 text-danger active:scale-95"
              title="Cancel task"
              data-testid="cancel-task-button"
            >
              <X className="h-3 w-3" weight="bold" />
            </button>
          )}
        </div>
      )}
    </article>
  );
});
