import { useCallback, useMemo, useState } from 'react';
import type { SessionFilters, SessionSort } from '../types';

// Default to ordering by latest activity rather than creation time —
// session rows are reused across re-runs of the same task, so `createdAt`
// reflects the task's first run and not "what happened most recently".
const DEFAULT_SORT: SessionSort = {
  field: 'lastActivityAt',
  direction: 'desc',
};

/**
 * Hook for managing session filters state
 */
export function useSessionFilters(initialFilters?: SessionFilters, initialSort?: SessionSort) {
  const [filters, setFiltersState] = useState<SessionFilters>(initialFilters ?? {});
  const [sort, setSortState] = useState<SessionSort>(initialSort ?? DEFAULT_SORT);

  // Update filters
  const setFilters = useCallback((newFilters: Partial<SessionFilters>) => {
    setFiltersState((prev) => ({
      ...prev,
      ...newFilters,
    }));
  }, []);

  // Update sort
  const setSort = useCallback((newSort: Partial<SessionSort>) => {
    setSortState((prev) => ({
      ...prev,
      ...newSort,
    }));
  }, []);

  // Clear all filters
  const clearFilters = useCallback(() => {
    setFiltersState({});
    setSortState(DEFAULT_SORT);
  }, []);

  // Check if any filters are active
  const hasActiveFilters = useMemo(() => {
    return (
      (filters.status && filters.status.length > 0) ||
      filters.agentId != null ||
      filters.taskId != null ||
      filters.dateFrom != null ||
      filters.dateTo != null ||
      (filters.search && filters.search.length > 0)
    );
  }, [filters]);

  return {
    filters,
    sort,
    setFilters,
    setSort,
    clearFilters,
    hasActiveFilters,
  };
}
