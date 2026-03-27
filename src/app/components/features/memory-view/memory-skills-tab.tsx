import { ArrowCounterClockwise, CaretRight, Cube, Gear, Lightning } from '@phosphor-icons/react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatDuration, formatRelativeDate, INPUT_CLASS } from './formatters';
import { useMemory } from './memory-context';
import type { SkillDreamOverride, SkillMetrics, SyncedSkill } from './types';

// =============================================================================
// Skeleton
// =============================================================================

function SkeletonRow(): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
      <div className="h-8 w-8 animate-pulse rounded-md bg-surface-muted" />
      <div className="flex-1 space-y-1.5">
        <div className="h-4 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-3 w-48 animate-pulse rounded bg-surface-muted" />
      </div>
      <div className="h-5 w-16 animate-pulse rounded-full bg-surface-muted" />
    </div>
  );
}

// =============================================================================
// Empty state
// =============================================================================

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 text-center">
      <Cube className="h-10 w-10 text-fg-subtle" />
      <p className="mt-3 text-sm font-medium text-fg-muted">No skills configured</p>
      <p className="mt-1 max-w-xs text-xs text-fg-subtle">
        Skills are synced from org and codespace templates. Configure templates to see skills here.
      </p>
    </div>
  );
}

// =============================================================================
// Source badge
// =============================================================================

const SOURCE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  org: { bg: 'bg-accent-subtle', text: 'text-accent', label: 'Org' },
  project: { bg: 'bg-success-subtle', text: 'text-success', label: 'Project' },
  local: { bg: 'bg-done-subtle', text: 'text-done', label: 'Local' },
};

// =============================================================================
// Per-skill dream configuration (inline in expanded row)
// =============================================================================

