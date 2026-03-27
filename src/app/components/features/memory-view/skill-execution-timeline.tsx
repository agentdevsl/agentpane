import type React from 'react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
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

function formatDuration(ms: number | null): string {
  if (ms === null) return '\u2014';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '\u2014';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function formatCost(cost: number | null): string {
  if (cost === null) return '\u2014';
  return `$${cost.toFixed(2)}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

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
              <span className="text-fg-subtle">{formatDate(exec.startedAt ?? exec.createdAt)}</span>
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
