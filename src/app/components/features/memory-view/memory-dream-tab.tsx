import { CircleNotch, SunHorizon, Users } from '@phosphor-icons/react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { toast } from '@/app/components/ui/toast';
import { DreamSessionCard } from './dream-session-card';
import { useMemory } from './memory-context';
import { SuggestionCard } from './suggestion-card';
import { SuggestionModifyDialog } from './suggestion-modify-dialog';
import { SuggestionStatusFilter } from './suggestion-status-filter';
import type { SkillSuggestion, SuggestionFilter } from './types';

function SkeletonBlock(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg bg-surface-muted" />
      ))}
    </div>
  );
}

export function MemoryDreamTab(): React.JSX.Element {
  const {
    dreamSessions,
    dreamSessionsLoading,
    isDreamRunning,
    triggerDream,
    suggestions,
    suggestionsLoading,
    suggestionFilter,
    setSuggestionFilter,
    acceptSuggestion,
    rejectSuggestion,
  } = useMemory();

  const [modifyTarget, setModifyTarget] = useState<{
    id: string;
    title: string;
    suggestedContent: string;
  } | null>(null);

  const counts = useMemo(() => {
    const result = { all: suggestions.length, pending: 0, accepted: 0, rejected: 0, modified: 0 };
    for (const s of suggestions) {
      if (s.status in result) {
        result[s.status as keyof Omit<typeof result, 'all'>]++;
      }
    }
    return result;
  }, [suggestions]);

  const filteredSuggestions = useMemo(() => {
    if (suggestionFilter === 'all') return suggestions;
    return suggestions.filter((s) => s.status === suggestionFilter);
  }, [suggestions, suggestionFilter]);

  const handleModify = useCallback(
    (id: string) => {
      const suggestion = suggestions.find((s) => s.id === id);
      if (suggestion) {
        setModifyTarget({
          id: suggestion.id,
          title: suggestion.title,
          suggestedContent: suggestion.suggestedContent,
        });
      }
    },
    [suggestions]
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Description */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-xs text-fg-muted">
          <span className="font-medium text-fg">Dream cycles</span> analyze your skill execution
          history to generate improvement suggestions — better prompts, new examples, pattern fixes,
          and new skill ideas. Run a cycle to get AI-powered recommendations for your skills.
        </p>
      </div>

      {/* Header actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={isDreamRunning}
          onClick={() => void triggerDream()}
          className="gap-1.5"
        >
          {isDreamRunning ? (
            <>
              <CircleNotch size={14} className="animate-spin" />
              Dream Running...
            </>
          ) : (
            <>
              <SunHorizon size={14} />
              Trigger Dream Cycle
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.info('Agent review delegation coming soon')}
          className="gap-1.5"
        >
          <Users size={14} />
          Delegate Review
        </Button>
      </div>

      {/* Suggestion filter */}
      <SuggestionStatusFilter
        value={suggestionFilter}
        onChange={(value: SuggestionFilter) => setSuggestionFilter(value)}
        counts={counts}
      />

      {/* Suggestions list */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">
          Suggestions <span className="text-fg-muted">({filteredSuggestions.length})</span>
        </h3>

        {suggestionsLoading ? (
          <SkeletonBlock />
        ) : filteredSuggestions.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-8">
            <p className="text-sm text-fg-muted">
              {suggestionFilter === 'all'
                ? 'No suggestions yet. Trigger a dream cycle to generate suggestions.'
                : `No ${suggestionFilter} suggestions.`}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredSuggestions.map((suggestion: SkillSuggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                onAccept={(id: string) => void acceptSuggestion(id)}
                onReject={(id: string) => void rejectSuggestion(id)}
                onModify={handleModify}
              />
            ))}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Dream sessions history */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">Dream Session History</h3>

        {dreamSessionsLoading ? (
          <SkeletonBlock />
        ) : dreamSessions.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-8">
            <p className="text-sm text-fg-muted">No dream sessions yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {dreamSessions.map((session) => (
              <DreamSessionCard key={session.id} session={session} />
            ))}
          </div>
        )}
      </div>

      {/* Modify dialog — key forces remount to reset form state */}
      <SuggestionModifyDialog
        key={modifyTarget?.id}
        open={modifyTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setModifyTarget(null);
        }}
        suggestion={modifyTarget}
      />
    </div>
  );
}
