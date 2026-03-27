import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CaretDown, Plus } from '@phosphor-icons/react';
import type { Task, TaskColumn } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { COLUMN_HEADER_STYLES } from './constants';
import { COLUMN_ICONS } from './icons';
import { columnIconVariants, columnVariants } from './styles';

interface KanbanColumnProps {
  /** Column identifier */
  id: TaskColumn;
  /** Display title */
  title: string;
  /** Tasks in this column */
  tasks: Task[];
  /** Whether column is collapsed */
  isCollapsed: boolean;
  /** Whether column is a valid drop target */
  isDropTarget: boolean;
  /** Callback to toggle collapse */
  onCollapse: (collapsed: boolean) => void;
  /** Callback to add new task */
  onAddTask: () => void;
  /** Optional custom action to render in header (replaces default + button) */
  headerAction?: React.ReactNode;
  /** Card renderer */
  children: React.ReactNode;
}

export function KanbanColumn({
  id,
  title,
  tasks,
  isCollapsed,
  isDropTarget,
  onCollapse,
  onAddTask,
  headerAction,
  children,
}: KanbanColumnProps): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${id}`,
  });

  const columnState = isDropTarget || isOver ? 'dropTarget' : isCollapsed ? 'collapsed' : 'default';

  return (
    <section
      ref={setNodeRef}
      className={cn(
        columnVariants({ state: columnState }),
        'h-full',
        isCollapsed ? 'shrink-0' : 'flex-1 min-w-[200px]'
      )}
      aria-label={`${title} column with ${tasks.length} tasks`}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center justify-between px-3.5 py-3 border-b border-border shrink-0',
          isCollapsed && 'flex-col py-3 px-2 gap-3'
        )}
        style={isCollapsed ? undefined : COLUMN_HEADER_STYLES[id]}
      >
        <div className={cn('flex items-center gap-2.5', isCollapsed && 'flex-col')}>
          <button
            type="button"
            onClick={() => onCollapse(!isCollapsed)}
            className="w-6 h-6 rounded flex items-center justify-center text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors"
            aria-label={isCollapsed ? `Expand ${title} column` : `Collapse ${title} column`}
          >
            <CaretDown
              className={cn(
                'w-3.5 h-3.5 transition-transform duration-150',
                isCollapsed && '-rotate-90'
              )}
            />
          </button>

          {!isCollapsed && (
            <>
              <div className={columnIconVariants({ column: id })}>
                {(() => {
                  const Icon = COLUMN_ICONS[id];
                  return <Icon className="w-3.5 h-3.5" weight="bold" />;
                })()}
              </div>
              <span className="text-sm font-semibold text-fg">{title}</span>
              <span className="bg-surface-muted text-fg-muted text-xs font-medium px-1.5 py-0.5 rounded-full">
                {tasks.length}
              </span>
            </>
          )}
        </div>

        {/* Collapsed vertical title */}
        {isCollapsed && (
          <div className="flex-1 flex items-center justify-center">
            <span
              className="text-sm font-semibold text-fg whitespace-nowrap"
              style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
              }}
            >
              {title}
            </span>
            <span
              className="ml-1 bg-surface-muted text-fg-muted text-xs font-medium px-1.5 py-0.5 rounded-full"
              style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
              }}
            >
              {tasks.length}
            </span>
          </div>
        )}

        {!isCollapsed &&
          (headerAction ?? (
            <button
              type="button"
              onClick={onAddTask}
              className="w-6 h-6 rounded flex items-center justify-center text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors"
              aria-label={`Add task to ${title}`}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          ))}
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="flex-1 p-3 overflow-y-auto flex flex-col gap-2.5">
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {children}
          </SortableContext>

          {/* Empty state */}
          {tasks.length === 0 && !isDropTarget && !isOver && (
            <div className="flex h-32 flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/50 text-center">
              <span className="text-xs font-medium text-fg-muted">No tasks</span>
              <button
                type="button"
                onClick={onAddTask}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Create one
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
