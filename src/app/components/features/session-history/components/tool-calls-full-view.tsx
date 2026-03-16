import {
  Clock,
  Funnel,
  MagnifyingGlass,
  Terminal,
  Timer,
  WarningCircle,
  Wrench,
} from '@phosphor-icons/react';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { Skeleton } from '@/app/components/ui/skeleton';
import { cn } from '@/lib/utils/cn';
import type { ToolCallEntry, ToolCallStats, ToolCallStatus } from '../types';
import { formatDuration } from '../utils/format-duration';
import { ToolCallCard } from './tool-call-card';

export interface ToolCallsFullViewProps {
  /** Tool call entries to display */
  toolCalls: ToolCallEntry[];
  /** Tool call statistics */
  stats: ToolCallStats;
  /** Loading state */
  isLoading?: boolean;
}

export function ToolCallsFullView({
  toolCalls,
  stats,
  isLoading = false,
}: ToolCallsFullViewProps): React.JSX.Element {
  const [filterTool, setFilterTool] = useState<string | undefined>(undefined);
  const [filterStatus, setFilterStatus] = useState<ToolCallStatus | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');

  // Extract unique tool names for filter options
  const uniqueToolNames = useMemo(() => {
    const names = new Set(toolCalls.map((tc) => tc.tool));
    return Array.from(names).sort();
  }, [toolCalls]);

  // Filter tool calls by tool name, status, and search query
  const filteredToolCalls = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return toolCalls.filter((tc) => {
      if (filterTool && tc.tool !== filterTool) return false;
      if (filterStatus && tc.status !== filterStatus) return false;
      if (query) {
        const toolName = tc.tool.toLowerCase();
        const inputText = tc.input != null ? JSON.stringify(tc.input).toLowerCase() : '';
        const errorText = tc.error?.toLowerCase() ?? '';
        if (!toolName.includes(query) && !inputText.includes(query) && !errorText.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [toolCalls, filterTool, filterStatus, searchQuery]);

  const isFiltered = filterTool !== undefined || filterStatus !== undefined || searchQuery !== '';

  const handleFilterChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setFilterTool(value === '' ? undefined : value);
  };

  const handleStatusFilterChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setFilterStatus(value === '' ? undefined : (value as ToolCallStatus));
  };

  const clearFilters = () => {
    setFilterTool(undefined);
    setFilterStatus(undefined);
    setSearchQuery('');
  };

  const hasErrors = stats.errorCount > 0;

  // Loading state
  if (isLoading) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface"
        data-testid="tool-calls-full-view-loading"
      >
        {/* Header skeleton */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Skeleton variant="text" width={16} height={16} />
            <Skeleton variant="text" width={80} height={16} />
            <Skeleton variant="text" width={40} height={20} className="rounded-full" />
          </div>
          <Skeleton variant="text" width={120} height={32} className="rounded" />
        </div>

        {/* Summary bar skeleton */}
        <div className="border-b border-border bg-surface-subtle px-4 py-2">
          <div className="flex items-center gap-4">
            <Skeleton variant="text" width={50} height={14} />
            <Skeleton variant="text" width={50} height={14} />
            <Skeleton variant="text" width={70} height={14} />
            <Skeleton variant="text" width={70} height={14} />
          </div>
        </div>

        {/* Tool call card skeletons */}
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {['skeleton-0', 'skeleton-1', 'skeleton-2', 'skeleton-3', 'skeleton-4'].map((id) => (
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
      </div>
    );
  }

  // Empty state
  if (toolCalls.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-border bg-surface py-12"
        data-testid="tool-calls-full-view-empty"
      >
        <Wrench className="mb-3 h-10 w-10 text-fg-subtle" />
        <h3 className="mb-1 text-sm font-medium text-fg">No tool calls</h3>
        <p className="text-xs text-fg-muted">This session has no tool call activity</p>
      </div>
    );
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="tool-calls-full-view"
    >
      {/* Gradient accent line at top */}
      <div className="absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-warning/20 to-transparent" />

      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <Wrench className="h-4 w-4 text-warning" weight="bold" />
          <h3 className="text-sm font-semibold text-fg">Tool Calls</h3>
          <span className="inline-flex items-center justify-center rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-medium text-warning">
            {isFiltered
              ? `${filteredToolCalls.length} / ${toolCalls.length}`
              : `${toolCalls.length} ${toolCalls.length === 1 ? 'call' : 'calls'}`}
          </span>
        </div>

        <div className="flex flex-1 items-center justify-end gap-2">
          {/* Search input */}
          <div className="relative">
            <MagnifyingGlass className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tool calls..."
              className={cn(
                'h-8 w-48 rounded border border-border bg-surface-subtle pl-7 pr-2 text-xs text-fg placeholder:text-fg-muted',
                'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent'
              )}
              aria-label="Search tool calls"
            />
          </div>

          {/* Status filter dropdown */}
          <div className="flex items-center gap-2">
            <select
              value={filterStatus ?? ''}
              onChange={handleStatusFilterChange}
              className={cn(
                'h-8 rounded border border-border bg-surface-subtle px-2 pr-8 text-xs text-fg',
                'appearance-none',
                'bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 24 24%27 stroke=%27%238b949e%27 stroke-width=%272%27%3E%3Cpath stroke-linecap=%27round%27 stroke-linejoin=%27round%27 d=%27M19 9l-7 7-7-7%27/%3E%3C/svg%3E")] bg-[length:14px] bg-[right_8px_center] bg-no-repeat',
                'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent'
              )}
              aria-label="Filter by status"
            >
              <option value="">All Statuses</option>
              <option value="complete">Complete</option>
              <option value="error">Error</option>
              <option value="running">Running</option>
            </select>
          </div>

          {/* Tool name filter dropdown */}
          {uniqueToolNames.length > 1 ? (
            <div className="flex items-center gap-2">
              <Funnel className="h-3.5 w-3.5 text-fg-subtle" weight="bold" />
              <select
                value={filterTool ?? ''}
                onChange={handleFilterChange}
                className={cn(
                  'h-8 rounded border border-border bg-surface-subtle px-2 pr-8 text-xs text-fg',
                  'appearance-none',
                  'bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 24 24%27 stroke=%27%238b949e%27 stroke-width=%272%27%3E%3Cpath stroke-linecap=%27round%27 stroke-linejoin=%27round%27 d=%27M19 9l-7 7-7-7%27/%3E%3C/svg%3E")] bg-[length:14px] bg-[right_8px_center] bg-no-repeat',
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
            </div>
          ) : null}
        </div>
      </header>

      {/* Summary bar */}
      <div className="shrink-0 border-b border-border bg-surface-subtle px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 text-fg-muted">
            <Terminal className="h-3.5 w-3.5" weight="bold" />
            <span className="font-medium text-fg">{stats.totalCalls}</span> Calls
          </span>

          <span className="h-3 w-px bg-border" />

          <span
            className={cn('flex items-center gap-1.5', hasErrors ? 'text-danger' : 'text-fg-muted')}
          >
            <WarningCircle className="h-3.5 w-3.5" weight="bold" />
            <span className={cn('font-medium', hasErrors ? 'text-danger' : 'text-fg')}>
              {stats.errorCount}
            </span>{' '}
            Errors
          </span>

          <span className="h-3 w-px bg-border" />

          <span className="flex items-center gap-1.5 text-fg-muted">
            <Timer className="h-3.5 w-3.5" weight="bold" />
            Total:{' '}
            <span className="font-medium text-fg">{formatDuration(stats.totalDurationMs)}</span>
          </span>

          <span className="h-3 w-px bg-border" />

          <span className="flex items-center gap-1.5 text-fg-muted">
            <Clock className="h-3.5 w-3.5" weight="bold" />
            Avg: <span className="font-medium text-fg">{formatDuration(stats.avgDurationMs)}</span>
          </span>
        </div>
      </div>

      {/* Tool call list */}
      {filteredToolCalls.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
          <p className="text-xs text-fg-muted">No tool calls match the current filters</p>
          <button
            type="button"
            onClick={clearFilters}
            className="rounded border border-border bg-surface-subtle px-3 py-1.5 text-xs font-medium text-fg hover:bg-surface-muted"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="flex-1 list-none space-y-2 overflow-y-auto p-4" aria-label="Tool call list">
          {filteredToolCalls.map((toolCall) => (
            <li key={toolCall.id}>
              <ToolCallCard toolCall={toolCall} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
