import {
  ArrowCounterClockwise,
  CaretRight,
  ChartBar,
  CheckCircle,
  Clock,
  Cube,
  CurrencyDollar,
  Gear,
  Lightning,
  MagnifyingGlass,
  Tag,
  Timer,
  TrendUp,
} from '@phosphor-icons/react';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Switch } from '@/app/components/ui/switch';
import { cn } from '@/lib/utils/cn';
import {
  DREAM_MODEL_OPTIONS,
  formatCost,
  formatDuration,
  formatRelativeDate,
  INPUT_CLASS,
} from './formatters';
import { useMemory } from './memory-context';
import type { SkillDreamOverride, SkillMetrics, SyncedSkill } from './types';

// =============================================================================
// Constants
// =============================================================================

const STAT_ICON_BADGE_STYLES = {
  skills: 'bg-[rgba(88,166,255,0.12)] text-[#58a6ff]',
  tracked: 'bg-[rgba(63,185,80,0.12)] text-[#3fb950]',
  runs: 'bg-[rgba(163,113,247,0.12)] text-[#a371f7]',
  cost: 'bg-[rgba(210,153,34,0.12)] text-[#d29922]',
} as const;

const STAT_GRADIENT_STYLES = {
  skills: { background: 'linear-gradient(135deg, rgba(88,166,255,0.06) 0%, transparent 60%)' },
  tracked: { background: 'linear-gradient(135deg, rgba(63,185,80,0.06) 0%, transparent 60%)' },
  runs: { background: 'linear-gradient(135deg, rgba(163,113,247,0.06) 0%, transparent 60%)' },
  cost: { background: 'linear-gradient(135deg, rgba(210,153,34,0.06) 0%, transparent 60%)' },
} as const;

const TAG_COLORS = [
  { bg: 'bg-accent-muted', text: 'text-accent' },
  { bg: 'bg-success-muted', text: 'text-success' },
  { bg: 'bg-done-muted', text: 'text-done' },
  { bg: 'bg-attention-muted', text: 'text-attention' },
  { bg: 'bg-secondary-muted', text: 'text-secondary' },
  { bg: 'bg-danger-muted', text: 'text-danger' },
] as const;

function getTagColor(tag: string): { bg: string; text: string } {
  const hash = tag.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return TAG_COLORS[hash % TAG_COLORS.length] ?? TAG_COLORS[0];
}

// =============================================================================
// Skeleton
// =============================================================================

function SkeletonRow(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="h-9 w-9 animate-pulse rounded-lg bg-surface-muted" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-4 w-28 animate-pulse rounded bg-surface-muted" />
          <div className="h-4 w-12 animate-pulse rounded-full bg-surface-muted" />
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-3 w-40 animate-pulse rounded bg-surface-muted" />
        </div>
      </div>
      <div className="hidden items-center gap-3 sm:flex">
        <div className="h-3.5 w-14 animate-pulse rounded bg-surface-muted" />
        <div className="h-1.5 w-16 animate-pulse rounded-full bg-surface-muted" />
        <div className="h-3.5 w-12 animate-pulse rounded bg-surface-muted" />
      </div>
      <div className="h-3.5 w-3.5 animate-pulse rounded bg-surface-muted" />
    </div>
  );
}

// =============================================================================
// Empty state
// =============================================================================

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[rgba(139,148,158,0.12)]">
        <Cube className="h-7 w-7 text-[#8b949e]" />
      </div>
      <p className="mt-4 text-sm font-semibold text-fg">No skills configured</p>
      <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-fg-subtle">
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

