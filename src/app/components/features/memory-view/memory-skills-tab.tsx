import { ChartBar } from '@phosphor-icons/react';
import type React from 'react';
import { useMemo } from 'react';
import { useMemory } from './memory-context';
import { SkillMetricsCard } from './skill-metrics-card';

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
      <ChartBar className="h-10 w-10 text-fg-subtle" />
      <p className="mt-3 text-sm font-medium text-fg-muted">No skills tracked yet</p>
      <p className="mt-1 text-xs text-fg-subtle">
        Skills will appear here once agents start executing tasks.
      </p>
    </div>
  );
}

// =============================================================================
// Aggregate stats
// =============================================================================

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function AggregateBanner({
  totalRuns,
  overallSuccessRate,
  totalCost,
}: {
  totalRuns: number;
  overallSuccessRate: number;
  totalCost: number;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-4">
      <div className="grid grid-cols-3 gap-4">
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
    skillMetrics,
    skillMetricsLoading,
    expandedSkillId,
    setExpandedSkillId,
    skillExecutions,
    loadExecutions,
  } = useMemory();

  const aggregates = useMemo(() => {
    const totalRuns = skillMetrics.reduce((sum, m) => sum + m.totalRuns, 0);
    const totalSuccess = skillMetrics.reduce((sum, m) => sum + m.successCount, 0);
    const overallSuccessRate = totalRuns > 0 ? (totalSuccess / totalRuns) * 100 : 0;
    const totalCost = skillMetrics.reduce((sum, m) => sum + (m.avgCostUsd ?? 0) * m.totalRuns, 0);
    return { totalRuns, overallSuccessRate, totalCost };
  }, [skillMetrics]);

  if (skillMetricsLoading) {
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

  if (skillMetrics.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-4">
      <AggregateBanner
        totalRuns={aggregates.totalRuns}
        overallSuccessRate={aggregates.overallSuccessRate}
        totalCost={aggregates.totalCost}
      />

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
  );
}
