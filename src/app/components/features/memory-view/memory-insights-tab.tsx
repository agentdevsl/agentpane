import { Lightbulb, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { INPUT_CLASS } from './formatters';
import { InsightCard } from './insight-card';
import { InsightCreateDialog } from './insight-create-dialog';
import { useMemory } from './memory-context';
import type { Insight, SearchResult } from './types';

function SkeletonCard(): React.JSX.Element {
  return (
    <div className="animate-pulse rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <div className="h-5 w-16 rounded-full bg-surface-muted" />
        <div className="h-4 w-24 rounded bg-surface-muted" />
      </div>
      <div className="mt-3 space-y-2">
        <div className="h-4 w-full rounded bg-surface-muted" />
        <div className="h-4 w-3/4 rounded bg-surface-muted" />
        <div className="h-4 w-1/2 rounded bg-surface-muted" />
      </div>
    </div>
  );
}

function EmptyState({ isSearch }: { isSearch: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Lightbulb className="h-10 w-10 text-fg-subtle" />
      <p className="mt-3 text-sm font-medium text-fg-muted">
        {isSearch ? 'No matching insights' : 'No insights yet'}
      </p>
      {!isSearch && (
        <p className="mt-1 max-w-xs text-xs text-fg-subtle">
          Insights are observations captured from agent sessions — patterns, learnings, and context
          that help agents work more effectively over time.
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
  } = useMemory();

  const [dialogOpen, setDialogOpen] = useState(false);

  const displayedItems: Array<Insight | SearchResult> = searchResults ?? insights;
  const isLoading = insightsLoading || isSearching;
  const hasResults = displayedItems.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-fg-subtle">
        Insights are observations derived from agent sessions — patterns, debugging context, and
        learnings that persist across conversations and help agents make better decisions.
      </p>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
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
        <Button size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
          <Plus size={14} weight="bold" />
          Create Insight
        </Button>
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
              onDelete={deleteInsight}
            />
          ))}
        </div>
      )}

      {!isLoading && !hasResults && <EmptyState isSearch={searchResults !== null} />}

      <InsightCreateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
