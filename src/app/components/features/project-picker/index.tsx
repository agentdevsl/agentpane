import { ArrowDown, ArrowUp, Plus, X } from '@phosphor-icons/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { ProjectList } from './project-list';
import { SearchInput } from './search-input';
import type { ProjectPickerProps } from './types';
import { useProjectPickerState } from './use-project-picker';

/**
 * Command-palette style modal for browsing, searching, and switching between projects.
 * Opens with Cmd+P (Mac) or Ctrl+P (Windows/Linux).
 */
export function ProjectPicker({
  open,
  onOpenChange,
  selectedProjectId,
  onProjectSelect,
  onNewProjectClick,
  recentProjects,
  allProjects,
  isLoading = false,
  error,
}: ProjectPickerProps): React.JSX.Element {
  const searchInputRef = useRef<HTMLInputElement>(null);

  const {
    searchQuery,
    setSearchQuery,
    selectedIndex,
    filteredRecent,
    filteredAll,
    handleKeyDown,
    handleProjectClick,
    resetState,
  } = useProjectPickerState({
    recentProjects,
    allProjects,
    selectedProjectId,
    onProjectSelect,
    onOpenChange,
  });

  // Focus search input when modal opens
  useEffect(() => {
    if (open) {
      resetState();
      // Use requestAnimationFrame to ensure the modal is rendered
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [open, resetState]);

  // Handle new project click
  const handleNewProjectClick = useCallback(() => {
    onOpenChange(false);
    onNewProjectClick();
  }, [onOpenChange, onNewProjectClick]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Overlay with backdrop blur */}
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50',
            'bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'duration-200'
          )}
        />

        {/* Modal content */}
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-[680px]',
            '-translate-x-1/2 -translate-y-1/2',
            'bg-surface border border-border rounded-xl',
            'shadow-2xl overflow-hidden',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'duration-200'
          )}
          onKeyDown={handleKeyDown}
          data-testid="project-dropdown"
        >
          {/* Hidden description for accessibility */}
          <DialogPrimitive.Description className="sr-only">
            Search and select a project to open. Use arrow keys to navigate, Enter to select.
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <DialogPrimitive.Title className="text-base font-semibold text-fg">
              Open Project
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center justify-center w-8 h-8 rounded-md',
                  'text-fg-muted hover:text-fg hover:bg-surface-hover',
                  'transition-colors duration-100'
                )}
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </DialogPrimitive.Close>
          </div>

          {/* Search input */}
          <SearchInput ref={searchInputRef} value={searchQuery} onChange={setSearchQuery} />

          {/* Project list */}
          <ProjectList
            recentProjects={filteredRecent}
            allProjects={filteredAll}
            selectedIndex={selectedIndex}
            currentProjectId={selectedProjectId}
            onProjectClick={handleProjectClick}
            isLoading={isLoading}
            error={error}
            searchQuery={searchQuery}
          />

          {/* Footer with keyboard hints and New Project button */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-surface-hover">
            <div className="flex items-center gap-4 text-xs text-fg-muted">
              <div className="flex items-center gap-1.5">
                <span className="flex items-center gap-0.5">
                  <kbd className="inline-flex items-center justify-center w-5 h-5 bg-surface border border-border rounded text-[10px] font-mono">
                    <ArrowUp className="w-3 h-3" />
                  </kbd>
                  <kbd className="inline-flex items-center justify-center w-5 h-5 bg-surface border border-border rounded text-[10px] font-mono">
                    <ArrowDown className="w-3 h-3" />
                  </kbd>
                </span>
                <span>Navigate</span>
              </div>
              <div className="flex items-center gap-1.5">
                <kbd className="px-1.5 py-0.5 bg-surface border border-border rounded text-[10px] font-mono">
                  Enter
                </kbd>
                <span>Open</span>
              </div>
              <div className="flex items-center gap-1.5">
                <kbd className="px-1.5 py-0.5 bg-surface border border-border rounded text-[10px] font-mono">
                  Esc
                </kbd>
                <span>Cancel</span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleNewProjectClick}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-3',
                'text-xs font-medium text-white',
                'bg-success hover:bg-success-emphasis border border-white/10 rounded-md',
                'transition-colors duration-100'
              )}
              data-testid="new-project-option"
            >
              <Plus className="w-3.5 h-3.5" />
              New Project
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type { ProjectPickerItem, ProjectPickerProps } from './types';
export { mapProjectToPickerItem } from './types';
// Re-export hooks for external use
export { useProjectPickerHotkey, useRecentProjects } from './use-project-picker';
