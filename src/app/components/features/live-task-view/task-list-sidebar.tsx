import {
  CaretDown,
  CaretUp,
  CheckCircle,
  Eye,
  EyeSlash,
  FunnelSimple,
  Lightning,
  MagnifyingGlass,
  Warning,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import {
  agentStatusVariants,
  lastRunStatusVariants,
} from '@/app/components/features/kanban-board/styles';
import { PriorityIcon } from '@/app/components/ui/priority-icon';
import { useLocalStorage } from '@/app/hooks/use-local-storage';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';

// =============================================================================
// Types
// =============================================================================

interface TaskItem {
  id: string;
  title: string;
  column: string; // 'backlog' | 'queued' | 'in_progress' | 'waiting_approval' | 'done' | 'verified'
  priority?: 'low' | 'medium' | 'high';
  agentId?: string | null;
  sessionId?: string | null;
  lastAgentStatus?: string | null;
  labels?: string[] | null;
}

interface TaskListSidebarProps {
  tasks: TaskItem[];
  selectedTaskId: string | null;
  onTaskSelect: (taskId: string) => void;
  onSelectedTaskHidden?: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Sort weight per column — lower values float to the top. */
const columnSortOrder: Record<string, number> = {
  in_progress: 0,
  waiting_approval: 1,
  queued: 2,
  backlog: 3,
  done: 4,
  verified: 4,
};

/** Column filter chip definitions with their visual styles. */
const FILTER_COLUMNS = [
  {
    id: 'backlog',
    label: 'Backlog',
    dotColor: 'bg-fg-subtle',
    activeClass: 'bg-fg-subtle/15 text-fg-muted border-fg-subtle/30',
  },
  {
    id: 'queued',
    label: 'Queued',
    dotColor: 'bg-accent',
    activeClass: 'bg-accent/15 text-accent border-accent/30',
  },
  {
    id: 'in_progress',
    label: 'Active',
    dotColor: 'bg-success',
    activeClass: 'bg-success/15 text-success border-success/30',
  },
  {
    id: 'waiting_approval',
    label: 'Review',
    dotColor: 'bg-attention',
    activeClass: 'bg-attention/15 text-attention border-attention/30',
  },
  {
    id: 'verified',
    label: 'Done',
    dotColor: 'bg-done',
    activeClass: 'bg-done/15 text-done border-done/30',
  },
] as const;

/** Completed column identifiers (codebase uses both 'done' and 'verified'). */
const COMPLETED_COLUMNS = new Set(['done', 'verified']);

/** Priority label mapping. */
const priorityLabels: Record<string, string> = {
  high: 'P0',
  medium: 'P1',
  low: 'P2',
};

/** Get icon and label for last agent run status (same as kanban-card.tsx) */
function getLastRunStatusInfo(status: string | null | undefined): {
  icon: React.ReactNode;
  label: string;
  status: 'completed' | 'cancelled' | 'error' | 'turn_limit' | 'planning';
} | null {
  if (!status) return null;
  switch (status) {
    case 'completed':
      return {
        icon: <CheckCircle className="w-3 h-3" weight="fill" />,
        label: 'Completed',
        status: 'completed',
      };
    case 'cancelled':
      return {
        icon: <XCircle className="w-3 h-3" weight="fill" />,
        label: 'Cancelled',
        status: 'cancelled',
      };
    case 'error':
      return {
        icon: <WarningCircle className="w-3 h-3" weight="fill" />,
        label: 'Error',
        status: 'error',
      };
    case 'turn_limit':
      return {
        icon: <Warning className="w-3 h-3" weight="fill" />,
        label: 'Turn limit',
        status: 'turn_limit',
      };
    case 'planning':
      return {
        icon: <Lightning className="w-3 h-3" weight="fill" />,
        label: 'Plan ready',
        status: 'planning',
      };
    default:
      return null;
  }
}

/** Format task ID for display (same as kanban-card.tsx) */
function formatTaskId(id: string): string {
  return `#TSK-${id.slice(-3).toUpperCase()}`;
}

// =============================================================================
// Component
// =============================================================================

type SortOption = 'status' | 'priority' | 'name';

const prioritySortOrder: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function TaskListSidebar({
  tasks,
  selectedTaskId,
  onTaskSelect,
  onSelectedTaskHidden,
  searchQuery,
  onSearchChange,
}: TaskListSidebarProps): React.JSX.Element {
  const [sortBy, setSortBy] = useState<SortOption>('status');
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useLocalStorage('live-task-view:show-completed', false);

  /** Column counts computed from the full unfiltered task list. */
  const columnCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      // Normalise 'done' → 'verified' so counts merge under the chip id
      const key = task.column === 'done' ? 'verified' : task.column;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [tasks]);

  /** Toggle a column filter chip on/off. */
  function toggleFilter(columnId: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        next.add(columnId);
      }
      return next;
    });
  }

  const filteredAndSorted = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();

    const filtered = tasks.filter((t) => {
      // 1. Text search filter
      if (query && !t.title.toLowerCase().includes(query)) return false;

      // Normalise column for filter comparison
      const col = t.column === 'done' ? 'verified' : t.column;

      // 2. Column chip filter
      if (activeFilters.size > 0 && !activeFilters.has(col)) return false;

      // 3. Auto-hide completed tasks (unless user toggled show or explicitly selected the Done chip)
      if (!showCompleted && !activeFilters.has('verified') && COMPLETED_COLUMNS.has(t.column)) {
        return false;
      }

      return true;
    });

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'status':
          return (columnSortOrder[a.column] ?? 99) - (columnSortOrder[b.column] ?? 99);
        case 'priority':
          return (
            (prioritySortOrder[a.priority ?? ''] ?? 99) -
            (prioritySortOrder[b.priority ?? ''] ?? 99)
          );
        case 'name':
          return a.title.localeCompare(b.title);
        default:
          return 0;
      }
    });
  }, [tasks, searchQuery, sortBy, activeFilters, showCompleted]);

  useWatchEffect(() => {
    if (!selectedTaskId) return;

    const isSelectedTaskVisible = filteredAndSorted.some((task) => task.id === selectedTaskId);
    if (!isSelectedTaskVisible) {
      onSelectedTaskHidden?.();
    }
  }, [filteredAndSorted, onSelectedTaskHidden, selectedTaskId]);

  return (
    <aside className="flex h-full w-[252px] shrink-0 flex-col border-r border-border bg-surface">
      {/* Header */}
      <div className="border-b border-border px-3 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Tasks
          </span>
          {/* Sort control */}
          <div className="flex items-center gap-1">
            <FunnelSimple size={12} className="text-fg-subtle" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="appearance-none bg-transparent text-[10px] font-medium text-fg-muted outline-none cursor-pointer hover:text-fg transition-colors"
            >
              <option value="status">Status</option>
              <option value="priority">Priority</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-2">
          <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tasks…"
            className="w-full rounded-md border border-border bg-surface-subtle py-1.5 pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none transition-colors duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
          />
        </div>

        {/* Filter chips */}
        <div className="mt-2 flex flex-wrap gap-1">
          {FILTER_COLUMNS.map((col) => {
            const isActive = activeFilters.has(col.id);
            const count = columnCounts[col.id] ?? 0;
            return (
              <button
                key={col.id}
                type="button"
                onClick={() => toggleFilter(col.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all duration-150',
                  isActive
                    ? col.activeClass
                    : 'border-transparent bg-surface-subtle text-fg-subtle hover:bg-surface-emphasis hover:text-fg-muted'
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', col.dotColor)} />
                {col.label}
                {count > 0 && <span className="ml-0.5 text-[9px] opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
        {filteredAndSorted.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs text-fg-muted">No tasks found</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredAndSorted.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                isSelected={task.id === selectedTaskId}
                onSelect={onTaskSelect}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="text-[10px] text-fg-subtle">
          {filteredAndSorted.length} {filteredAndSorted.length === 1 ? 'task' : 'tasks'}
        </span>

        {/* Done toggle */}
        <button
          type="button"
          onClick={() => setShowCompleted((prev) => !prev)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-all duration-150',
            showCompleted
              ? 'bg-done/10 text-done'
              : 'text-fg-subtle hover:text-fg-muted hover:bg-surface-subtle'
          )}
        >
          {showCompleted ? <Eye className="h-3 w-3" /> : <EyeSlash className="h-3 w-3" />}
          Done ({columnCounts.verified ?? 0})
        </button>

        <span className="flex items-center gap-1 text-[10px] text-fg-subtle">
          <CaretUp className="h-3 w-3" />
          <CaretDown className="h-3 w-3" />
          navigate
        </span>
      </div>
    </aside>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function TaskCard({
  task,
  isSelected,
  onSelect,
}: {
  task: TaskItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const priority = (task.priority ?? 'medium') as 'high' | 'medium' | 'low';
  const isAgentRunning =
    task.column === 'in_progress' && (Boolean(task.agentId) || Boolean(task.sessionId));
  const lastRunStatus = getLastRunStatusInfo(task.lastAgentStatus);

  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={cn(
        'w-full rounded-md border bg-surface p-3 text-left transition-all duration-150',
        isSelected ? 'border-accent bg-accent-muted' : 'border-border hover:border-fg-subtle'
      )}
    >
      {/* Header: priority icon + title */}
      <div className="flex items-start gap-2">
        <PriorityIcon priority={priority} size={12} className="mt-1" />
        <div className="flex-1 text-sm font-medium leading-snug text-fg truncate">{task.title}</div>
      </div>

      {/* Footer: task ID + status badge */}
      <div className="flex items-center justify-between mt-2">
        <span className="font-mono text-xs text-fg-muted">{formatTaskId(task.id)}</span>

        {/* Last run status (matches kanban card) */}
        {lastRunStatus && !isAgentRunning && (
          <div className={lastRunStatusVariants({ status: lastRunStatus.status })}>
            {lastRunStatus.icon}
            <span>{lastRunStatus.label}</span>
          </div>
        )}

        {/* Priority label */}
        {!lastRunStatus && !isAgentRunning && (
          <span className="text-[10px] font-medium text-fg-subtle">
            {priorityLabels[priority] ?? 'P1'}
          </span>
        )}
      </div>

      {/* Agent running indicator (matches kanban card) */}
      {isAgentRunning && (
        <div className={agentStatusVariants({ status: 'running' })}>
          <div className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
          <span>Agent running...</span>
        </div>
      )}
    </button>
  );
}
