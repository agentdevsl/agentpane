import { Lightbulb, MagnifyingGlass } from '@phosphor-icons/react';
import type React from 'react';
import { useCallback } from 'react';
import { INPUT_CLASS } from './formatters';
import { InsightCard } from './insight-card';
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
    insightInjections,
    loadInsightInjections,
  } = useMemory();

  const handleExpand = useCallback(
    (insightId: string) => {
      void loadInsightInjections(insightId);
    },
    [loadInsightInjections]
  );

  const displayedItems: Array<Insight | SearchResult> = searchResults ?? insights;
  const isLoading = insightsLoading || isSearching;
  const hasResults = displayedItems.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-fg-subtle">
        Insights are automatically extracted from agent sessions. Key patterns, debugging context,
        and learnings persist across conversations and are injected into future agent prompts.
      </p>

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
            />
          ))}
        </div>
      )}

      {!isLoading && !hasResults && <EmptyState isSearch={searchResults !== null} />}
    </div>
  );
}
