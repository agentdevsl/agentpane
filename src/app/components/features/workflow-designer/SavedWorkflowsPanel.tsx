import {
  CaretRight,
  Circle,
  Clock,
  FloppyDisk,
  Plus,
  Pulse,
  Stack,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';

import { panelHeaderVariants, sidebarPanelVariants } from './styles';

/** Saved workflow metadata */
export interface SavedWorkflow {
  id: string;
  name: string;
  description?: string;
  updatedAt: Date;
  nodeCount: number;
  edgeCount: number;
}

interface SavedWorkflowsPanelProps {
  workflows: SavedWorkflow[];
  activeWorkflowId: string | null;
  hasUnsavedChanges: boolean;
  isLoading?: boolean;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onSelect: (workflow: SavedWorkflow) => void;
  onCreateNew: () => void;
  onDelete: (workflowId: string) => void;
  onSave: () => void;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Panel displaying saved workflows catalog with selection, creation, and delete functionality.
 * Shows save status and provides quick access to workflow management.
 */
export function SavedWorkflowsPanel({
  workflows,
  activeWorkflowId,
  hasUnsavedChanges,
  isLoading = false,
  collapsed,
  onCollapse,
  onSelect,
  onCreateNew,
  onDelete,
  onSave,
}: SavedWorkflowsPanelProps): React.JSX.Element {
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleDelete = useCallback(
    (e: React.MouseEvent, workflowId: string) => {
      e.stopPropagation();
      if (deleteConfirm === workflowId) {
        onDelete(workflowId);
        setDeleteConfirm(null);
      } else {
        setDeleteConfirm(workflowId);
        // Auto-reset after 3 seconds
        setTimeout(() => setDeleteConfirm(null), 3000);
      }
    },
    [deleteConfirm, onDelete]
  );

  return (
    <aside
      className={cn(
        sidebarPanelVariants({ side: 'right', collapsed }),
        'hidden xl:flex',
        collapsed ? 'w-0' : 'w-80'
      )}
      data-testid="saved-workflows-panel"
    >
      {/* Panel header with save status */}
      <div className={cn(panelHeaderVariants(), 'relative overflow-hidden')}>
        {/* Subtle scan-line effect */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,var(--fg-default)_2px,var(--fg-default)_4px)]" />

        <div className="flex items-center gap-[var(--space-2)] relative">
          <Stack className="h-4 w-4 text-[var(--fg-muted)]" weight="duotone" />
          <h3 className="text-[var(--text-sm)] font-[var(--font-semibold)] text-[var(--fg-default)] font-mono tracking-tight">
            Workflows
          </h3>

          {/* Save status indicator */}
          {activeWorkflowId ? (
            <div className="flex items-center gap-1.5 ml-auto mr-2">
              {hasUnsavedChanges ? (
                <button
                  type="button"
                  onClick={onSave}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--attention-subtle)] border border-[var(--attention-muted)] text-[var(--attention-fg)] text-[9px] font-mono uppercase tracking-wider hover:bg-[var(--attention-muted)] transition-colors"
                >
                  <Circle className="h-2 w-2 animate-pulse" weight="fill" />
                  <span>Unsaved</span>
                </button>
              ) : (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--success-subtle)] border border-[var(--success-muted)] text-[var(--success-fg)] text-[9px] font-mono uppercase tracking-wider">
                  <FloppyDisk className="h-2.5 w-2.5" weight="fill" />
                  <span>Saved</span>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapse(true)}
          className="h-7 w-7 relative"
          aria-label="Collapse panel"
        >
          <CaretRight className="h-4 w-4" />
        </Button>
      </div>

      {/* New workflow button */}
      <div className="p-[var(--space-3)] border-b border-[var(--border-default)]">
        <button
          type="button"
          onClick={onCreateNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-[var(--radius)] border border-dashed border-[var(--border-muted)] bg-transparent text-[var(--fg-muted)] hover:border-[var(--accent-fg)] hover:text-[var(--accent-fg)] hover:bg-[var(--accent-subtle)] transition-all duration-200 group"
        >
          <Plus className="h-4 w-4 transition-transform group-hover:rotate-90 duration-200" />
          <span className="text-[var(--text-xs)] font-medium">New Workflow</span>
        </button>
      </div>

      {/* Workflow list */}
      <div className="flex-1 overflow-y-auto p-[var(--space-3)] space-y-[var(--space-2)]">
        {isLoading ? (
          // Loading state
          <div className="space-y-[var(--space-2)]">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="p-3 rounded-[var(--radius)] border border-[var(--border-default)] bg-[var(--bg-subtle)] animate-pulse"
              >
                <div className="h-4 w-2/3 bg-[var(--bg-muted)] rounded mb-2" />
                <div className="h-3 w-full bg-[var(--bg-muted)] rounded mb-3" />
                <div className="h-3 w-1/3 bg-[var(--bg-muted)] rounded" />
              </div>
            ))}
          </div>
        ) : workflows.length === 0 ? (
          // Empty state
          <div className="text-center py-12">
            <div className="relative w-16 h-16 mx-auto mb-4">
              {/* Blueprint grid background */}
              <div className="absolute inset-0 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-default)] overflow-hidden">
                <div className="absolute inset-0 opacity-20 bg-[linear-gradient(var(--accent-muted)_1px,transparent_1px),linear-gradient(90deg,var(--accent-muted)_1px,transparent_1px)] bg-[size:8px_8px]" />
              </div>
              <Stack
                className="absolute inset-0 m-auto h-7 w-7 text-[var(--fg-subtle)]"
                weight="duotone"
              />
            </div>
            <p className="text-[var(--text-sm)] text-[var(--fg-muted)] font-medium">
              No saved workflows
            </p>
            <p className="text-[var(--text-xs)] text-[var(--fg-subtle)] mt-1">
              Create your first workflow to get started
            </p>
          </div>
        ) : (
          // Workflow cards
          workflows.map((workflow) => {
            const isActive = workflow.id === activeWorkflowId;
            const isDeleting = deleteConfirm === workflow.id;

            return (
              // biome-ignore lint/a11y/useSemanticElements: Can't use <button> because it contains a nested delete button
              <div
                key={workflow.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(workflow)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(workflow);
                  }
                }}
                className={cn(
                  'w-full text-left p-3 rounded-[var(--radius)] border transition-all duration-200 relative overflow-hidden group cursor-pointer',
                  isActive
                    ? 'bg-[var(--accent-subtle)] border-[var(--accent-muted)] ring-1 ring-[var(--accent-fg)]'
                    : 'bg-[var(--bg-subtle)] border-[var(--border-default)] hover:border-[var(--border-muted)] hover:bg-[var(--bg-muted)]'
                )}
              >
                {/* Blueprint micro-pattern for active card */}
                {isActive ? (
                  <div className="absolute inset-0 opacity-[0.07] bg-[linear-gradient(var(--accent-fg)_1px,transparent_1px),linear-gradient(90deg,var(--accent-fg)_1px,transparent_1px)] bg-[size:12px_12px] pointer-events-none" />
                ) : null}

                <div className="relative">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Status indicator */}
                      {isActive ? (
                        <div className="relative flex-shrink-0">
                          <Pulse className="h-3.5 w-3.5 text-[var(--accent-fg)]" weight="fill" />
                          {/* Terminal cursor blink effect */}
                          <div className="absolute inset-0 animate-[blink_1s_step-end_infinite]">
                            <Pulse
                              className="h-3.5 w-3.5 text-[var(--accent-fg)] opacity-50"
                              weight="fill"
                            />
                          </div>
                        </div>
                      ) : (
                        <Circle
                          className="h-3 w-3 text-[var(--fg-subtle)] flex-shrink-0"
                          weight="regular"
                        />
                      )}

                      <span
                        className={cn(
                          'text-[var(--text-sm)] font-medium truncate',
                          isActive ? 'text-[var(--accent-fg)]' : 'text-[var(--fg-default)]'
                        )}
                      >
                        {workflow.name}
                      </span>
                    </div>

                    {/* Delete button */}
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, workflow.id)}
                      className={cn(
                        'flex-shrink-0 p-1 rounded transition-all',
                        isDeleting
                          ? 'bg-[var(--danger-subtle)] text-[var(--danger-fg)]'
                          : 'text-[var(--fg-subtle)] opacity-0 group-hover:opacity-100 hover:text-[var(--danger-fg)] hover:bg-[var(--danger-subtle)]'
                      )}
                      aria-label={isDeleting ? 'Confirm delete' : 'Delete workflow'}
                    >
                      {isDeleting ? (
                        <Warning className="h-3.5 w-3.5" weight="fill" />
                      ) : (
                        <Trash className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>

                  {/* Description */}
                  {workflow.description ? (
                    <p className="text-[10px] text-[var(--fg-muted)] line-clamp-2 mb-2 leading-relaxed">
                      {workflow.description}
                    </p>
                  ) : null}

                  {/* Meta row */}
                  <div className="flex items-center gap-3 text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
                    <div className="flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" />
                      <span>{formatRelativeTime(workflow.updatedAt)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="opacity-50">·</span>
                      <span>{workflow.nodeCount} nodes</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="opacity-50">·</span>
                      <span>{workflow.edgeCount} edges</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer with count */}
      {workflows.length > 0 ? (
        <div className="border-t border-[var(--border-default)] px-[var(--space-3)] py-[var(--space-2)] bg-[var(--bg-subtle)]">
          <span className="text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
            {workflows.length} workflow{workflows.length !== 1 ? 's' : ''}
          </span>
        </div>
      ) : null}
    </aside>
  );
}
