import { Lightbulb, MagnifyingGlass } from '@phosphor-icons/react';
import type React from 'react';
import { useCallback } from 'react';
import { cn } from '@/lib/utils/cn';
import { INPUT_CLASS } from './formatters';
import { InsightCard } from './insight-card';
import { useMemory } from './memory-context';
import type { Insight, InsightCategoryFilter, InsightStatusFilter, SearchResult } from './types';

// =============================================================================
// Filter options
// =============================================================================

const STATUS_OPTIONS: Array<{ value: InsightStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'pending_review', label: 'Pending Review' },
  { value: 'rejected', label: 'Rejected' },
];

const CATEGORY_OPTIONS: Array<{ value: InsightCategoryFilter; label: string; dot?: string }> = [
  { value: 'all', label: 'All Categories' },
  { value: 'pattern', label: 'Pattern', dot: 'bg-accent' },
  { value: 'anti_pattern', label: 'Anti-Pattern', dot: 'bg-danger' },
  { value: 'decision', label: 'Decision', dot: 'bg-done' },
  { value: 'architecture', label: 'Architecture', dot: 'bg-success' },
  { value: 'error_lesson', label: 'Error Lesson', dot: 'bg-attention' },
];

function SkeletonCard(): React.JSX.Element {
  return (
    <div className="animate-pulse rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <div className="h-5 w-16 rounded-full bg-surface-muted" />
        <div className="h-4 w-20 rounded bg-surface-muted" />
        <div className="h-5 w-24 rounded-full bg-surface-muted" />
      </div>
      <div className="mt-3 space-y-2">
        <div className="h-4 w-full rounded bg-surface-muted" />
        <div className="h-4 w-3/4 rounded bg-surface-muted" />
        <div className="h-4 w-1/2 rounded bg-surface-muted" />
      </div>
      <div className="mt-3 flex gap-1.5">
        <div className="h-5 w-14 rounded-full bg-surface-muted" />
        <div className="h-5 w-18 rounded-full bg-surface-muted" />
      </div>
    </div>
  );
}

function EmptyState({
  isSearch,
  statusFilter,
  categoryFilter,
}: {
  isSearch: boolean;
  statusFilter: InsightStatusFilter;
  categoryFilter: InsightCategoryFilter;
}): React.JSX.Element {
  const hasFilter = statusFilter !== 'all' || categoryFilter !== 'all';

  const message = (() => {
    if (isSearch) return 'No matching insights';
    if (statusFilter !== 'all' && categoryFilter !== 'all') {
      const statusLabel =
        STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter;
      const categoryLabel =
        CATEGORY_OPTIONS.find((o) => o.value === categoryFilter)?.label ?? categoryFilter;
      return `No ${statusLabel.toLowerCase()} ${categoryLabel.toLowerCase()} insights found`;
    }
    if (statusFilter !== 'all') {
      const statusLabel =
        STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter;
      return `No ${statusLabel.toLowerCase()} insights`;
    }
    if (categoryFilter !== 'all') {
      const categoryLabel =
        CATEGORY_OPTIONS.find((o) => o.value === categoryFilter)?.label ?? categoryFilter;
      return `No ${categoryLabel.toLowerCase()} insights found`;
    }
    return 'No insights yet';
  })();

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[rgba(88,166,255,0.12)]">
        <Lightbulb className="h-7 w-7 text-[#58a6ff]" />
      </div>
      <p className="mt-4 text-sm font-semibold text-fg">{message}</p>
      {!isSearch && !hasFilter && (
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-fg-subtle">
          Insights are automatically extracted from agent sessions. As agents complete tasks, key
          patterns, learnings, and context are captured here and fed back into future agent prompts.
        </p>
      )}
    </div>
  );
}

function toInsightCardProps(item: Insight | SearchResult): {
  id: string;
  content: string;
  source: string;
  tags: string[];
  createdAt: string;
  skillId: string | null;
  status?: 'active' | 'pending_review' | 'rejected';
  category?: string | null;
  updatedAt?: string | null;
} {
  if ('source' in item) {
    return item;
  }
  return {
    id: item.id,
    content: item.content,
    source: item.type,
    tags: [],
    createdAt: item.createdAt,
    skillId: item.skillId,
    status: 'active' as const,
    category: null,
    updatedAt: null,
  };
}

