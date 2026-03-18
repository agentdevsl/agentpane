import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectPickerItem } from './types';

const RECENT_PROJECTS_KEY = 'agentpane:recent-projects';
const MAX_RECENT_PROJECTS = 5;

interface UseProjectPickerOptions {
  recentProjects: ProjectPickerItem[];
  allProjects: ProjectPickerItem[];
  selectedProjectId?: string;
  onProjectSelect: (project: ProjectPickerItem) => void;
  onOpenChange: (open: boolean) => void;
}

interface UseProjectPickerReturn {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  filteredRecent: ProjectPickerItem[];
  filteredAll: ProjectPickerItem[];
  allItems: ProjectPickerItem[];
  handleKeyDown: (event: React.KeyboardEvent) => void;
  handleProjectClick: (project: ProjectPickerItem) => void;
  resetState: () => void;
}

/**
 * Hook to manage ProjectPicker state and keyboard navigation
 */
export function useProjectPickerState({
  recentProjects,
  allProjects,
  selectedProjectId,
  onProjectSelect,
  onOpenChange,
}: UseProjectPickerOptions): UseProjectPickerReturn {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter projects based on search query
  const filteredRecent = useMemo(() => {
    if (!searchQuery.trim()) return recentProjects;
    const query = searchQuery.toLowerCase();
    return recentProjects.filter(
      (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
    );
  }, [recentProjects, searchQuery]);

  const filteredAll = useMemo(() => {
    if (!searchQuery.trim()) return allProjects;
    const query = searchQuery.toLowerCase();
    return allProjects.filter(
      (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
    );
  }, [allProjects, searchQuery]);

  // Combined list for keyboard navigation
  const allItems = useMemo(
    () => [...filteredRecent, ...filteredAll],
    [filteredRecent, filteredAll]
  );

  // Reset selected index when items change
  useEffect(() => {
    // Try to keep current selection if possible, otherwise find active project or reset to 0
    if (selectedIndex >= allItems.length) {
      const activeIndex = allItems.findIndex((p) => p.id === selectedProjectId);
      setSelectedIndex(activeIndex >= 0 ? activeIndex : 0);
    }
  }, [allItems, selectedIndex, selectedProjectId]);

  // Reset state when modal opens
  const resetState = useCallback(() => {
    setSearchQuery('');
    const activeIndex = [...recentProjects, ...allProjects].findIndex(
      (p) => p.id === selectedProjectId
    );
    setSelectedIndex(activeIndex >= 0 ? activeIndex : 0);
  }, [recentProjects, allProjects, selectedProjectId]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, allItems.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter': {
          event.preventDefault();
          const selected = allItems[selectedIndex];
          if (selected) {
            onProjectSelect(selected);
            onOpenChange(false);
          }
          break;
        }
      }
    },
    [allItems, selectedIndex, onProjectSelect, onOpenChange]
  );

  // Handle project click
  const handleProjectClick = useCallback(
    (project: ProjectPickerItem) => {
      onProjectSelect(project);
      onOpenChange(false);
    },
    [onProjectSelect, onOpenChange]
  );

  return {
    searchQuery,
    setSearchQuery,
    selectedIndex,
    setSelectedIndex,
    filteredRecent,
    filteredAll,
    allItems,
    handleKeyDown,
    handleProjectClick,
    resetState,
  };
}

/**
 * Hook to manage global Cmd+P / Ctrl+P keyboard shortcut
 */
export function useProjectPickerHotkey(onOpen: () => void): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Check for Cmd+P (Mac) or Ctrl+P (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === 'p') {
        event.preventDefault();
        onOpen();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpen]);
}

/**
 * Hook to manage recent projects in localStorage
 */
export function useRecentProjects(): {
  recentProjectIds: string[];
  addRecentProject: (projectId: string) => void;
} {
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const addRecentProject = useCallback((projectId: string) => {
    setRecentProjectIds((prev) => {
      // Remove if already exists, then add to front
      const filtered = prev.filter((id) => id !== projectId);
      const updated = [projectId, ...filtered].slice(0, MAX_RECENT_PROJECTS);
      try {
        localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
      } catch {
        // Ignore localStorage errors
      }
      return updated;
    });
  }, []);

  return { recentProjectIds, addRecentProject };
}
