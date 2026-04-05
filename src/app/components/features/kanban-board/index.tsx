import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
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
import { useCallback, useMemo, useState } from 'react';
import { useContainerAgentStatuses } from '@/app/hooks/use-container-agent-statuses';
import type { Task, TaskColumn } from '@/db/schema';
import { COLUMN_CONFIG, COLUMN_ORDER, VALID_TRANSITIONS } from './constants';
import { DragOverlayCard } from './drag-overlay';
import { KanbanCard } from './kanban-card';
import { KanbanColumn } from './kanban-column';
import { useBoardState } from './use-board-state';

interface KanbanBoardProps {
  /** Tasks to display */
  tasks: Task[];
  /** Callback when task is moved to a different column */
  onTaskMove: (taskId: string, column: TaskColumn, position: number) => Promise<void>;
  /** Callback when task is clicked/opened */
  onTaskClick: (task: Task) => void;
  /** Callback when new task is requested for a column */
  onNewTask?: (column: TaskColumn) => void;
  /** Callback to run a task immediately (moves to in_progress and triggers agent) */
  onRunNow?: (taskId: string) => void;
  /** Custom header action for backlog column (e.g., AI create button) */
  backlogHeaderAction?: React.ReactNode;
  /** Loading state */
  isLoading?: boolean;
}

/**
 * Determine which column a droppable ID belongs to
 */
function getColumnFromDroppableId(id: string, tasks: Task[]): TaskColumn | null {
  // Column droppable format: "column-{columnId}"
  if (id.startsWith('column-')) {
    return id.replace('column-', '') as TaskColumn;
  }

  // Otherwise it's a task ID - find its column
  const task = tasks.find((t) => t.id === id);
  return task?.column ?? null;
}

/**
 * Check if a transition is valid based on workflow rules
 */
function canTransition(from: TaskColumn, to: TaskColumn): boolean {
  if (from === to) return true; // Same column reordering is always valid
  return VALID_TRANSITIONS[from].includes(to);
}

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.4',
      },
    },
  }),
  duration: 200,
  easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
};

/**
 * Enhanced Kanban Board with multi-select, collapse, and workflow validation
 */
