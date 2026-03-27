import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import type React from 'react';
import { cn } from '@/lib/utils/cn';

import type { DreamSession } from './types';

interface DreamSessionCardProps {
  session: DreamSession;
}

const TYPE_LABELS: Record<string, string> = {
  conclusion_derivation: 'Conclusions',
  skill_improvement: 'Skills',
  metrics_rollup: 'Metrics',
};

const TYPE_BADGE_STYLES: Record<string, string> = {
  conclusion_derivation: 'bg-accent-subtle text-accent',
  skill_improvement: 'bg-done-subtle text-done',
  metrics_rollup: 'bg-success-subtle text-success',
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '--';
  return `$${costUsd.toFixed(4)}`;
}

function StatusIndicator({ status }: { status: string }): React.JSX.Element {
  if (status === 'running') {
    return <CircleNotch size={16} className="animate-spin text-accent" />;
  }
  if (status === 'completed') {
    return <CheckCircle size={16} weight="fill" className="text-success" />;
  }
  if (status === 'error') {
    return <WarningCircle size={16} weight="fill" className="text-danger" />;
  }
  return <CircleNotch size={16} className="text-fg-subtle" />;
}

export function DreamSessionCard({ session }: DreamSessionCardProps): React.JSX.Element {
  const typeLabel = TYPE_LABELS[session.type] ?? session.type;
  const typeBadgeClass = TYPE_BADGE_STYLES[session.type] ?? 'bg-surface-muted text-fg-muted';

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', typeBadgeClass)}
          >
            {typeLabel}
          </span>
          <StatusIndicator status={session.status} />
        </div>
        <span className="text-[10px] text-fg-subtle">{session.id.slice(0, 8)}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>
          <span className="font-medium text-fg">{session.skillsAnalyzed}</span> skills analyzed
        </span>
        <span>
          <span className="font-medium text-fg">{session.suggestionsGenerated}</span> suggestions
        </span>
        <span>
          <span className="font-medium text-fg">{session.tokensUsed.toLocaleString()}</span> tokens
        </span>
        <span>Cost: {formatCost(session.costUsd)}</span>
      </div>

      <div className="mt-2 flex items-center gap-3 text-[11px] text-fg-subtle">
        <span>Started {formatTimestamp(session.startedAt)}</span>
        <span>
          {session.completedAt ? `Completed ${formatTimestamp(session.completedAt)}` : 'Running...'}
        </span>
      </div>

      {session.status === 'error' && session.errorMessage && (
        <div className="mt-2 rounded-md bg-danger-subtle p-2 text-xs text-danger">
          {session.errorMessage}
        </div>
      )}
    </div>
  );
}
