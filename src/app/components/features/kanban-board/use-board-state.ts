import { useCallback, useMemo, useState } from 'react';
import type { Task, TaskColumn } from '@/db/schema';

export type SortField = 'position' | 'updatedAt' | 'createdAt';

export interface BoardState {
  selectedIds: Set<string>;
  collapsedColumns: Set<TaskColumn>;
  sortBy: SortField;
}

export interface BoardActions {
  /** Toggle selection for a card (with optional multi-select) */
  selectCard: (taskId: string, multiSelect: boolean) => void;
  /** Set the selected IDs directly */
  setSelectedIds: (ids: Set<string>) => void;
  /** Toggle selection for a card (legacy method) */
  toggleSelection: (taskId: string, isMultiSelect: boolean) => void;
  /** Select all tasks */
  selectAll: (tasks: Task[]) => void;
  /** Clear all selections */
  clearSelection: () => void;
  /** Check if a task is selected */
  isSelected: (taskId: string) => boolean;
  /** Toggle column collapse state */
  toggleColumnCollapse: (column: TaskColumn) => void;
  /** Check if a column is collapsed */
  isColumnCollapsed: (column: TaskColumn) => boolean;
  /** Get selected tasks from a task list */
  getSelectedTasks: (tasks: Task[]) => Task[];
  /** Set sort field */
  setSortBy: (field: SortField) => void;
}

const STORAGE_KEY = 'kanban-collapsed-columns';
const SORT_STORAGE_KEY = 'kanban-sort-by';

function loadCollapsedColumns(): Set<TaskColumn> {
  if (typeof window === 'undefined') return new Set();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return new Set(JSON.parse(saved) as TaskColumn[]);
    }
  } catch {
    // Ignore localStorage errors
  }
  return new Set();
}

function saveCollapsedColumns(columns: Set<TaskColumn>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...columns]));
  } catch {
    // Ignore localStorage errors
  }
}

function loadSortBy(): SortField {
  if (typeof window === 'undefined') return 'position';
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (saved === 'updatedAt' || saved === 'createdAt' || saved === 'position') {
      return saved;
    }
  } catch {
    // Ignore localStorage errors
  }
  return 'position';
}

function saveSortBy(field: SortField): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SORT_STORAGE_KEY, field);
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Hook for managing kanban board state including selection and column collapse.
 * Returns a tuple [state, actions] for easy destructuring.
 */
export function useBoardState(): [BoardState, BoardActions] {
  const [selectedIds, setSelectedIdsState] = useState<Set<string>>(new Set());
  const [collapsedColumns, setCollapsedColumns] = useState<Set<TaskColumn>>(loadCollapsedColumns);
  const [sortBy, setSortByState] = useState<SortField>(loadSortBy);

  const setSelectedIds = useCallback((ids: Set<string>) => {
    setSelectedIdsState(ids);
  }, []);

  const selectCard = useCallback((taskId: string, multiSelect: boolean) => {
    setSelectedIdsState((prev) => {
      const next = new Set(prev);
      if (multiSelect) {
        // Multi-select: toggle this item
        if (next.has(taskId)) {
          next.delete(taskId);
        } else {
          next.add(taskId);
        }
      } else {
        // Single select: replace selection
        if (next.size === 1 && next.has(taskId)) {
          next.clear();
        } else {
          next.clear();
          next.add(taskId);
        }
      }
      return next;
    });
  }, []);

  // Alias for selectCard for backward compatibility
  const toggleSelection = selectCard;

  const selectAll = useCallback((tasks: Task[]) => {
    setSelectedIdsState(new Set(tasks.map((t) => t.id)));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIdsState(new Set());
  }, []);

  const isSelected = useCallback((taskId: string) => selectedIds.has(taskId), [selectedIds]);

  const toggleColumnCollapse = useCallback((column: TaskColumn) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(column)) {
        next.delete(column);
      } else {
        next.add(column);
      }
      saveCollapsedColumns(next);
      return next;
    });
  }, []);

  const isColumnCollapsed = useCallback(
    (column: TaskColumn) => collapsedColumns.has(column),
    [collapsedColumns]
  );

  const getSelectedTasks = useCallback(
    (tasks: Task[]) => tasks.filter((t) => selectedIds.has(t.id)),
    [selectedIds]
  );

  const setSortBy = useCallback((field: SortField) => {
    setSortByState(field);
    saveSortBy(field);
  }, []);

  const state: BoardState = useMemo(
    () => ({ selectedIds, collapsedColumns, sortBy }),
    [selectedIds, collapsedColumns, sortBy]
  );

  const actions: BoardActions = useMemo(
    () => ({
      selectCard,
      setSelectedIds,
      toggleSelection,
      selectAll,
      clearSelection,
      isSelected,
      toggleColumnCollapse,
      isColumnCollapsed,
      getSelectedTasks,
      setSortBy,
    }),
    [
      selectCard,
      setSelectedIds,
      toggleSelection,
      selectAll,
      clearSelection,
      isSelected,
      toggleColumnCollapse,
      isColumnCollapsed,
      getSelectedTasks,
      setSortBy,
    ]
  );

  return [state, actions];
}
