import { Cube } from '@phosphor-icons/react';
import type React from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils/cn';
import { formatCost } from './formatters';
import { useMemory } from './memory-context';
import { SkillMetricsCard } from './skill-metrics-card';
import type { SkillMetrics, SyncedSkill } from './types';

// =============================================================================
// Skeleton / Empty states
// =============================================================================

function SkeletonCard(): React.JSX.Element {
  return (
    <div className="animate-pulse rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-24 rounded bg-surface-muted" />
          <div className="h-4 w-14 rounded-full bg-surface-muted" />
        </div>
        <div className="h-3.5 w-3.5 rounded bg-surface-muted" />
      </div>
      <div className="mt-3 h-2 w-full rounded-full bg-surface-muted" />
      <div className="mt-3 grid grid-cols-3 gap-4">
        <div className="space-y-1">
          <div className="h-3 w-14 rounded bg-surface-muted" />
          <div className="h-4 w-10 rounded bg-surface-muted" />
        </div>
        <div className="space-y-1">
          <div className="h-3 w-14 rounded bg-surface-muted" />
          <div className="h-4 w-10 rounded bg-surface-muted" />
        </div>
        <div className="space-y-1">
          <div className="h-3 w-14 rounded bg-surface-muted" />
          <div className="h-4 w-10 rounded bg-surface-muted" />
        </div>
      </div>
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Cube className="h-10 w-10 text-fg-subtle" />
      <p className="mt-3 text-sm font-medium text-fg-muted">No skills configured</p>
      <p className="mt-1 text-xs text-fg-subtle">
        Skills will appear here once configured in a codespace template.
      </p>
    </div>
  );
}

// =============================================================================
// Synced skill card (no execution data)
// =============================================================================

const SOURCE_BADGE: Record<string, string> = {
  org: 'bg-accent-subtle text-accent',
  project: 'bg-success-subtle text-success',
  local: 'bg-done-subtle text-done',
};

function SyncedSkillCard({ skill }: { skill: SyncedSkill }): React.JSX.Element {
  const badgeClass = SOURCE_BADGE[skill.sourceType] ?? 'bg-surface-muted text-fg-muted';

  return (
    <div className="rounded-lg border border-dashed border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{skill.name}</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', badgeClass)}>
            {skill.sourceType}
          </span>
        </div>
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-subtle">
          No runs
        </span>
      </div>
      {skill.description && (
        <p className="mt-2 text-xs text-fg-muted line-clamp-2">{skill.description}</p>
      )}
      {skill.tags && skill.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {skill.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] text-fg-subtle"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Aggregate stats
// =============================================================================

function AggregateBanner({
  totalSkills,
  trackedSkills,
  totalRuns,
  overallSuccessRate,
  totalCost,
}: {
  totalSkills: number;
  trackedSkills: number;
  totalRuns: number;
  overallSuccessRate: number;
  totalCost: number;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <div>
          <div className="text-xs text-fg-subtle font-medium uppercase tracking-wider">
            Total Skills
          </div>
          <div className="mt-1 text-xl font-semibold text-fg">{totalSkills}</div>
        </div>
        <div>
          <div className="text-xs text-fg-subtle font-medium uppercase tracking-wider">
            With Data
          </div>
          <div className="mt-1 text-xl font-semibold text-fg">{trackedSkills}</div>
        </div>
        <div>
          <div className="text-xs text-fg-subtle font-medium uppercase tracking-wider">
            Total Runs
          </div>
          <div className="mt-1 text-xl font-semibold text-fg">{totalRuns}</div>
        </div>
        <div>
          <div className="text-xs text-fg-subtle font-medium uppercase tracking-wider">
            Success Rate
          </div>
          <div className="mt-1 text-xl font-semibold text-fg">
            {Math.round(overallSuccessRate)}%
          </div>
        </div>
        <div>
          <div className="text-xs text-fg-subtle font-medium uppercase tracking-wider">
            Total Cost
          </div>
          <div className="mt-1 text-xl font-semibold text-fg">{formatCost(totalCost)}</div>
        </div>
      </div>
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
    skillExecutions,
    loadExecutions,
  } = useMemory();

  // Build a set of skill IDs that have execution metrics
  const metricsById = useMemo(() => {
    const map = new Map<string, SkillMetrics>();
    for (const m of skillMetrics) {
      map.set(m.skillId, m);
    }
    return map;
  }, [skillMetrics]);

  // Skills with metrics (shown as full metric cards)
  // Skills without metrics but synced (shown as simple cards)
  const untracked = useMemo(() => {
    return syncedSkills.filter((s) => !metricsById.has(s.id));
  }, [syncedSkills, metricsById]);

  const aggregates = useMemo(() => {
    const totalSkills = new Set([
      ...syncedSkills.map((s) => s.id),
      ...skillMetrics.map((m) => m.skillId),
    ]).size;
    const trackedSkills = skillMetrics.length;
    const totalRuns = skillMetrics.reduce((sum, m) => sum + m.totalRuns, 0);
    const totalSuccess = skillMetrics.reduce((sum, m) => sum + m.successCount, 0);
    const overallSuccessRate = totalRuns > 0 ? (totalSuccess / totalRuns) * 100 : 0;
    const totalCost = skillMetrics.reduce((sum, m) => sum + (m.avgCostUsd ?? 0) * m.totalRuns, 0);
    return { totalSkills, trackedSkills, totalRuns, overallSuccessRate, totalCost };
  }, [syncedSkills, skillMetrics]);

  const isLoading = skillMetricsLoading || syncedSkillsLoading;
  const hasAny = skillMetrics.length > 0 || syncedSkills.length > 0;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-20 animate-pulse rounded-lg bg-surface-muted" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (!hasAny) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-4">
      <AggregateBanner
        totalSkills={aggregates.totalSkills}
        trackedSkills={aggregates.trackedSkills}
        totalRuns={aggregates.totalRuns}
        overallSuccessRate={aggregates.overallSuccessRate}
        totalCost={aggregates.totalCost}
      />

      {/* Skills with execution data */}
      {skillMetrics.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">
            Skills with Execution Data{' '}
            <span className="text-fg-muted">({skillMetrics.length})</span>
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {skillMetrics.map((metric) => (
              <SkillMetricsCard
                key={metric.id}
                metric={metric}
                expanded={expandedSkillId === metric.skillId}
                onToggle={() =>
                  setExpandedSkillId(expandedSkillId === metric.skillId ? null : metric.skillId)
                }
                executions={skillExecutions.get(metric.skillId)}
                onLoadExecutions={() => void loadExecutions(metric.skillId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Synced skills without execution data */}
      {untracked.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">
            Synced Skills <span className="text-fg-muted">({untracked.length})</span>
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {untracked.map((skill) => (
              <SyncedSkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
