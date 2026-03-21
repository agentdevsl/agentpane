import { FolderOpen, Spinner } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import { ProjectItem } from './project-item';
import type { ProjectPickerItem } from './types';

interface ProjectListProps {
  recentProjects: ProjectPickerItem[];
  allProjects: ProjectPickerItem[];
  selectedIndex: number;
  currentProjectId?: string;
  onProjectClick: (project: ProjectPickerItem) => void;
  isLoading?: boolean;
  error?: Error;
  searchQuery?: string;
}

/**
 * Scrollable list of projects with "Recent" and "All Codespaces" sections
 */
export function ProjectList({
  recentProjects,
  allProjects,
  selectedIndex,
  currentProjectId,
  onProjectClick,
  isLoading = false,
  error,
  searchQuery = '',
}: ProjectListProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Scroll selected item into view
  useWatchEffect(() => {
    const selectedElement = itemRefs.current.get(selectedIndex);
    if (selectedElement && listRef.current) {
      const listRect = listRef.current.getBoundingClientRect();
      const itemRect = selectedElement.getBoundingClientRect();

      if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="w-6 h-6 text-fg-muted animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-danger text-sm font-medium mb-1">Failed to load codespaces</div>
        <div className="text-fg-muted text-xs">{error.message}</div>
      </div>
    );
  }

  const totalProjects = recentProjects.length + allProjects.length;

  if (totalProjects === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FolderOpen className="w-12 h-12 text-fg-muted mb-3" weight="thin" />
        {searchQuery ? (
          <>
            <div className="text-fg-muted text-sm font-medium mb-1">No codespaces found</div>
            <div className="text-fg-subtle text-xs">No codespaces match "{searchQuery}"</div>
          </>
        ) : (
          <>
            <div className="text-fg-muted text-sm font-medium mb-1">No codespaces yet</div>
            <div className="text-fg-subtle text-xs">Create your first codespace to get started</div>
          </>
        )}
      </div>
    );
  }

  let currentIndex = 0;

  return (
    <div
      ref={listRef}
      className="max-h-[400px] overflow-y-auto"
      role="listbox"
      aria-label="Projects"
      data-testid="project-dropdown"
    >
      {/* Recent Codespaces Section */}
      {recentProjects.length > 0 && (
        <div>
          <div className="px-5 py-2 text-xs font-medium text-fg-muted uppercase tracking-wide">
            Recent Codespaces
          </div>
          {recentProjects.map((project) => {
            const index = currentIndex++;
            return (
              <div
                key={project.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el);
                }}
              >
                <ProjectItem
                  project={project}
                  isSelected={selectedIndex === index}
                  isCurrentProject={project.id === currentProjectId}
                  onClick={() => onProjectClick(project)}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* All Codespaces Section */}
      {allProjects.length > 0 && (
        <div>
          <div
            className={cn(
              'px-5 py-2 text-xs font-medium text-fg-muted uppercase tracking-wide',
              recentProjects.length > 0 && 'border-t border-border-subtle mt-2 pt-4'
            )}
          >
            All Codespaces
          </div>
          {allProjects.map((project) => {
            const index = currentIndex++;
            return (
              <div
                key={project.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el);
                }}
              >
                <ProjectItem
                  project={project}
                  isSelected={selectedIndex === index}
                  isCurrentProject={project.id === currentProjectId}
                  onClick={() => onProjectClick(project)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
