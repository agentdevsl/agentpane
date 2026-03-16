import { ArrowsInSimple, Coins, CurrencyDollar, Heartbeat, Users } from '@phosphor-icons/react';
import { type ComponentType, useMemo } from 'react';
import type { CliSession, HealthStatus } from './cli-monitor-types';
import { estimateCost, formatTokenCount, getSessionTokenTotal } from './cli-monitor-utils';

function SummaryCard({
  label,
  value,
  detail,
  progressPercent,
  progressColor,
  valueClassName,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  progressPercent?: number;
  progressColor?: string;
  valueClassName?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="flex flex-col gap-1 bg-default px-4 py-3 relative">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        {Icon && <Icon size={16} className="text-fg-subtle" />}
        {label}
      </span>
      <span className={`text-2xl font-bold tabular-nums tracking-tight ${valueClassName ?? ''}`}>
        {value}
      </span>
      <span className="truncate text-xs text-fg-muted">{detail}</span>
      {progressPercent != null && (
        <div className="h-[3px] w-full rounded-full bg-emphasis mt-1">
          <div
            className={`h-full rounded-full transition-all duration-500 ${progressColor ?? 'bg-accent'}`}
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function SummaryStrip({ sessions }: { sessions: CliSession[] }) {
  const flatSessions = useMemo(() => sessions.filter((s) => !s.isSubagent), [sessions]);

  const { totalTokens, totalCost, totalCompactions, workingCount, waitingCount, idleCount } =
    useMemo(() => {
      let tokens = 0;
      let cost = 0;
      let compactions = 0;
      let working = 0;
      let waiting = 0;
      let idle = 0;
      for (const s of flatSessions) {
        tokens += getSessionTokenTotal(s);
        cost += estimateCost(s);
        compactions += s.performanceMetrics?.compactionCount ?? 0;
        if (s.status === 'working') working++;
        else if (s.status === 'waiting_for_approval' || s.status === 'waiting_for_input') waiting++;
        else if (s.status === 'idle') idle++;
      }
      return {
        totalTokens: tokens,
        totalCost: cost,
        totalCompactions: compactions,
        workingCount: working,
        waitingCount: waiting,
        idleCount: idle,
      };
    }, [flatSessions]);

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-px border-b border-border bg-border">
      <SummaryCard
        label="Active Sessions"
        value={flatSessions.length}
        detail={`${workingCount} working \u00B7 ${waitingCount} waiting \u00B7 ${idleCount} idle`}
        progressPercent={flatSessions.length > 0 ? (workingCount / flatSessions.length) * 100 : 0}
        progressColor="bg-success"
        icon={Users}
      />
      <SummaryCard
        label="Total Tokens"
        value={formatTokenCount(totalTokens)}
        detail={`~$${totalCost.toFixed(2)} estimated`}
        progressPercent={totalTokens > 0 ? Math.min((totalTokens / 1_000_000) * 100, 100) : 0}
        progressColor="bg-accent"
        icon={Coins}
      />
      <SummaryCard
        label="Est. Cost"
        value={`$${totalCost.toFixed(2)}`}
        detail={`${formatTokenCount(totalTokens)} total tokens`}
        valueClassName="text-attention"
        icon={CurrencyDollar}
      />
      <CompactionSummaryCard sessions={flatSessions} totalCompactions={totalCompactions} />
      <HealthSummaryCard sessions={flatSessions} />
    </div>
  );
}

const healthColors: Record<HealthStatus, string> = {
  healthy: 'bg-success',
  warning: 'bg-attention',
  critical: 'bg-danger',
};

const healthLabels: Record<HealthStatus, string> = {
  healthy: 'All Healthy',
  warning: 'Warning',
  critical: 'Critical',
};

function getSessionHealth(session: CliSession): HealthStatus {
  return session.performanceMetrics?.healthStatus ?? 'healthy';
}

function CompactionSummaryCard({
  sessions,
  totalCompactions,
}: {
  sessions: CliSession[];
  totalCompactions: number;
}) {
  const { sessionsWithCompactions, fullCount, microCount, avgPressure } = useMemo(() => {
    let withCompactions = 0;
    let full = 0;
    let micro = 0;
    let pressureSum = 0;
    for (const s of sessions) {
      if ((s.performanceMetrics?.compactionCount ?? 0) > 0) withCompactions++;
      pressureSum += s.performanceMetrics?.contextPressure ?? 0;
      const events = s.performanceMetrics?.compactionEvents;
      if (events) {
        for (const e of events) {
          if (e.type === 'compact') full++;
          else micro++;
        }
      }
    }
    return {
      sessionsWithCompactions: withCompactions,
      fullCount: full,
      microCount: micro,
      avgPressure: sessions.length > 0 ? pressureSum / sessions.length : 0,
    };
  }, [sessions]);

  const pressurePct = Math.round(avgPressure * 100);
  const pressureColor =
    avgPressure > 0.9 ? 'bg-danger' : avgPressure > 0.7 ? 'bg-attention' : 'bg-success';

  const detail =
    totalCompactions > 0
      ? `${fullCount} full \u00B7 ${microCount} micro \u00B7 ${sessionsWithCompactions} session${sessionsWithCompactions !== 1 ? 's' : ''}`
      : `${sessionsWithCompactions} session${sessionsWithCompactions !== 1 ? 's' : ''} \u00B7 ${pressurePct}% avg pressure`;

  return (
    <SummaryCard
      label="Compactions"
      value={totalCompactions}
      detail={detail}
      progressPercent={pressurePct}
      progressColor={pressureColor}
      valueClassName={totalCompactions > 0 ? 'text-attention' : ''}
      icon={ArrowsInSimple}
    />
  );
}

function HealthSummaryCard({ sessions }: { sessions: CliSession[] }) {
  const counts = useMemo(() => {
    const c = { healthy: 0, warning: 0, critical: 0 };
    for (const s of sessions) {
      c[getSessionHealth(s)]++;
    }
    return c;
  }, [sessions]);

  const total = sessions.length || 1;
  const healthyPct = (counts.healthy / total) * 100;
  const warningPct = (counts.warning / total) * 100;
  const criticalPct = (counts.critical / total) * 100;

  const worstStatus: HealthStatus =
    counts.critical > 0 ? 'critical' : counts.warning > 0 ? 'warning' : 'healthy';

  return (
    <div className="flex flex-col gap-1 bg-default px-4 py-3 relative">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        <Heartbeat size={16} className="text-fg-subtle" />
        Performance Health
      </span>
      <span className="text-2xl font-bold tabular-nums tracking-tight">
        {healthLabels[worstStatus]}
      </span>
      <span className="truncate text-xs text-fg-muted">
        {counts.healthy} healthy · {counts.warning} warning · {counts.critical} critical
      </span>
      <div className="h-[3px] w-full rounded-full bg-emphasis mt-1 flex overflow-hidden">
        {healthyPct > 0 && (
          <div
            className={`h-full ${healthColors.healthy} transition-all duration-500`}
            style={{ width: `${healthyPct}%` }}
          />
        )}
        {warningPct > 0 && (
          <div
            className={`h-full ${healthColors.warning} transition-all duration-500`}
            style={{ width: `${warningPct}%` }}
          />
        )}
        {criticalPct > 0 && (
          <div
            className={`h-full ${healthColors.critical} transition-all duration-500`}
            style={{ width: `${criticalPct}%` }}
          />
        )}
      </div>
    </div>
  );
}

export { SummaryCard };