export function MemoryInsightsTab(): React.JSX.Element {
  const {
    insights,
    insightsLoading,
    searchQuery,
    setSearchQuery,
    searchResults,
    isSearching,
    deleteInsight,
    approveInsight,
    rejectInsight,
    insightInjections,
    loadInsightInjections,
    insightStatusFilter,
    setInsightStatusFilter,
    insightCategoryFilter,
    setInsightCategoryFilter,
  } = useMemory();

  const handleExpand = useCallback(
    (insightId: string) => {
      void loadInsightInjections(insightId);
    },
    [loadInsightInjections]
  );

  const handleApprove = useCallback((id: string) => approveInsight(id), [approveInsight]);

  const handleReject = useCallback((id: string) => rejectInsight(id), [rejectInsight]);

  const displayedItems: Array<Insight | SearchResult> = searchResults ?? insights;
  const isLoading = insightsLoading || isSearching;
  const hasResults = displayedItems.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface-muted/30 px-4 py-3 text-xs text-fg-subtle leading-relaxed">
        <p>
          Insights are scoped to the selected codespace and automatically extracted from agent
          sessions into{' '}
          <span className="inline-flex items-center rounded-full bg-attention-subtle px-1.5 py-0.5 text-[10px] font-medium text-attention align-middle">
            Pending Review
          </span>
          . <strong className="text-success">Approve</strong> to include in future agent prompts or{' '}
          <strong className="text-danger">Reject</strong> to exclude.
        </p>
      </div>

      {/* Status filter pills */}
      <fieldset
        className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
        aria-label="Filter insights by status"
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle mr-1">
          Status
        </span>
        {STATUS_OPTIONS.map(({ value, label }) => {
          const isActive = insightStatusFilter === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              onClick={() => setInsightStatusFilter(value)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150',
                isActive
                  ? 'bg-accent text-white shadow-sm ring-2 ring-accent/30 ring-offset-1 ring-offset-surface'
                  : 'bg-surface-muted/60 text-fg-muted hover:bg-surface-subtle hover:text-fg'
              )}
            >
              {label}
            </button>
          );
        })}
      </fieldset>

      {/* Category filter pills */}
      <fieldset
        className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
        aria-label="Filter insights by category"
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle mr-1">
          Category
        </span>
        {CATEGORY_OPTIONS.map(({ value, label, dot }) => {
          const isActive = insightCategoryFilter === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              onClick={() => setInsightCategoryFilter(value)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150',
                isActive
                  ? 'bg-accent text-white shadow-sm ring-2 ring-accent/30 ring-offset-1 ring-offset-surface'
                  : 'bg-surface-muted/60 text-fg-muted hover:bg-surface-subtle hover:text-fg'
              )}
            >
              {dot && <span className={cn('h-2 w-2 rounded-full', isActive ? 'bg-white' : dot)} />}
              {label}
            </button>
          );
        })}
      </fieldset>

      <div className="relative">
        <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
        <input
          type="text"
          className={`${INPUT_CLASS} w-full pl-9`}
          placeholder="Search insights..."
          aria-label="Search insights"
          value={searchQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
        />
      </div>

      {isLoading && (
        <div className="grid gap-3 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {!isLoading && hasResults && (
        <div className="grid gap-3 md:grid-cols-2">
          {displayedItems.map((item) => (
            <InsightCard
              key={item.id}
              insight={toInsightCardProps(item)}
              injections={insightInjections.get(item.id)}
              onDelete={deleteInsight}
              onExpand={handleExpand}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      )}

      {!isLoading && !hasResults && (
        <EmptyState
          isSearch={searchResults !== null}
          statusFilter={insightStatusFilter}
          categoryFilter={insightCategoryFilter}
        />
      )}
    </div>
  );
}
