import { Lightbulb, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
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

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Lightbulb className="h-10 w-10 text-fg-subtle" />
      <p className="mt-3 text-sm font-medium text-fg-muted">No insights yet</p>
      <p className="mt-1 text-xs text-fg-subtle">Create one to get started.</p>
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

const INPUT_CLASS =
  'rounded-md border border-border bg-surface-subtle px-3 text-sm text-fg h-9 focus:border-accent focus:ring-2 focus:ring-accent-muted focus:outline-none';

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
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
          <input
            type="text"
            className={`${INPUT_CLASS} w-full pl-9`}
            placeholder="Search insights..."
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

      {!isLoading && !hasResults && <EmptyState />}

      <InsightCreateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
