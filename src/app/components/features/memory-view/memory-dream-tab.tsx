import { CaretRight, CircleNotch, Gear, Sparkle, Users } from '@phosphor-icons/react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Switch } from '@/app/components/ui/switch';
import { toast } from '@/app/components/ui/toast';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';
import { DreamSessionCard } from './dream-session-card';
import { DEFAULT_DREAM_MODEL, DREAM_MODEL_OPTIONS, INPUT_CLASS } from './formatters';
import { useMemory } from './memory-context';
import { SuggestionCard } from './suggestion-card';
import { SuggestionModifyDialog } from './suggestion-modify-dialog';
import { SuggestionStatusFilter } from './suggestion-status-filter';
import type { SkillSuggestion, SuggestionFilter } from './types';

function SkeletonBlock(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-xl bg-surface-muted" />
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
  const [intervalDays, setIntervalDays] = useState('1');
  const [model, setModel] = useState(DEFAULT_DREAM_MODEL);
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
        const hours = Number(parse('memory.dreaming.intervalHours', '24'));
        setIntervalDays(String(Math.max(1, Math.round(hours / 24))));
        setModel(parse('memory.dreaming.model', DEFAULT_DREAM_MODEL));
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
        'memory.dreaming.intervalHours': (Number(intervalDays) || 1) * 24,
        'memory.dreaming.model': model.trim() || DEFAULT_DREAM_MODEL,
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
  }, [enabled, intervalDays, model, minRuns]);

  return (
    <div className="rounded-xl border border-border bg-surface transition-all duration-200 hover:border-fg-subtle hover:shadow-sm">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3.5 text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-[rgba(139,148,158,0.12)] text-[#8b949e]">
            <Gear size={14} />
          </div>
          <span className="text-sm font-medium text-fg">Upskill Configuration</span>
          {enabled && (
            <span className="rounded-full bg-success-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
              Auto-scheduled
            </span>
          )}
        </div>
        <CaretRight
          size={14}
          className={cn(
            'text-fg-subtle transition-transform duration-200 ease-out',
            open && 'rotate-90'
          )}
        />
      </button>

      {/* Smooth expand/collapse */}
      <div
        className={cn(
          'grid transition-all duration-200 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border-muted/50 px-4 py-4">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <CircleNotch size={16} className="animate-spin text-fg-muted" />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-xs text-fg-subtle">
                  Upskill uses a Claude agent to analyze skill execution history and suggest
                  improvements. Configure automatic scheduling and model preferences below.
                </p>

                {/* Enabled toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-fg">Auto-schedule</div>
                    <div className="text-xs text-fg-muted">
                      Automatically run upskill cycles at a set interval
                    </div>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked: boolean) => setEnabled(checked)}
                  />
                </div>

                {/* Interval */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="dream-interval" className="text-sm font-medium text-fg">
                    Interval (days)
                  </label>
                  <input
                    id="dream-interval"
                    type="number"
                    min="1"
                    max="30"
                    className={`${INPUT_CLASS} w-32`}
                    value={intervalDays}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setIntervalDays(e.target.value)
                    }
                    disabled={!enabled}
                  />
                  <span className="text-[11px] text-fg-subtle">
                    Default: every day. Maximum: 30 days.
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
                    {DREAM_MODEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
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
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setMinRuns(e.target.value)
                    }
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
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Main tab
// =============================================================================

export function MemoryDreamTab(): React.JSX.Element {
  const {
    codespaceId,
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

  const isGlobalMode = codespaceId === null;

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
          disabled={isDreamRunning || isGlobalMode}
          onClick={() => void triggerDream()}
          className="gap-1.5"
          title={isGlobalMode ? 'Select a codespace to run an upskill cycle' : undefined}
        >
          {isDreamRunning ? (
            <>
              <CircleNotch size={14} className="animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkle size={14} />
              Analyze Skills
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
      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
          Suggestions <span className="text-fg-subtle">({filteredSuggestions.length})</span>
        </h3>

        {suggestionsLoading ? (
          <SkeletonBlock />
        ) : filteredSuggestions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface py-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(210,153,34,0.12)]">
              <Sparkle className="h-5 w-5 text-[#d29922]" />
            </div>
            <p className="mt-3 text-sm font-medium text-fg-muted">
              {suggestionFilter === 'all'
                ? 'No suggestions yet'
                : `No ${suggestionFilter} suggestions`}
            </p>
            {suggestionFilter === 'all' && (
              <p className="mt-1 text-xs text-fg-subtle">
                Run an upskill analysis to generate improvement suggestions.
              </p>
            )}
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
      <div className="border-t border-border-muted/50" />

      {/* Dream sessions history */}
      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
          Upskill History
        </h3>

        {dreamSessionsLoading ? (
          <SkeletonBlock />
        ) : dreamSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface py-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(163,113,247,0.12)]">
              <Sparkle className="h-5 w-5 text-[#a371f7]" />
            </div>
            <p className="mt-3 text-sm font-medium text-fg-muted">No upskill sessions yet</p>
          </div>
        ) : (
          <div className="flex flex-col rounded-xl border border-border bg-surface px-4 pt-3">
            {dreamSessions.map((session, i) => (
              <DreamSessionCard
                key={session.id}
                session={session}
                isLast={i === dreamSessions.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modify dialog -- key forces remount to reset form state */}
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
