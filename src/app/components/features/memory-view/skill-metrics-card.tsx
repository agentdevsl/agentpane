import { CaretDown, CaretUp } from '@phosphor-icons/react';
import type React from 'react';
import { useRef } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import { SkillExecutionTimeline } from './skill-execution-timeline';
import type { SkillExecution, SkillMetrics } from './types';

interface SkillMetricsCardProps {
  metric: SkillMetrics;
  expanded: boolean;
  onToggle: () => void;
  executions: Array<SkillExecution> | undefined;
  onLoadExecutions: () => void;
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

function formatDuration(ms: number | null): string {
  if (ms === null) return '\u2014';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
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

export function SkillMetricsCard({
  metric,
  expanded,
  onToggle,
  executions,
  onLoadExecutions,
}: SkillMetricsCardProps): React.JSX.Element {
  const loadedRef = useRef(false);

  useWatchEffect(() => {
    if (expanded && !loadedRef.current) {
      loadedRef.current = true;
      onLoadExecutions();
    }
  }, [expanded, onLoadExecutions]);

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
        <div className="flex-1 rounded-full bg-surface-muted h-2">
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
