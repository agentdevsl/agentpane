import { FilePlus, PencilSimple, Trash } from '@phosphor-icons/react';
import type { FileChange } from '@/app/hooks/use-container-agent';
import { cn } from '@/lib/utils/cn';

interface ContainerAgentChangesTabProps {
  fileChanges: FileChange[];
}

const actionConfig = {
  create: { icon: FilePlus, label: 'Created', className: 'text-[var(--syntax-added)]' },
  modify: { icon: PencilSimple, label: 'Modified', className: 'text-attention' },
  delete: { icon: Trash, label: 'Deleted', className: 'text-[var(--syntax-removed)]' },
} as const;

/**
 * Displays a list of files changed by the agent during execution.
 * Shows file path, change action (create/modify/delete), and addition/deletion counts.
 */
export function ContainerAgentChangesTab({
  fileChanges,
}: ContainerAgentChangesTabProps): React.JSX.Element {
  if (fileChanges.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-fg-muted">
        <p>No file changes yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto" data-testid="container-agent-changes-tab">
      <div className="px-3 py-2 text-xs font-medium text-fg-muted border-b border-border">
        {fileChanges.length} file{fileChanges.length !== 1 ? 's' : ''} changed
      </div>
      <ul className="divide-y divide-border">
        {fileChanges.map((change) => {
          const config = actionConfig[change.action];
          const Icon = config.icon;
          // Extract just the filename from the path
          const fileName = change.path.split('/').pop() ?? change.path;
          // Get parent directory for context
          const parts = change.path.split('/');
          const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

          return (
            <li
              key={change.path}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-subtle transition-colors"
            >
              <Icon className={cn('h-4 w-4 shrink-0', config.className)} weight="regular" />
              <div className="flex flex-1 min-w-0 flex-col">
                <span className="truncate font-medium text-fg" title={change.path}>
                  {fileName}
                </span>
                {dir ? (
                  <span className="truncate text-xs text-fg-muted" title={dir}>
                    {dir}
                  </span>
                ) : null}
              </div>
              {change.additions !== undefined || change.deletions !== undefined ? (
                <div className="flex items-center gap-1.5 text-xs shrink-0">
                  {change.additions !== undefined && change.additions > 0 ? (
                    <span className="text-[var(--syntax-added)]">+{change.additions}</span>
                  ) : null}
                  {change.deletions !== undefined && change.deletions > 0 ? (
                    <span className="text-[var(--syntax-removed)]">-{change.deletions}</span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
