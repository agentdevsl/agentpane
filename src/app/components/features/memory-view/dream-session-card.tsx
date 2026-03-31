import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import type React from 'react';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatTimestamp } from './formatters';

import type { DreamSession } from './types';

interface DreamSessionCardProps {
  session: DreamSession;
  isLast?: boolean;
}

const TYPE_LABELS: Record<DreamSession['type'], string> = {
  conclusion_derivation: 'Conclusions',
  skill_improvement: 'Skills',
  metrics_rollup: 'Metrics',
  context_optimization: 'Context Optimization',
};

const TYPE_BADGE_STYLES: Record<DreamSession['type'], string> = {
  conclusion_derivation: 'bg-accent-subtle text-accent',
  skill_improvement: 'bg-done-subtle text-done',
  metrics_rollup: 'bg-success-subtle text-success',
  context_optimization: 'bg-secondary-subtle text-secondary',
};

const STATUS_DOT_STYLES: Record<DreamSession['status'], string> = {
  running: 'border-accent bg-accent animate-pulse',
  completed: 'border-success bg-success',
  error: 'border-danger bg-danger',
};

function StatusIcon({ status }: { status: DreamSession['status'] }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <CircleNotch size={12} className="animate-spin text-accent" aria-label="Running" />;
    case 'completed':
      return (
        <CheckCircle size={12} weight="fill" className="text-success" aria-label="Completed" />
      );
    case 'error':
      return <WarningCircle size={12} weight="fill" className="text-danger" aria-label="Error" />;
    default: {
      const _exhaustive: never = status;
      return <span>{String(_exhaustive)}</span>;
    }
  }
}

export function DreamSessionCard({
  session,
  isLast = false,
}: DreamSessionCardProps): React.JSX.Element {
  const typeLabel = TYPE_LABELS[session.type] ?? session.type;
  const typeBadgeClass = TYPE_BADGE_STYLES[session.type] ?? 'bg-surface-muted text-fg-muted';
  const dotClass = STATUS_DOT_STYLES[session.status] ?? 'border-fg-subtle bg-fg-subtle';

  return (
    <div className="relative flex gap-3 pl-1">
      {/* Timeline line + dot */}
      <div className="flex flex-col items-center">
        <div className={cn('h-2.5 w-2.5 rounded-full border-2 flex-shrink-0 mt-1', dotClass)} />
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusIcon status={session.status} />
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              typeBadgeClass
            )}
          >
            {typeLabel}
          </span>
          <span className="text-xs text-fg-muted">
            <span className="font-medium text-fg">{session.skillsAnalyzed}</span> skills
            {' \u00B7 '}
            <span className="font-medium text-fg">{session.suggestionsGenerated}</span> suggestions
            {' \u00B7 '}
            {formatCost(session.costUsd, 4)}
          </span>
          <span className="ml-auto font-mono text-[10px] text-fg-subtle">
            {session.id.slice(0, 8)}
          </span>
        </div>

        <div className="mt-0.5 text-[11px] text-fg-subtle">
          {formatTimestamp(session.startedAt)}
          {session.completedAt && ` \u2014 ${formatTimestamp(session.completedAt)}`}
          {!session.completedAt && session.status === 'running' && ' \u2014 running...'}
        </div>

        {session.status === 'error' && session.errorMessage && (
          <div className="mt-1.5 rounded-md bg-danger-subtle border border-danger/20 px-2.5 py-1.5 text-[11px] text-danger">
            {session.errorMessage}
          </div>
        )}
      </div>
    </div>
  );
}
