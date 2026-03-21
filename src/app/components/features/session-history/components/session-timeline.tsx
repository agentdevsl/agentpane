import { CheckCircle, Clock, MagnifyingGlass, X } from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';
import { Skeleton, SkeletonText } from '@/app/components/ui/skeleton';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import type { SessionTimelineProps } from '../types';
import { SessionCard } from './session-card';

interface ProjectSearchProps {
  projects: Array<{ id: string; name: string }>;
  selectedProjectId?: string | null;
  onProjectChange: (projectId: string | null) => void;
}

function ProjectSearch({
  projects,
  selectedProjectId,
  onProjectChange,
}: ProjectSearchProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId),
    [projects, selectedProjectId]
  );

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(query));
  }, [projects, searchQuery]);

  const filteredProjectsLength = filteredProjects.length;
  useWatchEffect(() => {
    setHighlightedIndex(0);
  }, [filteredProjectsLength]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isSearchOpen) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        setIsSearchOpen(true);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, filteredProjects.length));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex === 0) {
          onProjectChange(null);
        } else {
          const project = filteredProjects[highlightedIndex - 1];
          if (project) onProjectChange(project.id);
        }
        setIsSearchOpen(false);
        setSearchQuery('');
        break;
      case 'Escape':
        setIsSearchOpen(false);
        setSearchQuery('');
        break;
    }
  };

  useMountEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        inputRef.current &&
        !inputRef.current.contains(e.target as Node) &&
        listRef.current &&
        !listRef.current.contains(e.target as Node)
      ) {
        setIsSearchOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  });

  return (
    <div className="relative">
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
        <input
          ref={inputRef}
          type="text"
          value={isSearchOpen ? searchQuery : (selectedProject?.name ?? '')}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (!isSearchOpen) setIsSearchOpen(true);
          }}
          onFocus={() => setIsSearchOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="All projects"
          className={cn(
            'w-40 appearance-none rounded-md border bg-surface-subtle py-1.5 pl-8 pr-7 text-xs transition-colors',
            'placeholder:text-fg-muted focus:outline-none focus:ring-1',
            selectedProjectId
              ? 'border-accent/50 text-fg focus:border-accent focus:ring-accent/30'
              : 'border-border text-fg-muted hover:border-fg-subtle focus:border-accent focus:ring-accent/30'
          )}
        />
        {selectedProjectId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onProjectChange(null);
              setSearchQuery('');
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-muted hover:bg-surface-muted hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      {/* Dropdown */}
      {isSearchOpen ? (
        <ul
          ref={listRef}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          <li>
            <button
              type="button"
              onClick={() => {
                onProjectChange(null);
                setIsSearchOpen(false);
                setSearchQuery('');
              }}
              className={cn(
                'w-full px-3 py-1.5 text-left text-xs transition-colors',
                highlightedIndex === 0
                  ? 'bg-accent/10 text-accent'
                  : 'text-fg-muted hover:bg-surface-subtle'
              )}
            >
              All projects
            </button>
          </li>
          {filteredProjects.map((project, index) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => {
                  onProjectChange(project.id);
                  setIsSearchOpen(false);
                  setSearchQuery('');
                }}
                className={cn(
                  'w-full px-3 py-1.5 text-left text-xs transition-colors',
                  highlightedIndex === index + 1
                    ? 'bg-accent/10 text-accent'
                    : selectedProjectId === project.id
                      ? 'text-accent'
                      : 'text-fg hover:bg-surface-subtle'
                )}
              >
                {project.name}
              </button>
            </li>
          ))}
          {filteredProjects.length === 0 && searchQuery ? (
            <li className="px-3 py-2 text-xs text-fg-muted">No projects found</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export function SessionTimeline({
  groups,
  selectedSessionId,
  onSessionSelect,
  totalCount,
  totalDuration,
  isLoading = false,
  projects,
  selectedProjectId,
  onProjectChange,
}: SessionTimelineProps): React.JSX.Element {
  const projectSearch =
    projects && projects.length > 0 && onProjectChange ? (
      <ProjectSearch
        projects={projects}
        selectedProjectId={selectedProjectId}
        onProjectChange={onProjectChange}
      />
    ) : null;

  if (isLoading) {
    return (
      <aside
        className="flex w-full flex-col overflow-hidden border-r border-border bg-surface md:w-[280px] md:min-w-[240px] lg:w-[320px]"
        data-testid="session-timeline-loading"
      >
        <div className="border-b border-border p-4">
          <Skeleton variant="text" width={120} height={20} className="mb-2" />
          <div className="flex gap-4">
            <Skeleton variant="text" width={80} height={14} />
            <Skeleton variant="text" width={100} height={14} />
          </div>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {['group-0', 'group-1', 'group-2'].map((groupId) => (
            <div key={groupId}>
              <Skeleton variant="text" width={60} height={12} className="mb-3 ml-5" />
              <div className="relative space-y-3">
                <div className="absolute bottom-2 left-[3px] top-2 w-px bg-border" />
                {['card-0', 'card-1'].map((cardId) => (
                  <div
                    key={`${groupId}-${cardId}`}
                    className="relative ml-5 rounded-md border border-border bg-surface-subtle p-2.5"
                  >
                    <div className="absolute left-[-17px] top-3 h-2 w-2 rounded-full border-2 border-border bg-surface-muted" />
                    <div className="mb-2 flex justify-between">
                      <Skeleton variant="text" width={60} height={14} />
                      <Skeleton variant="text" width={50} height={14} />
                    </div>
                    <SkeletonText lines={2} lineHeight={12} lastLineWidth={60} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  if (groups.length === 0) {
    return (
      <aside
        className="flex w-full flex-col overflow-hidden border-r border-border bg-surface md:w-[280px] md:min-w-[240px] lg:w-[320px]"
        data-testid="session-timeline-empty"
      >
        <div className="border-b border-border p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">Recent Sessions</h2>
            {projectSearch}
          </div>
          <div className="flex gap-4 text-xs text-fg-muted">
            <span className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3" />0 sessions
            </span>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-sm text-fg-muted">No sessions found</p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="flex w-full flex-col overflow-hidden border-r border-border bg-surface md:w-[280px] md:min-w-[240px] lg:w-[320px]"
      data-testid="session-timeline"
    >
      {/* Header */}
      <div className="border-b border-border p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Recent Sessions</h2>
          {projectSearch}
        </div>
        <div className="flex gap-4 text-xs text-fg-muted">
          <span className="flex items-center gap-1">
            <CheckCircle className="h-3 w-3" />
            {totalCount} sessions
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {totalDuration} total
          </span>
        </div>
      </div>

      {/* Timeline content */}
      <div className="flex-1 overflow-y-auto p-4">
        {groups.map((group) => (
          <div key={group.date} className="mb-6 last:mb-0" data-testid="date-group">
            {/* Date label */}
            <div className="mb-2 pl-5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {group.label}
            </div>

            {/* Timeline list */}
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute bottom-2 left-[3px] top-2 w-px rounded bg-border" />

              {/* Session cards */}
              <div className="space-y-3">
                {group.sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    isSelected={session.id === selectedSessionId}
                    onClick={() => onSessionSelect(session.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
