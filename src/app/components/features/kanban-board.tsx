import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  defaultDropAnimationSideEffects,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { ArrowsDownUp, CheckSquare, Trash } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useContainerAgentStatuses } from '@/app/hooks/use-container-agent-statuses';
import type { Task, TaskColumn } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { COLUMNS } from './kanban-board/constants';
import { useBoardState } from './kanban-board/use-board-state';
import { KanbanCard } from './kanban-card';
import { KanbanColumn } from './kanban-column';

// Configure smooth drop animation for better visual feedback
const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.5',
      },
    },
  }),
};

interface KanbanBoardProps {
  tasks: Task[];
  onTaskMove: (taskId: string, column: TaskColumn, position: number) => Promise<void>;
  onTaskClick: (task: Task) => void;
  onBulkMove?: (taskIds: string[], column: TaskColumn) => Promise<void>;
  onBulkDelete?: (taskIds: string[]) => Promise<void>;
  onAddTask?: (column: TaskColumn) => void;
  /** Callback to run a task immediately (moves to in_progress and triggers agent) */
  onRunNow?: (taskId: string) => void;
  /** Callback to stop a running agent */
  onStopAgent?: (taskId: string) => void;
  /** Custom header action for backlog column (e.g., AI create button) */
  backlogHeaderAction?: React.ReactNode;
  isLoading?: boolean;
}

export function KanbanBoard({
  tasks,
  onTaskMove,
  onTaskClick,
  onBulkMove,
  onBulkDelete,
  onAddTask,
  onRunNow,
  onStopAgent,
  backlogHeaderAction,
  isLoading,
}: KanbanBoardProps): React.JSX.Element {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const [{ selectedIds }, boardActions] = useBoardState();

  // Get sessions from in-progress tasks for real-time status tracking
  const activeSessions = useMemo(() => {
    return tasks
      .filter((t) => t.column === 'in_progress' && t.sessionId)
      .map((t) => ({ sessionId: t.sessionId as string, taskId: t.id }));
  }, [tasks]);

  // Track agent statuses for active sessions
  const agentStatuses = useContainerAgentStatuses(activeSessions);
  const {
    toggleSelection,
    selectAll,
    clearSelection,
    isSelected,
    toggleColumnCollapse,
    isColumnCollapsed,
  } = boardActions;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((item) => item.id === event.active.id);
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) {
      return;
    }

    const taskId = String(active.id);
    const overId = String(over.id);

    const columnMatch = COLUMNS.find((column) => column.id === overId);
    if (columnMatch) {
      const position = tasks.filter((task) => task.column === columnMatch.id).length;
      void onTaskMove(taskId, columnMatch.id, position);
      return;
    }

    const overTask = tasks.find((task) => task.id === overId);
    if (!overTask) {
      return;
    }

    void onTaskMove(taskId, overTask.column, overTask.position ?? 0);
  };

  const tasksByColumn = useMemo(() => {
    const grouped = new Map<TaskColumn, Task[]>();
    for (const col of COLUMNS) {
      grouped.set(
        col.id,
        tasks
          .filter((task) => task.column === col.id)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      );
    }
    return grouped;
  }, [tasks]);

  const handleSelectAll = () => {
    selectAll(tasks);
  };

  const handleBulkMove = async (targetColumn: TaskColumn) => {
    if (onBulkMove && selectedIds.size > 0) {
      await onBulkMove([...selectedIds], targetColumn);
      clearSelection();
    }
  };

  const handleBulkDelete = async () => {
    if (onBulkDelete && selectedIds.size > 0) {
      await onBulkDelete([...selectedIds]);
      clearSelection();
    }
  };

  const selectionCount = selectedIds.size;
  const hasSelection = selectionCount > 0;

  return (
    <div className="flex h-full flex-col" data-testid="kanban-board">
      {/* Bulk actions toolbar */}
      {hasSelection && (
        <div className="flex items-center gap-3 border-b border-[var(--border-default)] bg-[var(--bg-subtle)] px-6 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSelectAll}
              className="flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-default)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--fg-default)]"
            >
              <CheckSquare className="h-3.5 w-3.5" />
              Select All
            </button>
            <span className="px-2 text-xs text-[var(--fg-muted)]">{selectionCount} selected</span>
          </div>

          <div className="h-6 w-px bg-[var(--border-default)]" />

          <div className="flex items-center gap-2">
            {/* Move to dropdown */}
            <div className="group relative">
              <button
                type="button"
                className="flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-default)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-muted)] hover:text-[var(--fg-default)]"
              >
                <ArrowsDownUp className="h-3.5 w-3.5" />
                Move to...
              </button>
              <div className="invisible absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-[var(--border-default)] bg-[var(--bg-default)] py-1 opacity-0 shadow-lg transition-all group-hover:visible group-hover:opacity-100">
                {COLUMNS.map((col) => (
                  <button
                    key={col.id}
                    type="button"
                    onClick={() => void handleBulkMove(col.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--fg-default)] transition-colors hover:bg-[var(--bg-subtle)]"
                  >
                    <div className={cn('h-2 w-2 rounded-full', col.indicatorColor)} />
                    {col.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Delete button */}
            {onBulkDelete && (
              <button
                type="button"
                onClick={() => void handleBulkDelete()}
                className="flex items-center gap-1.5 rounded border border-[var(--border-default)] bg-[var(--bg-default)] px-2.5 py-1.5 text-xs font-medium text-[var(--fg-muted)] transition-colors hover:border-[var(--danger-fg)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger-fg)]"
              >
                <Trash className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
          </div>

          <div className="ml-auto">
            <button
              type="button"
              onClick={clearSelection}
              className="text-xs text-[var(--fg-muted)] transition-colors hover:text-[var(--fg-default)]"
            >
              Clear selection
            </button>
          </div>
        </div>
      )}

      {/* Kanban columns */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-1 gap-4 overflow-x-auto overflow-y-hidden p-5">
          {COLUMNS.map((column) => (
            <KanbanColumn
              key={column.id}
              id={column.id}
              title={column.label}
              tasks={tasksByColumn.get(column.id) ?? []}
              onTaskClick={onTaskClick}
              onTaskSelect={toggleSelection}
              isTaskSelected={isSelected}
              isLoading={isLoading}
              isCollapsed={isColumnCollapsed(column.id)}
              onToggleCollapse={() => toggleColumnCollapse(column.id)}
              onAddTask={onAddTask ? () => onAddTask(column.id) : undefined}
              onRunNow={onRunNow}
              onStopAgent={onStopAgent}
              headerAction={column.id === 'backlog' ? backlogHeaderAction : undefined}
              config={column}
              agentStatuses={agentStatuses}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={dropAnimation}>
          {activeTask ? (
            <div className="rotate-3 opacity-90">
              <div className="shadow-xl">
                <KanbanCard task={activeTask} isDragging />
              </div>
              {/* Show count badge if multiple selected */}
              {selectedIds.size > 1 && selectedIds.has(activeTask.id) && (
                <div className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-emphasis)] text-xs font-bold text-white">
                  {selectedIds.size}
                </div>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// Re-export types and constants for convenience
export { COLUMNS } from './kanban-board/constants';
export { useBoardState } from './kanban-board/use-board-state';
