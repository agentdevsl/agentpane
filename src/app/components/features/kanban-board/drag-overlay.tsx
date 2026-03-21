import { PriorityIcon } from '@/app/components/ui/priority-icon';
import type { Task } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { DRAG_ROTATION, LABEL_TYPES, type Priority } from './constants';
import { cardVariants, labelVariants } from './styles';

interface DragOverlayCardProps {
  /** Task being dragged */
  task: Task;
  /** Number of selected items being dragged */
  selectedCount: number;
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
 * Drag overlay component that shows when dragging cards
 * Displays a preview of the card with rotation and shadow
 * Shows count badge when multiple cards are selected
 */
export function DragOverlayCard({ task, selectedCount }: DragOverlayCardProps): React.JSX.Element {
  const labels = task.labels ?? [];
  const priority = getPriority(task);

  return (
    <div
      className={cn(
        cardVariants({ state: 'default' }),
        'shadow-2xl cursor-grabbing border-primary/50 ring-2 ring-primary/20',
        'opacity-100 relative'
      )}
      style={{
        transform: `rotate(${DRAG_ROTATION}deg) scale(1.05)`,
        width: 280,
        transformOrigin: '50% 50%',
      }}
      role="dialog"
      aria-label="Dragging task"
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

      {/* Header */}
      <div className="flex items-start gap-2">
        <PriorityIcon priority={priority} className="mt-1" />
        <div className="flex-1 text-sm font-medium leading-snug text-fg">{task.title}</div>
      </div>

      {/* Description preview */}
      {task.description && (
        <p className="mt-1.5 text-xs text-fg-muted line-clamp-2">{task.description}</p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-2.5">
        <span className="font-mono text-xs text-fg-muted">{formatTaskId(task.id)}</span>
      </div>

      {/* Multi-select badge */}
      {selectedCount > 1 && (
        <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-accent text-white text-xs font-bold flex items-center justify-center shadow-md">
          {selectedCount}
        </div>
      )}
    </div>
  );
}
