import * as DialogPrimitive from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ContainerAgentPanel } from '@/app/components/features/container-agent-panel';
import { PlanSessionView } from '@/app/components/features/plan-session-view';
import type { Task, TaskColumn, Worktree } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { TaskActions } from './task-actions';
import { TaskActivity } from './task-activity';
import { TaskDescription } from './task-description';
import { TaskDetailsCollapsible } from './task-details-collapsible';
import { TaskHeader } from './task-header';

/**
 * Custom hook for drag functionality.
 * Uses refs + direct DOM manipulation to avoid 60+ re-renders/sec during drag.
 */
function useDraggable() {
  const positionRef = useRef({ x: 0, y: 0 });
  const elementRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const applyTransform = useCallback(() => {
    if (elementRef.current) {
      const { x, y } = positionRef.current;
      elementRef.current.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only allow dragging from left mouse button
    if (e.button !== 0) return;

    isDraggingRef.current = true;
    setIsDragging(true);
    dragStart.current = {
      x: e.clientX - positionRef.current.x,
      y: e.clientY - positionRef.current.y,
    };
    e.preventDefault();
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      positionRef.current = {
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      };
      applyTransform();
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, applyTransform]);

  const reset = useCallback(() => {
    positionRef.current = { x: 0, y: 0 };
    applyTransform();
  }, [applyTransform]);

  return { elementRef, isDragging, handleMouseDown, reset };
}

export interface TaskViewer {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  joinedAt: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
  modelOverride?: string | null;
}

export interface ActivityEntry {
  id: string;
  type: 'tool_call' | 'status_change' | 'comment' | 'rejection' | 'approval';
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface TaskDetailDialogProps {
  task: Task | null;
  worktree?: Worktree | null;
  availableLabels?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: UpdateTaskInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMoveColumn?: (taskId: string, column: TaskColumn) => Promise<void>;
  onViewSession?: (sessionId: string) => void;
  onOpenApproval?: (taskId: string) => void;
  onStopAgent?: (taskId: string) => Promise<void>;
  viewers?: TaskViewer[];
}

type EditSection = 'title' | 'description' | 'labels' | 'priority';
type ActivityTab = 'timeline' | 'comments' | 'history';

interface DialogState {
  isEditing: boolean;
  editingSection: EditSection | null;
  isSaving: boolean;
  activityTab: ActivityTab;
}

type DialogAction =
  | { type: 'START_EDIT'; section: EditSection }
  | { type: 'CANCEL_EDIT' }
  | { type: 'START_SAVE' }
  | { type: 'SAVE_SUCCESS' }
  | { type: 'SAVE_ERROR' }
  | { type: 'SET_ACTIVITY_TAB'; tab: ActivityTab };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case 'START_EDIT':
      return { ...state, isEditing: true, editingSection: action.section };
    case 'CANCEL_EDIT':
      return { ...state, isEditing: false, editingSection: null };
    case 'START_SAVE':
      return { ...state, isSaving: true };
    case 'SAVE_SUCCESS':
      return { ...state, isSaving: false, isEditing: false, editingSection: null };
    case 'SAVE_ERROR':
      return { ...state, isSaving: false };
    case 'SET_ACTIVITY_TAB':
      return { ...state, activityTab: action.tab };
    default:
      return state;
  }
}

const initialState: DialogState = {
  isEditing: false,
  editingSection: null,
  isSaving: false,
  activityTab: 'timeline',
};

