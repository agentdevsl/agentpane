import {
  ArrowRight,
  ArrowSquareOut,
  Brain,
  ChartBar,
  CircleNotch,
  Eye,
  Flask,
  Lightbulb,
  Sparkle,
} from '@phosphor-icons/react';
import type React from 'react';
import { useMemo } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatRelativeDate } from './formatters';
import { useMemory } from './memory-context';

// =============================================================================
// Constants
// =============================================================================

const TILE_STYLES = {
  insights: {
    badge: 'bg-[rgba(88,166,255,0.12)] text-[#58a6ff]',
    gradient: {
      background: 'linear-gradient(135deg, rgba(88,166,255,0.06) 0%, transparent 60%)',
    },
  },
  skills: {
    badge: 'bg-[rgba(63,185,80,0.12)] text-[#3fb950]',
    gradient: {
      background: 'linear-gradient(135deg, rgba(63,185,80,0.06) 0%, transparent 60%)',
    },
  },
  runs: {
    badge: 'bg-[rgba(163,113,247,0.12)] text-[#a371f7]',
    gradient: {
      background: 'linear-gradient(135deg, rgba(163,113,247,0.06) 0%, transparent 60%)',
    },
  },
  suggestions: {
    badge: 'bg-[rgba(210,153,34,0.12)] text-[#d29922]',
    gradient: {
      background: 'linear-gradient(135deg, rgba(210,153,34,0.06) 0%, transparent 60%)',
    },
  },
  suggestionsInactive: {
    badge: 'bg-[rgba(139,148,158,0.12)] text-[#8b949e]',
    gradient: {},
  },
  pendingInsights: {
    badge: 'bg-[rgba(210,153,34,0.12)] text-[#d29922]',
    gradient: {
      background: 'linear-gradient(135deg, rgba(210,153,34,0.06) 0%, transparent 60%)',
    },
  },
  pendingInsightsInactive: {
    badge: 'bg-[rgba(139,148,158,0.12)] text-[#8b949e]',
    gradient: {},
  },
} as const;

const ACTIVITY_ICON_STYLES = {
  insight: 'bg-[rgba(88,166,255,0.12)] text-[#58a6ff]',
  dream: 'bg-[rgba(163,113,247,0.12)] text-[#a371f7]',
} as const;

// =============================================================================
// Metric tile
// =============================================================================

