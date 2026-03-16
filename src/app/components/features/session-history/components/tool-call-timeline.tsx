import { Wrench } from '@phosphor-icons/react';
import type * as React from 'react';
import { useMemo } from 'react';
import { Skeleton } from '@/app/components/ui/skeleton';
import { cn } from '@/lib/utils/cn';
import type { ToolCallTimelineProps } from '../types';
import { ToolCallCard } from './tool-call-card';
import { ToolCallSummaryBar } from './tool-call-summary-bar';

export function ToolCallTimeline({
  toolCalls,
  stats,
  isLoading = false,
  filterTool,
  onFilterChange,
}: ToolCallTimelineProps): React.JSX.Element {
  // Extract unique tool names for filter options
  const uniqueToolNames = useMemo(() => {
    const names = new Set(toolCalls.map((tc) => tc.tool));
    return Array.from(names).sort();
  }, [toolCalls]);

  // Filter tool calls by selected tool
  const filteredToolCalls = useMemo(() => {
    if (!filterTool) {
      return toolCalls;
    }
    return toolCalls.filter((tc) => tc.tool === filterTool);
  }, [toolCalls, filterTool]);

  const handleFilterChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    onFilterChange?.(value === '' ? undefined : value);
  };

  // Loading state
  if (isLoading) {
    return (
      <section
        className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
        data-testid="tool-call-timeline-loading"
      >
        {/* Header skeleton */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton variant="text" width={16} height={16} />
            <Skeleton variant="text" width={80} height={16} />
            <Skeleton variant="text" width={24} height={18} className="rounded-full" />
          </div>
          <Skeleton variant="text" width={120} height={32} className="rounded" />
        </div>

        {/* Summary bar skeleton */}
        <div className="border-b border-border bg-surface-subtle px-4 py-2">
          <div className="flex items-center gap-4">
            <Skeleton variant="text" width={40} height={14} />
            <Skeleton variant="text" width={60} height={14} />
            <Skeleton variant="text" width={60} height={14} />
            <Skeleton variant="text" width={80} height={14} />
          </div>
        </div>

        {/* Tool call card skeletons */}
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {['skeleton-0', 'skeleton-1', 'skeleton-2'].map((id) => (
            <div key={id} className="rounded-md border border-border bg-surface-subtle p-3">
              <div className="flex items-center gap-3">
                <Skeleton variant="text" width={12} height={12} />
                <Skeleton variant="text" width={40} height={14} />
                <Skeleton variant="text" width={60} height={14} />
                <div className="flex-1" />
                <Skeleton variant="text" width={50} height={16} className="rounded" />
                <Skeleton variant="text" width={60} height={16} className="rounded" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // Empty state
  if (toolCalls.length === 0) {
    return (
      <section
        className="flex flex-col items-center justify-center rounded-lg border border-border bg-surface py-12"
        data-testid="tool-call-timeline-empty"
      >
        <Wrench className="mb-3 h-10 w-10 text-fg-subtle" />
        <h3 className="mb-1 text-sm font-medium text-fg">No tool calls</h3>
        <p className="text-xs text-fg-muted">No tool calls in this session</p>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="tool-call-timeline"
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-fg-muted" weight="bold" />
          <h3 className="text-sm font-semibold text-fg">Tool Calls</h3>
          <span className="inline-flex items-center justify-center rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
            {toolCalls.length}
          </span>
        </div>

        {/* Filter dropdown */}
        {uniqueToolNames.length > 1 && onFilterChange ? (
          <select
            value={filterTool ?? ''}
            onChange={handleFilterChange}
            className={cn(
              'h-8 rounded border border-border bg-surface px-2 text-xs text-fg',
              'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent'
            )}
            aria-label="Filter by tool"
          >
            <option value="">All Tools</option>
            {uniqueToolNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
      </header>

      {/* Summary bar */}
      <ToolCallSummaryBar stats={stats} />

      {/* Tool call list */}
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {filteredToolCalls.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-xs text-fg-muted">No tool calls match the selected filter</p>
          </div>
        ) : (
          filteredToolCalls.map((toolCall) => (
            <ToolCallCard key={toolCall.id} toolCall={toolCall} />
          ))
        )}
      </div>
    </section>
  );
}
