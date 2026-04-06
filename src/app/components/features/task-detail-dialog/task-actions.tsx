import {
  Archive,
  Check,
  Clock,
  GitBranch,
  Pause,
  Play,
  Terminal,
  Trash,
  X,
} from '@phosphor-icons/react';
import { Button } from '@/app/components/ui/button';
import type { TaskColumn } from '@/db/schema';

interface TaskActionsProps {
  column: TaskColumn;
  isSaving: boolean;
  hasChanges: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onViewSession?: () => void;
  onOpenApproval?: () => void;
  onMoveColumn?: (column: TaskColumn) => void;
}

export function TaskActions({
  column,
  isSaving,
  hasChanges,
  onSave,
  onCancel,
  onDelete,
  onViewSession,
  onOpenApproval,
  onMoveColumn,
}: TaskActionsProps): React.JSX.Element {
  // Show save/cancel when there are pending changes
  if (hasChanges) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    );
  }

  // Context-sensitive actions based on column
  switch (column) {
    case 'backlog':
      return (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-danger hover:text-danger hover:bg-danger-muted"
          >
            <Trash className="h-4 w-4 mr-1.5" />
            Delete
          </Button>
          {onMoveColumn && (
            <Button size="sm" onClick={() => onMoveColumn('in_progress')}>
              <Play className="h-4 w-4 mr-1.5" />
              Start Task
            </Button>
          )}
        </div>
      );

    case 'in_progress':
      return (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-danger hover:text-danger hover:bg-danger-muted"
          >
            <Trash className="h-4 w-4 mr-1.5" />
            Delete
          </Button>
          {onMoveColumn && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMoveColumn('backlog')}
              className="text-fg-muted"
            >
              <X className="h-4 w-4 mr-1.5" />
              Cancel
            </Button>
          )}
          {onViewSession && (
            <Button size="sm" onClick={onViewSession}>
              <Terminal className="h-4 w-4 mr-1.5" />
              View Session
            </Button>
          )}
          {!onViewSession && onMoveColumn && (
            <Button variant="outline" size="sm" onClick={() => onMoveColumn('waiting_approval')}>
              <Pause className="h-4 w-4 mr-1.5" />
              Request Review
            </Button>
          )}
        </div>
      );

    case 'waiting_approval':
      return (
        <div className="flex items-center gap-2">
          {onMoveColumn && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMoveColumn('in_progress')}
              className="text-danger hover:text-danger hover:bg-danger-muted"
            >
              <X className="h-4 w-4 mr-1.5" />
              Reject
            </Button>
          )}
          {onOpenApproval && (
            <Button variant="outline" size="sm" onClick={onOpenApproval}>
              <GitBranch className="h-4 w-4 mr-1.5" />
              View Diff
            </Button>
          )}
          {onMoveColumn && (
            <Button
              size="sm"
              onClick={() => onMoveColumn('verified')}
              className="bg-success hover:bg-success-hover text-fg"
            >
              <Check className="h-4 w-4 mr-1.5" />
              Approve
            </Button>
          )}
        </div>
      );

    case 'verified':
      return (
        <div className="flex items-center gap-2">
          {onViewSession && (
            <Button variant="outline" size="sm" onClick={onViewSession}>
              <Clock className="h-4 w-4 mr-1.5" />
              View History
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled>
            <Archive className="h-4 w-4 mr-1.5" />
            Archive
          </Button>
        </div>
      );

    default:
      return (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-danger hover:text-danger hover:bg-danger-muted"
          >
            <Trash className="h-4 w-4 mr-1.5" />
            Delete
          </Button>
        </div>
      );
  }
}
