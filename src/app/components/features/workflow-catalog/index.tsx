import { ArrowDown, ArrowUp, FunnelSimple, MagnifyingGlass, X } from '@phosphor-icons/react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { Skeleton } from '@/app/components/ui/skeleton';
import { TextInput } from '@/app/components/ui/text-input';
import type { Workflow, WorkflowStatus } from '@/db/schema';
import { cn } from '@/lib/utils/cn';
import { EmptyState } from '../empty-state';
import { WorkflowCard } from './WorkflowCard';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowCatalogProps {
  workflows: Workflow[];
  isLoading?: boolean;
  onSelectWorkflow: (workflow: Workflow) => void;
  onDeleteWorkflow?: (id: string) => void;
  className?: string;
}

type StatusFilter = 'all' | WorkflowStatus;
type SortField = 'name' | 'createdAt' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

interface FilterState {
  status: StatusFilter;
  search: string;
  sortField: SortField;
  sortDirection: SortDirection;
}

// =============================================================================
// Constants
// =============================================================================

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
];

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'createdAt', label: 'Created' },
  { value: 'updatedAt', label: 'Updated' },
];

const ITEMS_PER_PAGE = 12;

// =============================================================================
// Skeleton Card Component
// =============================================================================

function WorkflowCardSkeleton(): React.JSX.Element {
  return (
    <div
      className="rounded-lg border border-border bg-surface overflow-hidden"
      data-testid="workflow-card-skeleton"
    >
      {/* Thumbnail skeleton */}
      <Skeleton variant="rectangular" className="aspect-video w-full rounded-none" />

      {/* Content skeleton */}
      <div className="p-4 space-y-3">
        {/* Title */}
        <Skeleton variant="text" height={16} width="70%" />

        {/* Description */}
        <div className="space-y-1.5">
          <Skeleton variant="text" height={12} width="100%" />
          <Skeleton variant="text" height={12} width="80%" />
        </div>

        {/* Tags */}
        <div className="flex items-center gap-1.5">
          <Skeleton variant="rectangular" height={20} width={48} className="rounded" />
          <Skeleton variant="rectangular" height={20} width={56} className="rounded" />
          <Skeleton variant="rectangular" height={20} width={40} className="rounded" />
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4">
          <Skeleton variant="text" height={12} width={60} />
          <Skeleton variant="text" height={12} width={60} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border-muted">
          <Skeleton variant="text" height={11} width={64} />
          <Skeleton variant="text" height={11} width={64} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Mobile Filters Popover
// =============================================================================

interface MobileFiltersProps {
  filters: FilterState;
  onFilterChange: (updates: Partial<FilterState>) => void;
  onClear: () => void;
  activeCount: number;
}

function MobileFilters({
  filters,
  onFilterChange,
  onClear,
  activeCount,
}: MobileFiltersProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="outline" className="relative md:hidden">
          <FunnelSimple className="h-4 w-4" />
          Filters
          {activeCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-fg">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="z-50 w-72 rounded-lg border border-border bg-surface p-4 shadow-lg"
          sideOffset={8}
          align="end"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-fg">Filters</h4>
              {activeCount > 0 && (
                <Button variant="ghost" size="sm" onClick={onClear}>
                  Clear all
                </Button>
              )}
            </div>

            {/* Search */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="mobile-search" className="text-xs font-medium text-fg-muted">
                Search
              </label>
              <div className="relative">
                <MagnifyingGlass className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
                <TextInput
                  id="mobile-search"
                  type="text"
                  placeholder="Search workflows..."
                  value={filters.search}
                  onChange={(e) => onFilterChange({ search: e.target.value })}
                  className="pl-8"
                />
              </div>
            </div>

            {/* Status */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="mobile-status" className="text-xs font-medium text-fg-muted">
                Status
              </label>
              <Select
                value={filters.status}
                onValueChange={(value) => onFilterChange({ status: value as StatusFilter })}
              >
                <SelectTrigger id="mobile-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Sort */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="mobile-sort" className="text-xs font-medium text-fg-muted">
                Sort by
              </label>
              <div className="flex gap-2">
                <Select
                  value={filters.sortField}
                  onValueChange={(value) => onFilterChange({ sortField: value as SortField })}
                >
                  <SelectTrigger id="mobile-sort" className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    onFilterChange({
                      sortDirection: filters.sortDirection === 'asc' ? 'desc' : 'asc',
                    })
                  }
                  aria-label={`Sort ${filters.sortDirection === 'asc' ? 'descending' : 'ascending'}`}
                >
                  {filters.sortDirection === 'asc' ? (
                    <ArrowUp className="h-4 w-4" />
                  ) : (
                    <ArrowDown className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// =============================================================================
// Pagination Component
// =============================================================================

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: PaginationProps): React.JSX.Element | null {
  const pages = useMemo(() => {
    if (totalPages <= 1) return [];
    const result: (number | 'ellipsis')[] = [];
    const showEllipsis = totalPages > 7;

    if (!showEllipsis) {
      for (let i = 1; i <= totalPages; i++) {
        result.push(i);
      }
    } else {
      // Always show first page
      result.push(1);

      if (currentPage > 3) {
        result.push('ellipsis');
      }

      // Show pages around current
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);

      for (let i = start; i <= end; i++) {
        result.push(i);
      }

      if (currentPage < totalPages - 2) {
        result.push('ellipsis');
      }

      // Always show last page
      result.push(totalPages);
    }

    return result;
  }, [currentPage, totalPages]);

  if (pages.length === 0) return null;

  return (
    <nav
      className="flex items-center justify-center gap-1 mt-6"
      aria-label="Pagination"
      data-testid="workflow-pagination"
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        aria-label="Previous page"
      >
        Previous
      </Button>

      <div className="flex items-center gap-1 mx-2">
        {pages.map((page, index) =>
          page === 'ellipsis' ? (
            <span key={`ellipsis-${index}`} className="px-2 text-fg-muted">
              ...
            </span>
          ) : (
            <Button
              key={page}
              variant={page === currentPage ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onPageChange(page)}
              aria-current={page === currentPage ? 'page' : undefined}
              className="min-w-[32px]"
            >
              {page}
            </Button>
          )
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        aria-label="Next page"
      >
        Next
      </Button>
    </nav>
  );
}

// =============================================================================
// WorkflowCatalog Component
// =============================================================================

export function WorkflowCatalog({
  workflows,
  isLoading = false,
  onSelectWorkflow,
  onDeleteWorkflow,
  className,
}: WorkflowCatalogProps): React.JSX.Element {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState<FilterState>({
    status: 'all',
    search: '',
    sortField: 'updatedAt',
    sortDirection: 'desc',
  });

  // Calculate active filter count
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status !== 'all') count++;
    if (filters.search.trim() !== '') count++;
    return count;
  }, [filters]);

  // Filter and sort workflows
  const filteredWorkflows = useMemo(() => {
    let result = [...workflows];

    // Filter by status
    if (filters.status !== 'all') {
      result = result.filter((w) => w.status === filters.status);
    }

    // Filter by search term
    if (filters.search.trim()) {
      const searchLower = filters.search.toLowerCase().trim();
      result = result.filter(
        (w) =>
          w.name.toLowerCase().includes(searchLower) ||
          (w.description?.toLowerCase().includes(searchLower) ?? false)
      );
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;

      switch (filters.sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'createdAt':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'updatedAt':
          comparison = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }

      return filters.sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [workflows, filters]);

  // Pagination
  const totalPages = Math.ceil(filteredWorkflows.length / ITEMS_PER_PAGE);
  const paginatedWorkflows = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredWorkflows.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredWorkflows, currentPage]);

  // Reset to page 1 when filters change
  const handleFilterChange = useCallback((updates: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
    setCurrentPage(1);
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters({
      status: 'all',
      search: '',
      sortField: 'updatedAt',
      sortDirection: 'desc',
    });
    setCurrentPage(1);
  }, []);

  const handleWorkflowClick = useCallback(
    (workflow: Workflow) => {
      setSelectedWorkflowId(workflow.id);
      onSelectWorkflow(workflow);
    },
    [onSelectWorkflow]
  );

  const handleDeleteWorkflow = useCallback(
    (id: string) => {
      onDeleteWorkflow?.(id);
    },
    [onDeleteWorkflow]
  );

  // Loading state
  if (isLoading) {
    return (
      <div className={cn('space-y-6', className)} data-testid="workflow-catalog-loading">
        {/* Filter bar skeleton */}
        <div className="flex items-center justify-between gap-4">
          <Skeleton variant="rectangular" height={36} width={256} className="rounded-md" />
          <div className="hidden md:flex items-center gap-3">
            <Skeleton variant="rectangular" height={36} width={140} className="rounded-md" />
            <Skeleton variant="rectangular" height={36} width={140} className="rounded-md" />
          </div>
        </div>

        {/* Grid skeleton */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <WorkflowCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  // Empty state (no workflows at all)
  if (workflows.length === 0) {
    return (
      <div className={cn('flex items-center justify-center min-h-[400px]', className)}>
        <EmptyState
          preset="no-results"
          title="No Workflows"
          subtitle="Create your first workflow to get started with visual automation"
          data-testid="workflow-catalog-empty"
        />
      </div>
    );
  }

  return (
    <div className={cn('space-y-6', className)} data-testid="workflow-catalog">
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-4">
        {/* Search - desktop */}
        <div className="relative hidden md:block w-64">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
          <TextInput
            type="text"
            placeholder="Search workflows..."
            value={filters.search}
            onChange={(e) => handleFilterChange({ search: e.target.value })}
            className="pl-8"
            aria-label="Search workflows"
          />
        </div>

        {/* Mobile filters */}
        <MobileFilters
          filters={filters}
          onFilterChange={handleFilterChange}
          onClear={handleClearFilters}
          activeCount={activeFilterCount}
        />

        {/* Desktop filters */}
        <div className="hidden md:flex items-center gap-3">
          {/* Status filter */}
          <div className="flex items-center gap-1.5">
            <label
              htmlFor="status-filter"
              className="text-xs font-medium text-fg-muted whitespace-nowrap"
            >
              Status:
            </label>
            <Select
              value={filters.status}
              onValueChange={(value) => handleFilterChange({ status: value as StatusFilter })}
            >
              <SelectTrigger id="status-filter" className="min-w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Sort */}
          <div className="flex items-center gap-1.5">
            <label
              htmlFor="sort-filter"
              className="text-xs font-medium text-fg-muted whitespace-nowrap"
            >
              Sort:
            </label>
            <Select
              value={filters.sortField}
              onValueChange={(value) => handleFilterChange({ sortField: value as SortField })}
            >
              <SelectTrigger id="sort-filter" className="min-w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                handleFilterChange({
                  sortDirection: filters.sortDirection === 'asc' ? 'desc' : 'asc',
                })
              }
              aria-label={`Sort ${filters.sortDirection === 'asc' ? 'descending' : 'ascending'}`}
              className="h-9 w-9"
            >
              {filters.sortDirection === 'asc' ? (
                <ArrowUp className="h-4 w-4" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearFilters}
              className="text-fg-muted hover:text-fg"
            >
              <X className="mr-1 h-3 w-3" />
              Clear ({activeFilterCount})
            </Button>
          )}
        </div>
      </div>

      {/* Results summary */}
      <div className="text-sm text-fg-muted">
        Showing {paginatedWorkflows.length} of {filteredWorkflows.length} workflow
        {filteredWorkflows.length !== 1 ? 's' : ''}
        {activeFilterCount > 0 && ` (filtered from ${workflows.length})`}
      </div>

      {/* No results after filtering */}
      {filteredWorkflows.length === 0 && (
        <div className="flex items-center justify-center min-h-[300px]">
          <EmptyState
            preset="no-results"
            title="No Matching Workflows"
            subtitle="Try adjusting your search or filter criteria"
            primaryAction={{
              label: 'Clear Filters',
              onClick: handleClearFilters,
            }}
            data-testid="workflow-catalog-no-results"
          />
        </div>
      )}

      {/* Workflow grid */}
      {filteredWorkflows.length > 0 && (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          data-testid="workflow-grid"
        >
          {paginatedWorkflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              isSelected={selectedWorkflowId === workflow.id}
              onClick={() => handleWorkflowClick(workflow)}
              onDelete={onDeleteWorkflow ? () => handleDeleteWorkflow(workflow.id) : undefined}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
    </div>
  );
}

export type { WorkflowCardProps } from './WorkflowCard';
// Re-export WorkflowCard for direct use if needed
export { WorkflowCard } from './WorkflowCard';
