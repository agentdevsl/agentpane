import { CaretDown, CaretUp, CircleNotch, Gear, SunHorizon, Users } from '@phosphor-icons/react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { toast } from '@/app/components/ui/toast';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { DreamSessionCard } from './dream-session-card';
import { INPUT_CLASS } from './formatters';
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

// =============================================================================
// Dream Configuration (inline settings)
// =============================================================================

const DREAM_SETTINGS_KEYS = [
  'memory.dreaming.enabled',
  'memory.dreaming.intervalHours',
  'memory.dreaming.model',
  'memory.dreaming.minRunsForAnalysis',
];

function DreamConfig(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState('24');
  const [model, setModel] = useState('claude-haiku-4-5-20251001');
  const [minRuns, setMinRuns] = useState('3');

  useWatchEffect(() => {
    if (!open) return;
    setLoading(true);
    apiClient.settings
      .get(DREAM_SETTINGS_KEYS)
      .then((result) => {
        if (!result.ok) return;
        const raw = result.data?.settings ?? {};
        const map = new Map<string, string>();
        for (const [k, v] of Object.entries(raw)) map.set(k, String(v ?? ''));
        const parse = (key: string, fallback: string) => {
          const raw = map.get(key);
          if (!raw) return fallback;
          try {
            const parsed = JSON.parse(raw);
            return String(parsed);
          } catch {
            return raw;
          }
        };
        setEnabled(parse('memory.dreaming.enabled', 'false') === 'true');
        setIntervalHours(parse('memory.dreaming.intervalHours', '24'));
        setModel(parse('memory.dreaming.model', 'claude-haiku-4-5-20251001'));
        setMinRuns(parse('memory.dreaming.minRunsForAnalysis', '3'));
      })
      .catch(() => {
        toast.error('Failed to load dream settings');
      })
      .finally(() => setLoading(false));
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiClient.settings.update({
        'memory.dreaming.enabled': enabled,
        'memory.dreaming.intervalHours': Number(intervalHours) || 24,
        'memory.dreaming.model': model.trim() || 'claude-haiku-4-5-20251001',
        'memory.dreaming.minRunsForAnalysis': Number(minRuns) || 3,
      });
      if (result.ok) {
        toast.success('Dream settings saved');
      } else {
        toast.error('Failed to save dream settings');
      }
    } catch {
      toast.error('Failed to save dream settings');
    } finally {
      setSaving(false);
    }
  }, [enabled, intervalHours, model, minRuns]);

  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="flex items-center gap-2">
          <Gear size={14} className="text-fg-muted" />
          <span className="text-xs font-medium text-fg">Dream Configuration</span>
          {enabled && (
            <span className="rounded-full bg-success-subtle px-2 py-0.5 text-[10px] font-medium text-success">
              Auto-scheduled
            </span>
          )}
        </div>
        {open ? (
          <CaretUp size={14} className="text-fg-subtle" />
        ) : (
          <CaretDown size={14} className="text-fg-subtle" />
        )}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <CircleNotch size={16} className="animate-spin text-fg-muted" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-fg-subtle">
                Dream cycles use a Claude agent to analyze skill execution history and suggest
                improvements. Configure automatic scheduling and model preferences below.
              </p>

              {/* Enabled toggle */}
              <label className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-fg">Auto-schedule</div>
                  <div className="text-xs text-fg-muted">
                    Automatically run dream cycles at a set interval
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => setEnabled((prev) => !prev)}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition ${
                    enabled ? 'bg-accent' : 'bg-surface-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition ${
                      enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </label>

              {/* Interval */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="dream-interval" className="text-sm font-medium text-fg">
                  Interval (hours)
                </label>
                <input
                  id="dream-interval"
                  type="number"
                  min="1"
                  max="168"
                  className={`${INPUT_CLASS} w-32`}
                  value={intervalHours}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setIntervalHours(e.target.value)
                  }
                  disabled={!enabled}
                />
                <span className="text-[11px] text-fg-subtle">
                  Minimum 1 hour. Default: every 24 hours.
                </span>
              </div>

              {/* Model */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="dream-model" className="text-sm font-medium text-fg">
                  Model
                </label>
                <select
                  id="dream-model"
                  className={INPUT_CLASS}
                  value={model}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setModel(e.target.value)}
                >
                  <option value="claude-haiku-4-5-20251001">
                    Claude Haiku 4.5 (cost-efficient)
                  </option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (balanced)</option>
                  <option value="claude-opus-4-6">Claude Opus 4.6 (highest quality)</option>
                </select>
              </div>

              {/* Min runs */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="dream-min-runs" className="text-sm font-medium text-fg">
                  Min runs for analysis
                </label>
                <input
                  id="dream-min-runs"
                  type="number"
                  min="1"
                  max="100"
                  className={`${INPUT_CLASS} w-32`}
                  value={minRuns}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMinRuns(e.target.value)}
                />
                <span className="text-[11px] text-fg-subtle">
                  Skills need at least this many runs before dream analysis.
                </span>
              </div>

              {/* Save */}
              <div className="flex justify-end pt-2">
                <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
                  {saving ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main tab
// =============================================================================

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
      {/* Configuration */}
      <DreamConfig />

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
              Run Dream Cycle Now
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
                ? 'No suggestions yet. Run a dream cycle to generate skill improvement suggestions.'
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
