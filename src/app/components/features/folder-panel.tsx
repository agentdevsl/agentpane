import { CaretLeft, CaretRight, Plus } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/tooltip';
import { useCodespaceData } from '@/app/providers/codespace-context';
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH, useFolderData } from '@/app/providers/folder-context';
import { cn } from '@/lib/utils/cn';
import { ResizeHandle } from '../ui/resize-handle';
import { CreateFolderDialog } from './create-folder-dialog';
import { FolderIcon } from './folder-rail/folder-icon';

// =============================================================================
// FolderPanel Component (Tier 2)
// =============================================================================

/**
 * FolderPanel -- collapsible panel showing project folders with
 * codespace count badges. Collapses to icon-only (48px).
 */
export function FolderPanel(): React.JSX.Element {
  const {
    folders,
    selectedFolderId,
    selectFolder,
    isFolderPanelOpen,
    toggleFolderPanel,
    folderPanelWidth,
    setFolderPanelWidth,
    persistFolderPanelWidth,
  } = useFolderData();
  const { rawCodespaceList } = useCodespaceData();
  const navigate = useNavigate();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const expanded = isFolderPanelOpen;

  // Compute codespace counts per folder
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const cs of rawCodespaceList) {
      if (cs.projectFolderId) {
        counts.set(cs.projectFolderId, (counts.get(cs.projectFolderId) ?? 0) + 1);
      }
    }
    return counts;
  }, [rawCodespaceList]);

  return (
    <>
      <aside
        className={cn(
          'relative flex h-full shrink-0 flex-col border-r border-border-subtle bg-surface overflow-hidden z-20',
          expanded
            ? ''
            : 'w-[48px] min-w-[48px] transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]'
        )}
        style={expanded ? { width: folderPanelWidth, minWidth: MIN_PANEL_WIDTH } : undefined}
        data-testid="folder-panel"
      >
        {/* Header */}
        <div
          className={cn(
            'flex items-center min-h-[48px] border-b border-border-subtle',
            expanded ? 'gap-2 px-3 py-2.5' : 'justify-center py-2.5'
          )}
        >
          {expanded ? (
            <>
              <button
                type="button"
                onClick={toggleFolderPanel}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-fg"
                data-testid="folder-panel-collapse"
                title="Collapse"
              >
                <CaretLeft size={14} />
              </button>
              <h2 className="flex-1 truncate text-[13px] font-semibold text-fg">AgentPane</h2>
            </>
          ) : (
            <button
              type="button"
              onClick={toggleFolderPanel}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-fg"
              data-testid="folder-panel-expand"
              title="Expand"
            >
              <CaretRight size={14} />
            </button>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          <div className={expanded ? 'px-2' : 'px-1'}>
            {/* Section label (expanded only) */}
            {expanded && (
              <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                Projects
              </div>
            )}

            {/* Add project button */}
            {expanded ? (
              <button
                type="button"
                onClick={() => setCreateDialogOpen(true)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-accent mb-0.5"
                data-testid="new-folder-btn"
              >
                <Plus size={14} />
                Add project
              </button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setCreateDialogOpen(true)}
                    className="flex w-full items-center justify-center rounded-md py-1.5 mt-2 mb-1 text-fg-subtle transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:bg-surface-subtle hover:text-accent"
                    data-testid="new-folder-btn"
                  >
                    <Plus size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Add project</TooltipContent>
              </Tooltip>
            )}

            {/* Folder list */}
            <div className="py-1">
              {folders.map((folder) => {
                const isActive = folder.id === selectedFolderId;
                const count = folderCounts.get(folder.id) ?? 0;

                const folderButton = (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => {
                      selectFolder(folder.id);
                      void navigate({ to: '/codespaces' });
                    }}
                    className={cn(
                      'relative flex items-center rounded-md mb-px text-left transition-all duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
                      expanded ? 'w-full gap-2 px-2 py-[7px]' : 'w-full justify-center py-1.5',
                      isActive ? 'bg-surface-emphasis' : 'hover:bg-surface-subtle'
                    )}
                    data-testid={`folder-item-${folder.id}`}
                  >
                    {isActive && expanded && (
                      <div
                        className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r"
                        style={{ backgroundColor: folder.color }}
                      />
                    )}
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px]"
                      style={{ backgroundColor: `${folder.color}20`, color: folder.color }}
                    >
                      <FolderIcon iconName={folder.icon} size={14} />
                    </div>
                    {expanded && (
                      <>
                        <span
                          className={cn(
                            'flex-1 truncate text-[13px] font-medium transition-colors duration-[220ms]',
                            isActive ? 'text-fg' : 'text-fg-muted'
                          )}
                        >
                          {folder.name}
                        </span>
                        {count > 0 && (
                          <span className="ml-auto text-[11px] font-semibold text-fg-subtle tabular-nums">
                            {count}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                );

                if (!expanded) {
                  return (
                    <Tooltip key={folder.id}>
                      <TooltipTrigger asChild>{folderButton}</TooltipTrigger>
                      <TooltipContent side="right">
                        {folder.name}
                        {count > 0 ? ` (${count})` : ''}
                      </TooltipContent>
                    </Tooltip>
                  );
                }

                return folderButton;
              })}
            </div>
          </div>
        </div>

        {/* Resize handle (expanded only) */}
        {expanded && (
          <ResizeHandle
            currentWidth={folderPanelWidth}
            onResize={setFolderPanelWidth}
            onResizeEnd={persistFolderPanelWidth}
            minWidth={MIN_PANEL_WIDTH}
            maxWidth={MAX_PANEL_WIDTH}
          />
        )}
      </aside>

      <CreateFolderDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </>
  );
}
