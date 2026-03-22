import { CaretDown } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Task, Worktree } from '@/db/schema';
import { cn } from '@/lib/utils/cn';

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  const now = Date.now();
  const time = new Date(dateStr).getTime();
  const diffMs = now - time;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TaskDetailsCollapsibleProps {
  task: Task;
  worktree?: Worktree | null;
  availableLabels?: string[];
  onModelChange?: (modelId: string | null) => void;
  onLabelsChange?: (labels: string[]) => void;
  onViewSession?: (sessionId: string) => void;
  defaultOpen?: boolean;
}

export function TaskDetailsCollapsible({
  task,
  worktree,
  defaultOpen = false,
}: TaskDetailsCollapsibleProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const labels = (task.labels as string[]) ?? [];

  return (
    <div className="rounded-lg border border-border bg-surface-subtle">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex w-full items-center justify-between px-4 py-2.5',
          'text-xs font-medium uppercase tracking-wide text-fg-muted',
          'hover:bg-surface-muted/50 transition-colors rounded-lg'
        )}
      >
        <span>Details</span>
        <CaretDown
          className={cn(
            'h-3.5 w-3.5 text-fg-subtle transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      <div
        className={cn(
          'grid transition-all duration-300 ease-out',
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border/50 px-4 pb-3 pt-3 space-y-3">
            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-fg-subtle">Created</span>
                <span className="text-fg-muted">{formatRelativeTime(task.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-subtle">Started</span>
                <span className="text-fg-muted">{formatRelativeTime(task.startedAt)}</span>
              </div>
              {task.sessionId && (
                <div className="flex justify-between">
                  <span className="text-fg-subtle">Session</span>
                  <span className="text-fg-muted font-mono">#{task.sessionId.slice(0, 7)}</span>
                </div>
              )}
              {task.branch && (
                <div className="flex justify-between">
                  <span className="text-fg-subtle">Branch</span>
                  <span className="text-fg-muted font-mono truncate ml-2">{task.branch}</span>
                </div>
              )}
              {task.modelOverride && (
                <div className="flex justify-between col-span-2">
                  <span className="text-fg-subtle">Model</span>
                  <span className="text-fg-muted">{task.modelOverride}</span>
                </div>
              )}
              {(task as Task & { skillName?: string | null }).skillName && (
                <div className="flex justify-between col-span-2">
                  <span className="text-fg-subtle">Skill</span>
                  <span className="text-fg-muted">
                    {(task as Task & { skillName?: string | null }).skillName}
                  </span>
                </div>
              )}
            </div>

            {/* Labels */}
            {labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}

            {/* Worktree */}
            {worktree && (
              <div className="text-xs">
                <span className="text-fg-subtle">Worktree: </span>
                <span className="text-fg-muted font-mono">{worktree.path}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
