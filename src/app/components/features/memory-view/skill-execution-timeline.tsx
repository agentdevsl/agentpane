import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatDuration, formatRelativeDate, formatTokens } from './formatters';
import type { SkillExecution } from './types';

interface SkillExecutionTimelineProps {
  executions: Array<SkillExecution>;
}

const INITIAL_VISIBLE = 10;

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  success: { color: 'bg-success', label: 'Success' },
  failed: { color: 'bg-danger', label: 'Failed' },
  cancelled: { color: 'bg-fg-subtle', label: 'Cancelled' },
  turn_limit: { color: 'bg-attention', label: 'Turn Limit' },
};

export function SkillExecutionTimeline({
  executions,
}: SkillExecutionTimelineProps): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? executions : executions.slice(0, INITIAL_VISIBLE);
  const hasMore = executions.length > INITIAL_VISIBLE;

  if (executions.length === 0) {
    return <div className="py-3 pl-6 text-xs text-fg-muted">No execution records found.</div>;
  }

  return (
    <div className="border-l-2 border-border ml-4 mt-3">
      {visible.map((exec) => {
        const config = STATUS_CONFIG[exec.status] ?? { color: 'bg-fg-subtle', label: 'Unknown' };
        return (
          <div key={exec.id} className="relative pl-6 pb-3 last:pb-0">
            <div
              className={cn('absolute left-[-5px] top-1.5 h-2 w-2 rounded-full', config.color)}
            />
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-medium text-fg">{config.label}</span>
              <span className="text-fg-muted">{formatDuration(exec.durationMs)}</span>
              <span className="text-fg-muted">{formatTokens(exec.tokensUsed)} tokens</span>
              <span className="text-fg-muted">{formatCost(exec.costUsd)}</span>
              <span className="text-fg-subtle">
                {formatRelativeDate(exec.startedAt ?? exec.createdAt)}
              </span>
            </div>
            {exec.status === 'failed' && exec.errorMessage && (
              <div className="mt-1 text-xs text-danger">{exec.errorMessage}</div>
            )}
          </div>
        );
      })}
      {hasMore && !showAll && (
        <div className="pl-6 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Show {executions.length - INITIAL_VISIBLE} more
          </Button>
        </div>
      )}
    </div>
  );
}
