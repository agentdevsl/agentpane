import {
  ArrowRight,
  Brain,
  ChartBar,
  CircleNotch,
  Lightbulb,
  Sparkle,
  SunHorizon,
} from '@phosphor-icons/react';
import type React from 'react';
import { useMemo } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatRelativeDate } from './formatters';
import { useMemory } from './memory-context';

function MetricTile({
  icon: Icon,
  label,
  value,
  sublabel,
  accent,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  sublabel?: string;
  accent?: string;
  onClick?: () => void;
}): React.JSX.Element {
  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      className={cn(
        'group relative flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-left transition',
        onClick && 'cursor-pointer hover:border-accent/40 hover:shadow-sm'
      )}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      <div className="flex items-center justify-between">
        <div className={cn('rounded-md p-1.5', accent ?? 'bg-surface-muted')}>
          <Icon size={16} className="text-fg-muted" />
        </div>
        {onClick && (
          <ArrowRight
            size={14}
            className="text-fg-subtle opacity-0 transition group-hover:opacity-100"
          />
        )}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-fg">{value}</div>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      {sublabel && <div className="text-[11px] text-fg-subtle">{sublabel}</div>}
    </Wrapper>
  );
}

function ActivityFeed({
  items,
}: {
  items: Array<{ label: string; time: string; icon: React.ReactNode }>;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border py-8">
        <p className="text-xs text-fg-subtle">No recent activity</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex-shrink-0 text-fg-subtle">{item.icon}</div>
          <span className="flex-1 truncate text-sm text-fg">{item.label}</span>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-fg-subtle">{item.time}</span>
        </div>
      ))}
    </div>
  );
}

export function MemoryOverview(): React.JSX.Element {
  const {
    codespaceId,
    health,
    healthLoading,
    insights,
    syncedSkills,
    skillMetrics,
    dreamSessions,
    suggestions,
    isDreamRunning,
    setActiveTab,
    triggerDream,
  } = useMemory();

  const isAvailable = health?.available ?? false;
  const insightCount = health?.insightCount ?? insights.length;
  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;
  const totalSkills = new Set([
    ...syncedSkills.map((s) => s.id),
    ...skillMetrics.map((m) => m.skillId),
  ]).size;
  const totalRuns = skillMetrics.reduce((sum, m) => sum + m.totalRuns, 0);
  const totalCost = skillMetrics.reduce((sum, m) => sum + (m.avgCostUsd ?? 0) * m.totalRuns, 0);

  const recentActivity = useMemo(() => {
    const items: Array<{ label: string; time: string; icon: React.ReactNode; date: Date }> = [];

    for (const insight of insights.slice(0, 3)) {
      items.push({
        label: insight.content.slice(0, 80) + (insight.content.length > 80 ? '...' : ''),
        time: formatRelativeDate(insight.createdAt),
        icon: <Lightbulb size={14} />,
        date: new Date(insight.createdAt),
      });
    }

    for (const session of dreamSessions.slice(0, 2)) {
      items.push({
        label: `Dream cycle: ${session.suggestionsGenerated} suggestions from ${session.skillsAnalyzed} skills`,
        time: formatRelativeDate(session.startedAt),
        icon: <SunHorizon size={14} />,
        date: new Date(session.startedAt),
      });
    }

    return items.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
  }, [insights, dreamSessions]);

  return (
    <div className="flex flex-col gap-6">
      {/* Status bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full',
              healthLoading
                ? 'bg-fg-subtle animate-pulse'
                : isAvailable
                  ? 'bg-success'
                  : 'bg-danger'
            )}
          />
          <span className="text-sm text-fg-muted">
            {healthLoading ? 'Connecting...' : isAvailable ? 'Memory Online' : 'Memory Offline'}
          </span>
          {codespaceId === null && (
            <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-accent">
              Global
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isDreamRunning || !codespaceId}
            onClick={() => void triggerDream()}
            className="gap-1.5"
          >
            {isDreamRunning ? (
              <>
                <CircleNotch size={14} className="animate-spin" />
                Running...
              </>
            ) : (
              <>
                <SunHorizon size={14} />
                Dream Cycle
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          icon={Lightbulb}
          label="Insights"
          value={insightCount}
          sublabel={insightCount > 0 ? 'Stored observations' : 'None captured yet'}
          accent="bg-accent-subtle"
          onClick={() => setActiveTab('insights')}
        />
        <MetricTile
          icon={Brain}
          label="Skills"
          value={totalSkills}
          sublabel={
            skillMetrics.length > 0
              ? `${skillMetrics.length} with execution data`
              : 'Synced from templates'
          }
          accent="bg-success-subtle"
          onClick={() => setActiveTab('skills')}
        />
        <MetricTile
          icon={ChartBar}
          label="Total Runs"
          value={totalRuns}
          sublabel={totalCost > 0 ? `${formatCost(totalCost)} total cost` : 'No executions yet'}
          accent="bg-done-subtle"
          onClick={() => setActiveTab('skills')}
        />
        <MetricTile
          icon={Sparkle}
          label="Suggestions"
          value={pendingCount}
          sublabel={pendingCount > 0 ? 'Pending review' : 'None pending'}
          accent={pendingCount > 0 ? 'bg-attention-subtle' : 'bg-surface-muted'}
          onClick={pendingCount > 0 ? () => setActiveTab('dream') : undefined}
        />
      </div>

      {/* Recent activity */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
            Recent Activity
          </h3>
        </div>
        <ActivityFeed items={recentActivity} />
      </div>
    </div>
  );
}