const SKILL_MODEL_OPTIONS = [
  { value: '', label: 'Global default (Haiku 4.5)' },
  ...DREAM_MODEL_OPTIONS,
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

  const handleEnabledToggle = useCallback(
    (checked: boolean) => {
      onSave(skillId, { ...override, enabled: checked });
    },
    [skillId, override, onSave]
  );

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
    <div className="mt-4 border-t border-border-muted/50 pt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Gear size={12} className="text-fg-muted" />
          <span className="text-xs font-medium text-fg">Upskill Analysis</span>
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
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-fg">Include in upskill cycles</div>
            <div className="text-[11px] text-fg-subtle">
              {override?.enabled !== undefined ? 'Custom override' : 'Using global setting'}
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={handleEnabledToggle} />
        </div>

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
            {SKILL_MODEL_OPTIONS.map((opt) => (
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
// Synced skill row (card-based, visually polished)
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
        'rounded-lg border border-border bg-surface transition-all duration-200',
        'cursor-pointer',
        expanded ? 'shadow-sm' : 'hover:border-fg-subtle hover:shadow-md'
      )}
      style={
        expanded
          ? { background: 'linear-gradient(135deg, rgba(88,166,255,0.04) 0%, transparent 60%)' }
          : undefined
      }
    >
      {/* biome-ignore lint/a11y/useSemanticElements: div wraps nested interactive elements (toggle, select, input) that cannot be inside a button */}
      <div
        className="flex items-center gap-3 px-4 py-3.5"
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
        {/* Icon badge */}
        <div
          className={cn(
            'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
            hasData ? 'bg-[rgba(217,119,87,0.12)]' : 'bg-[rgba(88,166,255,0.12)]',
            hasData ? 'text-[#d97757]' : 'text-[#58a6ff]'
          )}
        >
          <Lightning size={18} />
        </div>

        {/* Name + source badge + tags + description */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="truncate text-sm font-medium text-fg">{skill.name}</span>
            <span
              className={cn(
                'flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                source.bg,
                source.text
              )}
            >
              {source.label}
            </span>
          </div>
          {skill.tags && skill.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {skill.tags.slice(0, 3).map((tag) => {
                const colors = getTagColor(tag);
                return (
                  <span
                    key={tag}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      colors.bg,
                      colors.text
                    )}
                  >
                    <Tag size={9} weight="bold" />
                    {tag}
                  </span>
                );
              })}
              {skill.tags.length > 3 && (
                <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-surface-muted text-fg-subtle">
                  +{skill.tags.length - 3}
                </span>
              )}
            </div>
          )}
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
              <div className="flex items-center gap-1.5">
                <div className="h-1 w-12 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full rounded-full bg-success transition-all duration-300"
                    style={{ width: `${(metrics.successRate ?? 0) * 100}%` }}
                  />
                </div>
                <span className="tabular-nums font-medium text-fg">
                  {Math.round((metrics.successRate ?? 0) * 100)}%
                </span>
              </div>
              <span className="tabular-nums">{formatCost(metrics.avgCostUsd)}/run</span>
            </div>
            <span className="flex items-center gap-1 text-[11px] text-fg-subtle">
              <Clock size={11} />
              {formatRelativeDate(metrics.lastRunAt)}
            </span>
            <CaretRight
              size={14}
              className={cn(
                'text-fg-subtle transition-transform duration-200 ease-out',
                expanded && 'rotate-90'
              )}
            />
          </div>
        ) : (
          <div className="flex flex-shrink-0 items-center gap-2">
            <span className="text-[11px] text-fg-subtle">No runs</span>
            <CaretRight
              size={14}
              className={cn(
                'text-fg-subtle transition-transform duration-200 ease-out',
                expanded && 'rotate-90'
              )}
            />
          </div>
        )}
      </div>

      {/* Expanded content -- smooth collapse animation */}
      <div
        className={cn(
          'grid transition-all duration-200 ease-out',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops click from toggling parent when interacting with controls */}
          <div
            className="border-t border-border-muted/50 bg-surface-subtle/30 px-4 py-4"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
          >
            {/* Metrics grid (only when data exists) */}
            {hasData ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-surface p-3">
                  <div className="flex items-center gap-1.5">
                    <ChartBar size={12} className="text-done" />
                    <span className="text-[11px] text-fg-subtle">Total Runs</span>
                  </div>
                  <div className="mt-1.5 text-lg font-semibold tabular-nums text-fg">
                    {metrics.totalRuns}
                  </div>
                </div>
                <div className="rounded-lg bg-surface p-3">
                  <div className="flex items-center gap-1.5">
                    <TrendUp size={12} className="text-success" />
                    <span className="text-[11px] text-fg-subtle">Success Rate</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-success transition-all duration-300"
                        style={{ width: `${(metrics.successRate ?? 0) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-fg">
                      {Math.round((metrics.successRate ?? 0) * 100)}%
                    </span>
                  </div>
                </div>
                <div className="rounded-lg bg-surface p-3">
                  <div className="flex items-center gap-1.5">
                    <CurrencyDollar size={12} className="text-attention" />
                    <span className="text-[11px] text-fg-subtle">Avg Cost</span>
                  </div>
                  <div className="mt-1.5 text-lg font-semibold tabular-nums text-fg">
                    {formatCost(metrics.avgCostUsd)}
                  </div>
                </div>
                <div className="rounded-lg bg-surface p-3">
                  <div className="flex items-center gap-1.5">
                    <Timer size={12} className="text-accent" />
                    <span className="text-[11px] text-fg-subtle">Avg Duration</span>
                  </div>
                  <div className="mt-1.5 text-lg font-semibold tabular-nums text-fg">
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
        </div>
      </div>
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
  const stats = [
    { key: 'skills' as const, label: 'Total Skills', value: totalSkills, icon: Lightning },
    { key: 'tracked' as const, label: 'With Data', value: trackedSkills, icon: CheckCircle },
    { key: 'runs' as const, label: 'Total Runs', value: totalRuns, icon: ChartBar },
    {
      key: 'cost' as const,
      label: 'Total Cost',
      value: formatCost(totalCost),
      icon: CurrencyDollar,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
      {stats.map((item) => (
        <div
          key={item.label}
          className="bg-surface px-4 py-3.5"
          style={STAT_GRADIENT_STYLES[item.key]}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-[6px]',
                STAT_ICON_BADGE_STYLES[item.key]
              )}
            >
              <item.icon size={14} weight="bold" />
            </div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
              {item.label}
            </span>
          </div>
          <div className="mt-2 font-mono text-xl font-semibold tabular-nums text-fg">
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
  const [searchQuery, setSearchQuery] = useState('');

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

  const displayedSkills = useMemo(() => {
    let filtered = showTrackedOnly ? allSkills.filter((s) => s.metrics !== null) : allSkills;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        ({ skill }) =>
          skill.name.toLowerCase().includes(q) ||
          skill.description?.toLowerCase().includes(q) ||
          skill.tags?.some((t) => t.toLowerCase().includes(q)) ||
          skill.sourceType.toLowerCase().includes(q)
      );
    }
    return filtered;
  }, [allSkills, showTrackedOnly, searchQuery]);

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
        {/* Banner skeleton */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="bg-surface px-4 py-3.5 space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 animate-pulse rounded-[6px] bg-surface-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-surface-muted" />
              </div>
              <div className="h-6 w-12 animate-pulse rounded bg-surface-muted" />
            </div>
          ))}
        </div>
        {/* Skill card skeletons */}
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface">
              <SkeletonRow />
            </div>
          ))}
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

      {/* Search */}
      <div className="relative">
        <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
        <input
          type="text"
          className={`${INPUT_CLASS} w-full pl-9`}
          placeholder="Search skills..."
          aria-label="Search skills"
          value={searchQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Filter toggle */}
      {skillMetrics.length > 0 && syncedSkills.length > skillMetrics.length && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTrackedOnly(false)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-all duration-150',
              !showTrackedOnly
                ? 'bg-accent text-white shadow-sm'
                : 'bg-surface-muted text-fg-muted hover:bg-surface-subtle hover:text-fg'
            )}
          >
            All ({allSkills.length})
          </button>
          <button
            type="button"
            onClick={() => setShowTrackedOnly(true)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-all duration-150',
              showTrackedOnly
                ? 'bg-accent text-white shadow-sm'
                : 'bg-surface-muted text-fg-muted hover:bg-surface-subtle hover:text-fg'
            )}
          >
            With Data ({skillMetrics.length})
          </button>
        </div>
      )}

      {/* Skills list */}
      <div className="flex flex-col gap-2">
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