function MetricTile({
  icon: Icon,
  label,
  value,
  sublabel,
  tileStyle,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  sublabel?: string;
  tileStyle: { badge: string; gradient: React.CSSProperties };
  onClick?: () => void;
}): React.JSX.Element {
  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      className={cn(
        'group relative flex flex-col gap-1 rounded-xl border bg-surface p-4 text-left transition-all duration-200',
        onClick
          ? 'cursor-pointer border-border hover:border-fg-subtle hover:shadow-md'
          : 'border-border'
      )}
      style={tileStyle.gradient}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      <div className="flex items-center justify-between">
        <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', tileStyle.badge)}>
          <Icon size={18} />
        </div>
        {onClick && (
          <ArrowRight
            size={14}
            className="text-fg-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        )}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-fg">{value}</div>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      {sublabel && <div className="text-[11px] text-fg-subtle">{sublabel}</div>}
    </Wrapper>
  );
}

// =============================================================================
// Activity feed
// =============================================================================

function ActivityFeed({
  items,
}: {
  items: Array<{ label: string; time: string; icon: React.ReactNode; iconStyle: string }>;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(139,148,158,0.12)]">
          <ChartBar className="h-5 w-5 text-[#8b949e]" />
        </div>
        <p className="mt-3 text-sm font-medium text-fg-muted">No recent activity</p>
        <p className="mt-1 text-xs text-fg-subtle">
          Activity from insights and upskill cycles will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 transition-all duration-200 hover:border-fg-subtle hover:shadow-sm"
        >
          <div
            className={cn(
              'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[6px]',
              item.iconStyle
            )}
          >
            {item.icon}
          </div>
          <span className="flex-1 text-sm text-fg line-clamp-2">{item.label}</span>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-fg-subtle">{item.time}</span>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Main overview
// =============================================================================

export function MemoryOverview(): React.JSX.Element {
  const {
    codespaceId,
    health,
    healthLoading,
    insights,
    insightStatusFilter,
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
  // Only compute pending count from insights when unfiltered; filtered results may omit pending items
  const pendingInsightCount =
    insightStatusFilter === 'all'
      ? insights.filter((i) => i.status === 'pending_review').length
      : 0;
  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;
  const totalSkills = new Set([
    ...syncedSkills.map((s) => s.id),
    ...skillMetrics.map((m) => m.skillId),
  ]).size;
  const totalRuns = skillMetrics.reduce((sum, m) => sum + m.totalRuns, 0);
  const totalCost = skillMetrics.reduce((sum, m) => sum + (m.avgCostUsd ?? 0) * m.totalRuns, 0);

  const recentActivity = useMemo(() => {
    const items: Array<{
      label: string;
      time: string;
      icon: React.ReactNode;
      iconStyle: string;
      date: Date;
    }> = [];

    for (const insight of insights.slice(0, 3)) {
      items.push({
        label: insight.content,
        time: formatRelativeDate(insight.createdAt),
        icon: <Lightbulb size={14} weight="fill" />,
        iconStyle: ACTIVITY_ICON_STYLES.insight,
        date: new Date(insight.createdAt),
      });
    }

    for (const session of dreamSessions.slice(0, 2)) {
      items.push({
        label: `Upskill cycle: ${session.suggestionsGenerated} suggestions from ${session.skillsAnalyzed} skills`,
        time: formatRelativeDate(session.startedAt),
        icon: <Sparkle size={14} weight="fill" />,
        iconStyle: ACTIVITY_ICON_STYLES.dream,
        date: new Date(session.startedAt),
      });
    }

    return items.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5);
  }, [insights, dreamSessions]);

  return (
    <div className="flex flex-col gap-6">
      {/* Status bar */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'inline-block h-2 w-2 rounded-full',
              healthLoading && 'bg-fg-subtle animate-pulse',
              !healthLoading && isAvailable && 'bg-success',
              !healthLoading && !isAvailable && 'bg-danger'
            )}
          />
          <span className="text-sm text-fg-muted">
            {healthLoading ? 'Connecting...' : isAvailable ? 'Memory Online' : 'Memory Offline'}
          </span>
          {codespaceId === null && (
            <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
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
                <Sparkle size={14} />
                Analyze Skills
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricTile
          icon={Lightbulb}
          label="Insights"
          value={insightCount}
          sublabel={insightCount > 0 ? 'Stored observations' : 'None captured yet'}
          tileStyle={TILE_STYLES.insights}
          onClick={() => setActiveTab('insights')}
        />
        <MetricTile
          icon={Eye}
          label="Pending Insights"
          value={pendingInsightCount}
          sublabel={pendingInsightCount > 0 ? 'Awaiting review' : 'None pending'}
          tileStyle={
            pendingInsightCount > 0
              ? TILE_STYLES.pendingInsights
              : TILE_STYLES.pendingInsightsInactive
          }
          onClick={pendingInsightCount > 0 ? () => setActiveTab('insights') : undefined}
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
          tileStyle={TILE_STYLES.skills}
          onClick={() => setActiveTab('skills')}
        />
        <MetricTile
          icon={ChartBar}
          label="Total Runs"
          value={totalRuns}
          sublabel={totalCost > 0 ? `${formatCost(totalCost)} total cost` : 'No executions yet'}
          tileStyle={TILE_STYLES.runs}
          onClick={() => setActiveTab('skills')}
        />
        <MetricTile
          icon={Sparkle}
          label="Suggestions"
          value={pendingCount}
          sublabel={pendingCount > 0 ? 'Pending review' : 'None pending'}
          tileStyle={pendingCount > 0 ? TILE_STYLES.suggestions : TILE_STYLES.suggestionsInactive}
          onClick={pendingCount > 0 ? () => setActiveTab('dream') : undefined}
        />
      </div>

      {/* Recent activity */}
      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
          Recent Activity
        </h3>
        <ActivityFeed items={recentActivity} />
      </div>

      {/* Research references */}
      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Research</h3>
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-done-subtle">
              <Flask size={18} className="text-done" />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-fg">
                AgentPane's memory system is inspired by research on automated context optimization
                for LLM agents.
              </p>
              <div className="flex flex-col gap-1">
                <a
                  href="https://yoonholee.com/meta-harness/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent-emphasis transition-colors"
                >
                  <span className="font-medium">
                    Meta-Harness: End-to-End Optimization of Model Harnesses
                  </span>
                  <ArrowSquareOut
                    size={12}
                    className="opacity-60 group-hover:opacity-100 transition-opacity"
                  />
                </a>
                <span className="text-[11px] text-fg-subtle">
                  Lee et al., Stanford &amp; MIT, 2026 — Credit assignment and outer-loop
                  optimization for context selection
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
