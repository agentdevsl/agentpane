import { CaretRight, Cube, Lightning } from '@phosphor-icons/react';
import type React from 'react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatDuration, formatRelativeDate } from './formatters';
import { useMemory } from './memory-context';
import type { SkillMetrics, SyncedSkill } from './types';

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
// Synced skill row (compact, informational)
// =============================================================================

function SyncedSkillRow({
  skill,
  metrics,
  expanded,
  onToggle,
}: {
  skill: SyncedSkill;
  metrics: SkillMetrics | null;
  expanded: boolean;
  onToggle: () => void;
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
        hasData && 'cursor-pointer hover:bg-surface-subtle/50'
      )}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: role is conditionally set based on hasData */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        onClick={hasData ? onToggle : undefined}
        onKeyDown={
          hasData
            ? (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        role={hasData ? 'button' : undefined}
        tabIndex={hasData ? 0 : undefined}
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
          <span className="flex-shrink-0 text-[11px] text-fg-subtle">No runs</span>
        )}
      </div>

      {/* Expanded metrics */}
      {expanded && hasData && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stops click from toggling parent when interacting with timeline
        <div
          className="border-t border-border bg-surface-subtle/30 px-4 py-3"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        >
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
  } = useMemory();

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
          />
        ))}
      </div>
    </div>
  );
}