export function TaskDetailDialog({
  task,
  worktree,
  open,
  onOpenChange,
  onSave,
  onDelete,
  onMoveColumn,
  onViewSession,
  onOpenApproval,
  onStopAgent,
  viewers = [],
}: TaskDetailDialogProps): React.JSX.Element {
  const [state, dispatch] = useReducer(dialogReducer, initialState);
  const [pendingChanges, setPendingChanges] = useState<Partial<UpdateTaskInput>>({});
  const { elementRef, isDragging, handleMouseDown, reset: resetPosition } = useDraggable();

  // Reset state when task changes or dialog closes
  useEffect(() => {
    if (!open || !task) {
      setPendingChanges({});
      dispatch({ type: 'CANCEL_EDIT' });
      resetPosition();
    }
  }, [open, task, resetPosition]);

  // Merge pending changes with task for display
  const displayTask = useMemo(() => {
    if (!task) return null;
    return { ...task, ...pendingChanges };
  }, [task, pendingChanges]);

  const hasUnsavedChanges = Object.keys(pendingChanges).length > 0;

  // Field change handler
  const handleFieldChange = useCallback(
    <K extends keyof UpdateTaskInput>(field: K, value: UpdateTaskInput[K]) => {
      setPendingChanges((prev) => ({ ...prev, [field]: value }));
    },
    []
  );

  // Save handler
  const handleSave = useCallback(async () => {
    if (Object.keys(pendingChanges).length === 0) return;

    dispatch({ type: 'START_SAVE' });

    try {
      await onSave(pendingChanges);
      dispatch({ type: 'SAVE_SUCCESS' });
      setPendingChanges({});
    } catch (error) {
      console.error('[TaskDetailDialog] Failed to save task:', error);
      dispatch({ type: 'SAVE_ERROR' });
    }
  }, [pendingChanges, onSave]);

  // Delete handler
  const handleDelete = useCallback(async () => {
    if (!task) return;
    try {
      await onDelete(task.id);
      onOpenChange(false);
    } catch (error) {
      console.error('[TaskDetailDialog] Failed to delete task:', error);
    }
  }, [task, onDelete, onOpenChange]);

  // Determine if we should show plan session view (currently disabled - no mode field)
  const showPlanSessionView = false;

  // Show container agent panel when task is in progress and has a session
  const showContainerAgentPanel = task?.column === 'in_progress' && task?.sessionId;

  // Stable ref for handleSave to avoid re-registering keydown listener on every change
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (isInputFocused) {
        if (e.key === 'Escape') {
          dispatch({ type: 'CANCEL_EDIT' });
          e.preventDefault();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          handleSaveRef.current();
        }
        return;
      }

      switch (e.key) {
        case 'e':
        case 'E':
          if (!state.isEditing) {
            dispatch({ type: 'START_EDIT', section: 'description' });
            e.preventDefault();
          }
          break;
        case 'Escape':
          if (state.isEditing) {
            dispatch({ type: 'CANCEL_EDIT' });
          } else {
            onOpenChange(false);
          }
          e.preventDefault();
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, state.isEditing, onOpenChange]);

  if (!task || !displayTask) {
    return (
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-6">
            <p className="text-fg-muted">No task selected</p>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'duration-200'
          )}
        />
        <DialogPrimitive.Content
          ref={elementRef}
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-2xl max-h-[90vh]',
            'rounded-xl border border-border bg-surface shadow-xl',
            'flex flex-col overflow-hidden',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'duration-200 ease-out',
            isDragging && 'cursor-grabbing'
          )}
          style={{
            transform: 'translate(calc(-50% + 0px), calc(-50% + 0px))',
          }}
        >
          <VisuallyHidden>
            <DialogPrimitive.Title>{displayTask.title || 'Task details'}</DialogPrimitive.Title>
          </VisuallyHidden>
          {/* Header - acts as drag handle */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Drag handle needs mouse event */}
          <div
            onMouseDown={handleMouseDown}
            className={cn('cursor-grab', isDragging && 'cursor-grabbing')}
          >
            <TaskHeader
              task={displayTask}
              viewers={viewers}
              onPriorityChange={(priority) => handleFieldChange('priority', priority)}
            />
          </div>

          {/* Content area - conditionally render based on mode */}
          {showPlanSessionView ? (
            <div className="flex-1 overflow-hidden">
              <PlanSessionView
                taskId={task.id}
                projectId={task.projectId}
                onSessionEnd={() => onOpenChange(false)}
              />
            </div>
          ) : showContainerAgentPanel ? (
            <div className="flex-1 min-h-0 flex flex-col p-4">
              <ContainerAgentPanel
                sessionId={task.sessionId}
                onStop={onStopAgent ? () => onStopAgent(task.id) : undefined}
              />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="space-y-5 p-5">
                {/* Description */}
                <TaskDescription
                  description={displayTask.description ?? ''}
                  isEditing={state.editingSection === 'description'}
                  onEdit={() => dispatch({ type: 'START_EDIT', section: 'description' })}
                  onChange={(description) => handleFieldChange('description', description)}
                  onSave={handleSave}
                  onCancel={() => dispatch({ type: 'CANCEL_EDIT' })}
                />

                {/* Collapsible details: metadata, labels, worktree */}
                <TaskDetailsCollapsible task={task} worktree={worktree} />

                {/* Activity timeline */}
                <TaskActivity
                  task={task}
                  activeTab={state.activityTab}
                  onTabChange={(tab) => dispatch({ type: 'SET_ACTIVITY_TAB', tab })}
                />
              </div>
            </div>
          )}

          {/* Footer with actions - hide when showing plan session view or container agent panel */}
          {!showPlanSessionView && !showContainerAgentPanel && (
            <div className="flex items-center justify-between border-t border-border bg-surface-muted px-5 py-4">
              {/* Unsaved changes indicator */}
              {hasUnsavedChanges ? (
                <span className="text-xs text-attention">Unsaved changes</span>
              ) : (
                <span />
              )}

              {/* Action buttons */}
              <TaskActions
                column={task.column}
                isSaving={state.isSaving}
                hasChanges={hasUnsavedChanges}
                onSave={handleSave}
                onCancel={() => {
                  setPendingChanges({});
                  dispatch({ type: 'CANCEL_EDIT' });
                }}
                onDelete={handleDelete}
                onViewSession={
                  onViewSession && task.sessionId
                    ? () => {
                        const sessionId = task.sessionId;
                        if (sessionId) onViewSession(sessionId);
                      }
                    : undefined
                }
                onOpenApproval={onOpenApproval ? () => onOpenApproval(task.id) : undefined}
                onMoveColumn={onMoveColumn ? (col) => onMoveColumn(task.id, col) : undefined}
              />
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
