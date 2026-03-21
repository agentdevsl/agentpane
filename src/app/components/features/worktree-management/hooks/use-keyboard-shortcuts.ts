import { useCallback, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { WorktreeListItem } from '../types';

interface UseKeyboardShortcutsOptions {
  worktrees: WorktreeListItem[];
  selectedId?: string;
  onSelect: (worktree: WorktreeListItem) => void;
  onOpen?: (worktree: WorktreeListItem) => void;
  onMerge?: (worktree: WorktreeListItem) => void;
  onRemove?: (worktree: WorktreeListItem) => void;
  enabled?: boolean;
}

interface UseKeyboardShortcutsReturn {
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
}

/**
 * Hook for keyboard navigation and shortcuts in the worktree list
 */
export function useKeyboardShortcuts({
  worktrees,
  selectedId,
  onSelect,
  onOpen,
  onMerge,
  onRemove,
  enabled = true,
}: UseKeyboardShortcutsOptions): UseKeyboardShortcutsReturn {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    if (selectedId) {
      const index = worktrees.findIndex((w) => w.id === selectedId);
      return index >= 0 ? index : 0;
    }
    return 0;
  });

  // Track whether selection change came from keyboard navigation
  const isKeyboardNavigationRef = useRef(false);

  // Update selected index when external selectedId changes (not from keyboard)
  useWatchEffect(() => {
    // Skip if this update was triggered by keyboard navigation
    if (isKeyboardNavigationRef.current) {
      isKeyboardNavigationRef.current = false;
      return;
    }
    if (selectedId) {
      const index = worktrees.findIndex((w) => w.id === selectedId);
      if (index >= 0) {
        setSelectedIndex(index);
      }
    }
  }, [worktrees, selectedId]);

  const getSelectedWorktree = useCallback((): WorktreeListItem | undefined => {
    return worktrees[selectedIndex];
  }, [worktrees, selectedIndex]);

  useWatchEffect(() => {
    if (!enabled || worktrees.length === 0) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const selected = getSelectedWorktree();

      switch (event.key) {
        case 'ArrowUp':
        case 'k': // Vim-style navigation
          event.preventDefault();
          isKeyboardNavigationRef.current = true;
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          break;

        case 'ArrowDown':
        case 'j': // Vim-style navigation
          event.preventDefault();
          isKeyboardNavigationRef.current = true;
          setSelectedIndex((prev) => Math.min(worktrees.length - 1, prev + 1));
          break;

        case 'Enter':
          event.preventDefault();
          if (selected) {
            isKeyboardNavigationRef.current = true;
            onSelect(selected);
          }
          break;

        case 'o':
        case 'O':
          event.preventDefault();
          if (selected && onOpen) {
            onOpen(selected);
          }
          break;

        case 'm':
        case 'M':
          event.preventDefault();
          if (
            selected &&
            onMerge &&
            (selected.status === 'active' || selected.displayStatus === 'active')
          ) {
            onMerge(selected);
          }
          break;

        case 'r':
        case 'R':
          event.preventDefault();
          if (selected && onRemove) {
            onRemove(selected);
          }
          break;

        case 'Home':
          event.preventDefault();
          isKeyboardNavigationRef.current = true;
          setSelectedIndex(0);
          break;

        case 'End':
          event.preventDefault();
          isKeyboardNavigationRef.current = true;
          setSelectedIndex(worktrees.length - 1);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled, worktrees, getSelectedWorktree, onSelect, onOpen, onMerge, onRemove]);

  // Notify parent when selection changes via keyboard
  useWatchEffect(() => {
    const selected = worktrees[selectedIndex];
    if (selected && selected.id !== selectedId) {
      onSelect(selected);
    }
  }, [selectedIndex, worktrees, selectedId, onSelect]);

  return {
    selectedIndex,
    setSelectedIndex,
  };
}
