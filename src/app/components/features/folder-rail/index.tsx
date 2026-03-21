import { Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/tooltip';
import { useFolderData } from '@/app/providers/folder-context';
import { cn } from '@/lib/utils/cn';
import { CreateFolderDialog } from '../create-folder-dialog';
import { FolderIcon } from './folder-icon';

/**
 * FolderRail -- 48px-wide vertical icon rail on the far left.
 * Shows one icon per project folder and a button to create new folders.
 */
export function FolderRail(): React.JSX.Element {
  const { folders, selectedFolderId, selectFolder } = useFolderData();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  return (
    <>
      <aside
        className="flex h-full w-12 flex-col items-center border-r border-border bg-surface-subtle"
        data-testid="folder-rail"
      >
        {/* Folder icons (scrollable) */}
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
          {folders.map((folder) => {
            const isActive = folder.id === selectedFolderId;
            return (
              <Tooltip key={folder.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => selectFolder(folder.id)}
                    className={cn(
                      'relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150',
                      isActive
                        ? 'text-white shadow-sm'
                        : 'text-fg-muted hover:text-fg hover:bg-surface'
                    )}
                    style={{
                      backgroundColor: isActive ? folder.color : `${folder.color}20`,
                    }}
                    data-testid={`folder-rail-item-${folder.id}`}
                  >
                    {/* Active indicator bar */}
                    {isActive && (
                      <div
                        className="absolute left-0 top-1/2 h-5 w-0.5 -translate-x-[5px] -translate-y-1/2 rounded-r"
                        style={{ backgroundColor: folder.color }}
                      />
                    )}
                    <FolderIcon
                      iconName={folder.icon}
                      size={18}
                      weight={isActive ? 'fill' : 'regular'}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{folder.name}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Create new folder button */}
        <div className="border-t border-border py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setCreateDialogOpen(true)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface hover:text-fg"
                data-testid="folder-rail-create"
              >
                <Plus size={18} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">New Folder</TooltipContent>
          </Tooltip>
        </div>
      </aside>

      <CreateFolderDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </>
  );
}
