import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

// =============================================================================
// Types
// =============================================================================

export type FilterValue = string | string[] | boolean | null | undefined;
export type FilterValues = Record<string, FilterValue>;

export interface UseListFiltersOptions<T> {
  /** Items to filter */
  items: T[];
  /** Filter function to apply to each item */
  filterFn: (item: T, filters: FilterValues) => boolean;
  /** Initial filter values (defaults applied if not in URL) */
  initialFilters?: FilterValues;
  /** localStorage key for filter persistence (optional) */
  persistKey?: string;
}

export interface UseListFiltersReturn<T> {
  /** Items after filtering */
  filteredItems: T[];
  /** Current filter values */
  filters: FilterValues;
  /** Set a single filter value */
  setFilter: (key: string, value: FilterValue) => void;
  /** Set multiple filter values at once */
  setFilters: (filters: FilterValues) => void;
  /** Clear all filters to initial/default values */
  clearFilters: () => void;
  /** Number of active (non-default) filters */
  activeFilterCount: number;
}

// =============================================================================
// Local Storage Helpers
// =============================================================================

function getFromStorage(key: string): FilterValues | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function saveToStorage(key: string, values: FilterValues): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Ignore storage errors
  }
}

// =============================================================================
// URL Search Param Helpers
// =============================================================================

function parseSearchParams(search: Record<string, unknown>): FilterValues {
  const filters: FilterValues = {};

  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;

    // Handle array values (multi-select)
    if (Array.isArray(value)) {
      filters[key] = value.map(String);
    } else if (typeof value === 'boolean') {
      filters[key] = value;
    } else if (typeof value === 'string') {
      // Check if it's a comma-separated list
      if (value.includes(',')) {
        filters[key] = value.split(',').map((v) => v.trim());
      } else {
        filters[key] = value;
      }
    }
  }

  return filters;
}

function filtersToSearchParams(filters: FilterValues): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') {
      params[key] = undefined; // Clear from URL
    } else if (Array.isArray(value)) {
      params[key] = value.length > 0 ? value.join(',') : undefined;
    } else if (typeof value === 'boolean') {
      params[key] = value ? 'true' : undefined;
    } else {
      params[key] = String(value);
    }
  }

  return params;
}

// =============================================================================
// Filter Value Comparison
// =============================================================================

function isDefaultValue(value: FilterValue, defaultValue: FilterValue): boolean {
  if (value === defaultValue) return true;
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (Array.isArray(value) && Array.isArray(defaultValue)) {
    return value.length === defaultValue.length && value.every((v, i) => v === defaultValue[i]);
  }
  return false;
}

function countActiveFilters(filters: FilterValues, defaults: FilterValues): number {
  let count = 0;

  for (const [key, value] of Object.entries(filters)) {
    const defaultValue = defaults[key];
    if (!isDefaultValue(value, defaultValue)) {
      count++;
    }
  }

  return count;
}

// =============================================================================
// useListFilters Hook
// =============================================================================

export function useListFilters<T>({
  items,
  filterFn,
  initialFilters = {},
  persistKey,
}: UseListFiltersOptions<T>): UseListFiltersReturn<T> {
  const navigate = useNavigate();

  // Get search params from URL (TanStack Router)
  // We cast as unknown first since the search type depends on route definition
  const search = useSearch({ strict: false }) as Record<string, unknown>;

  // Merge filters: URL params > localStorage > initial defaults
  const filters = useMemo(() => {
    const urlFilters = parseSearchParams(search);
    const storedFilters = persistKey ? getFromStorage(persistKey) : null;

    // Start with defaults, then apply stored, then URL (URL wins)
    return {
      ...initialFilters,
      ...(storedFilters ?? {}),
      ...urlFilters,
    };
  }, [search, persistKey, initialFilters]);

  // Filter items
  const filteredItems = useMemo(() => {
    return items.filter((item) => filterFn(item, filters));
  }, [items, filters, filterFn]);

  // Count active (non-default) filters
  const activeFilterCount = useMemo(() => {
    return countActiveFilters(filters, initialFilters);
  }, [filters, initialFilters]);

  // Helper to update URL search params using native APIs
  const updateSearchParams = useCallback(
    (searchParams: Record<string, string | undefined>) => {
      const url = new URL(window.location.href);

      for (const [key, value] of Object.entries(searchParams)) {
        if (value === undefined || value === '') {
          url.searchParams.delete(key);
        } else {
          url.searchParams.set(key, value);
        }
      }

      // Use navigate with the updated search string
      void navigate({
        to: '.',
        search: Object.fromEntries(url.searchParams.entries()),
        replace: true,
      });
    },
    [navigate]
  );

  // Set a single filter
  const setFilter = useCallback(
    (key: string, value: FilterValue) => {
      const newFilters = { ...filters, [key]: value };
      const searchParams = filtersToSearchParams(newFilters);

      // Save to localStorage if persistence is enabled
      if (persistKey) {
        saveToStorage(persistKey, newFilters);
      }

      // Update URL
      updateSearchParams(searchParams);
    },
    [filters, persistKey, updateSearchParams]
  );

  // Set multiple filters at once
  const setFilters = useCallback(
    (newFilters: FilterValues) => {
      const merged = { ...filters, ...newFilters };
      const searchParams = filtersToSearchParams(merged);

      // Save to localStorage if persistence is enabled
      if (persistKey) {
        saveToStorage(persistKey, merged);
      }

      // Update URL
      updateSearchParams(searchParams);
    },
    [filters, persistKey, updateSearchParams]
  );

  // Clear all filters back to defaults
  const clearFilters = useCallback(() => {
    const defaultSearchParams = filtersToSearchParams(initialFilters);

    // Clear localStorage
    if (persistKey) {
      saveToStorage(persistKey, initialFilters);
    }

    // Build clear params (all current filter keys set to undefined)
    const clearParams: Record<string, string | undefined> = {};
    for (const key of Object.keys(filters)) {
      clearParams[key] = undefined;
    }

    // Merge clear params with defaults
    updateSearchParams({ ...clearParams, ...defaultSearchParams });
  }, [filters, initialFilters, persistKey, updateSearchParams]);

  return {
    filteredItems,
    filters,
    setFilter,
    setFilters,
    clearFilters,
    activeFilterCount,
  };
}