const MODEL_OPTIONS = [
  { value: '', label: 'Global default (Haiku 4.5)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
];

function SkillDreamConfig({
  skillId,
  override,
  onSave,
  onReset,
}: {
  skillId: string;
  override: SkillDreamOverride | undefined;
  onSave: (skillId: string, override: SkillDreamOverride) => void;
  onReset: (skillId: string) => void;
}): React.JSX.Element {
  const hasOverride =
    override !== undefined &&
    (override.enabled !== undefined ||
      override.model !== undefined ||
      override.minRuns !== undefined);

  const enabled = override?.enabled ?? true;
  const model = override?.model ?? '';
  const minRuns = override?.minRuns;

  const handleEnabledToggle = useCallback(() => {
    onSave(skillId, { ...override, enabled: !enabled });
  }, [skillId, override, enabled, onSave]);

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      const next = { ...override, model: value || undefined };
      // Clean up undefined keys
      if (!next.model) delete next.model;
      onSave(skillId, next);
    },
    [skillId, override, onSave]
  );

  const handleMinRunsBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const raw = e.target.value.trim();
      const num = raw ? Number.parseInt(raw, 10) : undefined;
      const next = { ...override, minRuns: num && num > 0 ? num : undefined };
      if (!next.minRuns) delete next.minRuns;
      onSave(skillId, next);
    },
    [skillId, override, onSave]
  );

  return (
    <div className="mt-4 border-t border-border/50 pt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Gear size={12} className="text-fg-muted" />
          <span className="text-xs font-medium text-fg">Dream Analysis</span>
        </div>
        {hasOverride && (
          <button
            type="button"
            onClick={() => onReset(skillId)}
            className="flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <ArrowCounterClockwise size={10} />
            Reset to defaults
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {/* Enabled toggle */}
        <label className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-fg">Include in dream cycles</div>
            <div className="text-[11px] text-fg-subtle">
              {override?.enabled !== undefined ? 'Custom override' : 'Using global setting'}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleEnabledToggle}
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

        {/* Model selector */}
        <div className="flex flex-col gap-1">
          <label htmlFor={`dream-model-${skillId}`} className="text-xs font-medium text-fg">
            Model
          </label>
          <select
            id={`dream-model-${skillId}`}
            className={INPUT_CLASS}
            value={model}
            onChange={handleModelChange}
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-fg-subtle">
            {override?.model ? 'Custom override' : 'Using global default'}
          </span>
        </div>

        {/* Min runs */}
        <div className="flex flex-col gap-1">
          <label htmlFor={`dream-min-runs-${skillId}`} className="text-xs font-medium text-fg">
            Min runs for analysis
          </label>
          <input
            id={`dream-min-runs-${skillId}`}
            type="number"
            min="1"
            max="100"
            className={`${INPUT_CLASS} w-32`}
            defaultValue={minRuns ?? ''}
            placeholder="3"
            onBlur={handleMinRunsBlur}
          />
          <span className="text-[11px] text-fg-subtle">
            {override?.minRuns !== undefined ? 'Custom override' : 'Using global default'}
          </span>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Synced skill row (compact, informational)
// =============================================================================

function SyncedSkillRow({
  skill,
  metrics,
  expanded,
  onToggle,
  dreamOverride,
  onDreamSave,
  onDreamReset,
}: {
  skill: SyncedSkill;
  metrics: SkillMetrics | null;
  expanded: boolean;
  onToggle: () => void;
  dreamOverride: SkillDreamOverride | undefined;
  onDreamSave: (skillId: string, override: SkillDreamOverride) => void;
  onDreamReset: (skillId: string) => void;
}): React.JSX.Element {
  const source = SOURCE_STYLES[skill.sourceType] ?? {
    bg: 'bg-surface-muted',
    text: 'text-fg-muted',
    label: skill.sourceType,
  };
  const hasData = metrics !== null;

  return (
    <div
      className={cn(
        'border-b border-border last:border-b-0 transition',
        'cursor-pointer hover:bg-surface-subtle/50'
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: div wraps nested interactive elements (toggle, select, input) that cannot be inside a button */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        onClick={onToggle}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        {/* Icon */}
        <div
          className={cn(
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
            hasData ? 'bg-success-subtle' : 'bg-surface-muted'
          )}
        >
          {hasData ? (
            <Lightning size={16} weight="fill" className="text-success" />
          ) : (
            <Cube size={16} className="text-fg-subtle" />
          )}
        </div>

        {/* Name + description */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{skill.name}</span>
            <span
              className={cn(
                'flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                source.bg,
                source.text
              )}
            >
              {source.label}
            </span>
          </div>
          {skill.description && (
            <p className="mt-0.5 truncate text-xs text-fg-subtle">{skill.description}</p>
          )}
        </div>

        {/* Right side: metrics or "no runs" */}
        {hasData ? (
          <div className="flex flex-shrink-0 items-center gap-4">
            <div className="hidden items-center gap-3 text-xs text-fg-muted sm:flex">
              <span className="tabular-nums">
                <span className="font-medium text-fg">{metrics.totalRuns}</span> runs
              </span>
              <span className="tabular-nums">
                <span className="font-medium text-fg">
                  {Math.round((metrics.successRate ?? 0) * 100)}%
                </span>{' '}
                success
              </span>
              <span className="tabular-nums">{formatCost(metrics.avgCostUsd)}/run</span>
            </div>
            <span className="text-[11px] text-fg-subtle">
              {formatRelativeDate(metrics.lastRunAt)}
            </span>
            <CaretRight
              size={14}
              className={cn('text-fg-subtle transition', expanded && 'rotate-90')}
            />
          </div>
        ) : (
          <div className="flex flex-shrink-0 items-center gap-2">
            <span className="text-[11px] text-fg-subtle">No runs</span>
            <CaretRight
              size={14}
              className={cn('text-fg-subtle transition', expanded && 'rotate-90')}
            />
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stops click from toggling parent when interacting with controls
        <div
          className="border-t border-border bg-surface-subtle/30 px-4 py-3"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        >
          {/* Metrics grid (only when data exists) */}
          {hasData ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <div className="text-[11px] text-fg-subtle">Total Runs</div>
                <div className="text-sm font-medium tabular-nums text-fg">{metrics.totalRuns}</div>
              </div>
              <div>
                <div className="text-[11px] text-fg-subtle">Success Rate</div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-full bg-surface-muted">
                    <div
                      className="h-1.5 rounded-full bg-success transition-all"
                      style={{ width: `${(metrics.successRate ?? 0) * 100}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium tabular-nums text-fg">
                    {Math.round((metrics.successRate ?? 0) * 100)}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-fg-subtle">Avg Cost</div>
                <div className="text-sm font-medium tabular-nums text-fg">
                  {formatCost(metrics.avgCostUsd)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-fg-subtle">Avg Duration</div>
                <div className="text-sm font-medium tabular-nums text-fg">
                  {formatDuration(metrics.avgDurationMs)}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-fg-subtle">No execution data yet</p>
          )}

          {/* Dream analysis config */}
          <SkillDreamConfig
            skillId={skill.id}
            override={dreamOverride}
            onSave={onDreamSave}
            onReset={onDreamReset}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Aggregate banner
// =============================================================================

function AggregateBanner({
  totalSkills,
  trackedSkills,
  totalRuns,
  totalCost,
}: {
  totalSkills: number;
  trackedSkills: number;
  totalRuns: number;
  totalCost: number;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      {[
        { label: 'Total Skills', value: totalSkills },
        { label: 'With Data', value: trackedSkills },
        { label: 'Total Runs', value: totalRuns },
        { label: 'Total Cost', value: formatCost(totalCost) },
      ].map((item) => (
        <div key={item.label} className="bg-surface px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            {item.label}
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-fg">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Main tab
// =============================================================================

export function MemorySkillsTab(): React.JSX.Element {
  const {
    syncedSkills,
    syncedSkillsLoading,
    skillMetrics,
    skillMetricsLoading,
    expandedSkillId,
    setExpandedSkillId,
    dreamSkillOverrides,
    setDreamSkillOverride,
  } = useMemory();

  const handleDreamSave = useCallback(
    (skillId: string, override: SkillDreamOverride) => {
      void setDreamSkillOverride(skillId, override);
    },
    [setDreamSkillOverride]
  );

  const handleDreamReset = useCallback(
    (skillId: string) => {
      void setDreamSkillOverride(skillId, null);
    },
    [setDreamSkillOverride]
  );

  const [showTrackedOnly, setShowTrackedOnly] = useState(false);

  // Merge synced skills with metrics, with tracked skills sorted first
  const allSkills = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ skill: SyncedSkill; metrics: SkillMetrics | null }> = [];

    // Skills with metrics first (sorted by totalRuns desc)
    const tracked = skillMetrics.slice().sort((a, b) => b.totalRuns - a.totalRuns);

    for (const m of tracked) {
      seen.add(m.skillId);
      const synced = syncedSkills.find((s) => s.id === m.skillId);
      result.push({
        skill: synced ?? {
          id: m.skillId,
          name: m.skillName,
          sourceType: 'unknown',
          sourceName: '',
        },
        metrics: m,
      });
    }

    // Then synced skills without metrics
    for (const s of syncedSkills) {
      if (!seen.has(s.id)) {
        result.push({ skill: s, metrics: null });
      }
    }

    return result;
  }, [syncedSkills, skillMetrics]);

  const displayedSkills = showTrackedOnly ? allSkills.filter((s) => s.metrics !== null) : allSkills;

  const aggregates = useMemo(() => {
    const totalSkills = allSkills.length;
    const trackedSkills = skillMetrics.length;
    const totalRuns = skillMetrics.reduce((sum, m) => sum + m.totalRuns, 0);
    const totalCost = skillMetrics.reduce((sum, m) => sum + (m.avgCostUsd ?? 0) * m.totalRuns, 0);
    return { totalSkills, trackedSkills, totalRuns, totalCost };
  }, [allSkills, skillMetrics]);

  const isLoading = skillMetricsLoading || syncedSkillsLoading;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse bg-surface-muted" />
          ))}
        </div>
        <div className="rounded-lg border border-border">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </div>
    );
  }

  if (allSkills.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-4">
      <AggregateBanner
        totalSkills={aggregates.totalSkills}
        trackedSkills={aggregates.trackedSkills}
        totalRuns={aggregates.totalRuns}
        totalCost={aggregates.totalCost}
      />

      {/* Filter toggle */}
      {skillMetrics.length > 0 && syncedSkills.length > skillMetrics.length && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTrackedOnly(false)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition',
              !showTrackedOnly
                ? 'bg-accent text-white'
                : 'bg-surface-muted text-fg-muted hover:bg-surface-subtle'
            )}
          >
            All ({allSkills.length})
          </button>
          <button
            type="button"
            onClick={() => setShowTrackedOnly(true)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition',
              showTrackedOnly
                ? 'bg-accent text-white'
                : 'bg-surface-muted text-fg-muted hover:bg-surface-subtle'
            )}
          >
            With Data ({skillMetrics.length})
          </button>
        </div>
      )}

      {/* Skills list */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {displayedSkills.map(({ skill, metrics }) => (
          <SyncedSkillRow
            key={skill.id}
            skill={skill}
            metrics={metrics}
            expanded={expandedSkillId === skill.id}
            onToggle={() => setExpandedSkillId(expandedSkillId === skill.id ? null : skill.id)}
            dreamOverride={dreamSkillOverrides[skill.id]}
            onDreamSave={handleDreamSave}
            onDreamReset={handleDreamReset}
          />
        ))}
      </div>
    </div>
  );
}
