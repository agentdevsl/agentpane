import { CaretDown, CaretUp } from '@phosphor-icons/react';
import type React from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import { formatCost, formatDuration, formatRelativeDate, formatTokens } from './formatters';
import { SkillExecutionTimeline } from './skill-execution-timeline';
import type { SkillExecution, SkillMetrics } from './types';

interface SkillMetricsCardProps {
  metric: SkillMetrics;
  expanded: boolean;
  onToggle: () => void;
  executions: Array<SkillExecution> | undefined;
  onLoadExecutions: () => void;
}

export function SkillMetricsCard({
  metric,
  expanded,
  onToggle,
  executions,
  onLoadExecutions,
}: SkillMetricsCardProps): React.JSX.Element {
  // Load executions on first expand; re-load if executions were cleared (e.g. after refresh)
  useWatchEffect(() => {
    if (expanded && !executions) {
      onLoadExecutions();
    }
  }, [expanded, executions, onLoadExecutions]);

  const successRate = metric.successRate ?? 0;
  const CaretIcon = expanded ? CaretUp : CaretDown;

  return (
    // biome-ignore lint/a11y/useSemanticElements: Card contains nested interactive elements (timeline buttons), can't use <button>
    <div
      className={cn(
        'rounded-lg border border-border bg-surface p-4 cursor-pointer transition',
        'hover:border-accent/50'
      )}
      onClick={onToggle}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{metric.skillName}</span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-fg-muted">
            {metric.totalRuns} runs
          </span>
        </div>
        <CaretIcon size={14} className="text-fg-muted" />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div
          className="flex-1 rounded-full bg-surface-muted h-2"
          role="progressbar"
          aria-valuenow={Math.round(successRate)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${Math.round(successRate)}% success rate`}
        >
          <div
            className="rounded-full bg-success h-2 transition-all"
            style={{ width: `${successRate}%` }}
          />
        </div>
        <span className="text-xs text-fg-muted whitespace-nowrap">
          {Math.round(successRate)}% success
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4 mt-3">
        <div>
          <div className="text-xs text-fg-subtle">Avg Tokens</div>
          <div className="text-sm font-medium text-fg">{formatTokens(metric.avgTokensUsed)}</div>
        </div>
        <div>
          <div className="text-xs text-fg-subtle">Avg Cost</div>
          <div className="text-sm font-medium text-fg">{formatCost(metric.avgCostUsd)}</div>
        </div>
        <div>
          <div className="text-xs text-fg-subtle">Avg Duration</div>
          <div className="text-sm font-medium text-fg">{formatDuration(metric.avgDurationMs)}</div>
        </div>
      </div>

      <div className="mt-3 text-xs text-fg-muted">
        Last run: {formatRelativeDate(metric.lastRunAt)}
      </div>

      {expanded && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stops click from toggling parent when interacting with timeline
        <div
          className="mt-3 border-t border-border pt-3"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        >
          {executions ? (
            <SkillExecutionTimeline executions={executions} />
          ) : (
            <div className="py-2 text-xs text-fg-muted">Loading executions...</div>
          )}
        </div>
      )}
    </div>
  );
}