export function KanbanBoard({
  tasks,
  onTaskMove,
  onTaskClick,
  onNewTask,
  onRunNow,
  backlogHeaderAction,
  isLoading: _isLoading,
}: KanbanBoardProps): React.JSX.Element {
  const [{ selectedIds, collapsedColumns }, actions] = useBoardState();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskColumn | null>(null);

  // Get sessions from in-progress tasks that have active sessions
  // Container agents only have sessionId (no agentId), so we check for sessionId only
  const activeSessions = useMemo(() => {
    return tasks
      .filter((t) => t.column === 'in_progress' && t.sessionId)
      .map((t) => ({ sessionId: t.sessionId as string, taskId: t.id }));
  }, [tasks]);

  // Track agent statuses for active sessions
  const agentStatuses = useContainerAgentStatuses(activeSessions);

  // Group tasks by column, sorted by position
  const tasksByColumn = useMemo(() => {
    return COLUMN_ORDER.reduce(
      (acc, column) => {
        acc[column] = tasks
          .filter((t) => t.column === column)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return acc;
      },
      {} as Record<TaskColumn, Task[]>
    );
  }, [tasks]);

  // DnD Sensors with activation constraint
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Minimum drag distance before activation
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle drag start
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const taskId = active.id as string;
      setActiveId(taskId);

      // If dragged item is not selected, select only it
      if (!selectedIds.has(taskId)) {
        actions.setSelectedIds(new Set([taskId]));
      }
    },
    [selectedIds, actions]
  );

  // Handle drag over to highlight drop targets
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over } = event;
      if (over) {
        const targetColumn = getColumnFromDroppableId(over.id as string, tasks);
        setOverColumn(targetColumn);
      } else {
        setOverColumn(null);
      }
    },
    [tasks]
  );

  // Handle drag end
  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      setOverColumn(null);

      if (!over) return;

      const activeTask = tasks.find((t) => t.id === active.id);
      if (!activeTask) return;

      const targetColumn = getColumnFromDroppableId(over.id as string, tasks);
      if (!targetColumn) return;

      // Validate transition
      if (!canTransition(activeTask.column, targetColumn)) {
        // Invalid transition - could show toast here
        console.warn(`Invalid transition from ${activeTask.column} to ${targetColumn}`);
        return;
      }

      // Calculate position
      const targetTasks = tasksByColumn[targetColumn];
      let position = targetTasks.length;

      // If dropped on a task, insert at that position
      if (!String(over.id).startsWith('column-')) {
        const overTask = tasks.find((t) => t.id === over.id);
        if (overTask) {
          position = overTask.position ?? 0;
        }
      }

      // Move the task
      await onTaskMove(activeTask.id, targetColumn, position);
    },
    [tasks, tasksByColumn, onTaskMove]
  );

  // Handle card selection
  const handleCardSelect = useCallback(
    (taskId: string, multiSelect: boolean) => {
      actions.selectCard(taskId, multiSelect);
    },
    [actions]
  );

  // Handle card open
  const handleCardOpen = useCallback(
    (task: Task) => {
      onTaskClick(task);
    },
    [onTaskClick]
  );

  // Handle column collapse toggle
  const handleColumnCollapse = useCallback(
    (column: TaskColumn) => {
      actions.toggleColumnCollapse(column);
    },
    [actions]
  );

  // Handle add task
  const handleAddTask = useCallback(
    (column: TaskColumn) => {
      onNewTask?.(column);
    },
    [onNewTask]
  );

  // Handle click/keyboard outside to clear selection
  const handleBoardClick = useCallback(
    (e: React.MouseEvent) => {
      // Only clear if clicking on the board background, not on cards
      if (e.target === e.currentTarget) {
        actions.clearSelection();
      }
    },
    [actions]
  );

  const handleBoardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Clear selection on Escape
      if (e.key === 'Escape') {
        actions.clearSelection();
      }
    },
    [actions]
  );

  // Active task for drag overlay
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div
        className="flex gap-4 p-5 overflow-x-auto h-full"
        onClick={handleBoardClick}
        onKeyDown={handleBoardKeyDown}
        role="application"
        aria-label="Kanban board"
      >
        {COLUMN_ORDER.map((columnId) => {
          const columnTasks = tasksByColumn[columnId];
          const isCollapsed = collapsedColumns.has(columnId);
          const isDropTarget = overColumn === columnId;

          return (
            <KanbanColumn
              key={columnId}
              id={columnId}
              title={COLUMN_CONFIG[columnId].title}
              tasks={columnTasks}
              isCollapsed={isCollapsed}
              isDropTarget={isDropTarget}
              onCollapse={() => handleColumnCollapse(columnId)}
              onAddTask={() => handleAddTask(columnId)}
              headerAction={columnId === 'backlog' ? backlogHeaderAction : undefined}
            >
              {columnTasks.map((task) => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  isSelected={selectedIds.has(task.id)}
                  isDragging={activeId === task.id}
                  onSelect={(multi) => handleCardSelect(task.id, multi)}
                  onOpen={() => handleCardOpen(task)}
                  onRunNow={onRunNow ? () => onRunNow(task.id) : undefined}
                  agentStatus={task.sessionId ? agentStatuses.get(task.sessionId) : undefined}
                />
              ))}
            </KanbanColumn>
          );
        })}
      </div>

      <DragOverlay dropAnimation={dropAnimationConfig}>
        {activeTask && <DragOverlayCard task={activeTask} selectedCount={selectedIds.size} />}
      </DragOverlay>
    </DndContext>
  );
}

export * from './constants';
export { DragOverlayCard } from './drag-overlay';
// Re-export components for external use
export { KanbanCard } from './kanban-card';
export { KanbanColumn } from './kanban-column';
export * from './styles';
export { useBoardState } from './use-board-state';
