import {
  ArrowRight,
  CaretDown,
  CaretRight,
  CheckCircle,
  Code,
  Lightning,
  Spinner,
  Terminal,
  User,
  WarningCircle,
  Wrench,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useState } from 'react';
import { MarkdownContent } from '@/app/components/ui/markdown-content';
import { cn } from '@/lib/utils/cn';
import type { StreamEntryProps } from '../types';
import { STREAM_ENTRY_TYPE_CONFIG } from '../types';

const entryContainerVariants = cva(
  'flex gap-2.5 rounded transition-colors duration-fast ease-out',
  {
    variants: {
      type: {
        system: 'hover:bg-surface-subtle',
        user: 'bg-accent/5 hover:bg-accent/10',
        assistant: 'bg-done/5 hover:bg-done/10',
        tool: 'bg-attention/5 hover:bg-attention/10',
      },
      isCurrent: {
        true: 'bg-accent/10 border-l-2 border-accent pl-2',
        false: 'p-2',
      },
    },
    defaultVariants: {
      type: 'system',
      isCurrent: false,
    },
  }
);

const typeIcons = {
  system: Terminal,
  user: User,
  assistant: Code,
  tool: Wrench,
} as const;

const statusIcons = {
  running: Spinner,
  complete: CheckCircle,
  error: WarningCircle,
} as const;

const statusColors = {
  running: 'text-accent',
  complete: 'text-success',
  error: 'text-danger',
} as const;

/**
 * Format duration in milliseconds to human readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

function StatusIconDisplay({ status }: { status: keyof typeof statusIcons }): React.JSX.Element {
  const StatusIcon = statusIcons[status];
  const statusColor = statusColors[status];
  return (
    <StatusIcon
      className={cn('h-4 w-4', statusColor, {
        'animate-spin': status === 'running',
      })}
      weight={status === 'running' ? 'regular' : 'fill'}
    />
  );
}

export function StreamEntry({ entry, isCurrent = false }: StreamEntryProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const config = STREAM_ENTRY_TYPE_CONFIG[entry.type];
  const Icon = typeIcons[entry.type];

  return (
    <div
      className={entryContainerVariants({ type: entry.type, isCurrent })}
      data-testid="stream-entry"
      data-entry-type={entry.type}
    >
      {/* Timestamp */}
      <span className="min-w-15 flex-shrink-0 pt-0.5 font-mono text-xs text-fg-subtle">
        {entry.timeOffset}
      </span>

      {/* Content */}
      <div className="flex-1">
        {/* Type label with model and usage */}
        <div className="mb-0.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'flex items-center gap-1 text-xs font-medium uppercase tracking-wide',
                config.textClass
              )}
            >
              <Icon className="h-3 w-3" weight="bold" />
              {config.label}
            </span>

            {/* Model badge inline for assistant messages */}
            {entry.type === 'assistant' && entry.model ? (
              <span className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">
                <Code className="h-3 w-3" weight="bold" />
                {entry.model}
              </span>
            ) : null}
          </div>

          {/* Token usage for assistant messages */}
          {entry.type === 'assistant' && entry.usage && entry.usage.totalTokens > 0 ? (
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <Lightning className="h-3 w-3 text-warning" weight="fill" />
              <span className="tabular-nums">{entry.usage.totalTokens.toLocaleString()}</span>
              <span className="text-fg-subtle">tokens</span>
            </span>
          ) : null}
        </div>

        {/* Main content */}
        {typeof entry.content === 'string' ? (
          <MarkdownContent content={entry.content} className="text-sm leading-normal text-fg" />
        ) : (
          <div className="text-sm leading-normal text-fg">{entry.content}</div>
        )}

        {/* Tool call details */}
        {entry.toolCall ? (
          <div className="mt-2 rounded-md border border-border bg-surface-muted">
            <button
              type="button"
              className="flex w-full items-center justify-between p-3"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              <div className="flex items-center gap-2">
                {/* Status icon */}
                <StatusIconDisplay status={entry.toolCall.status} />
                <span className="font-mono text-xs font-medium text-fg">{entry.toolCall.name}</span>
              </div>

              <div className="flex items-center gap-3">
                {/* Timeline: start -> end (duration) */}
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-fg-subtle">
                  <span>{entry.toolCall.startTimeOffset}</span>
                  {entry.toolCall.endTimeOffset ? (
                    <>
                      <ArrowRight className="h-3 w-3" />
                      <span>{entry.toolCall.endTimeOffset}</span>
                    </>
                  ) : null}
                  {entry.toolCall.duration !== undefined ? (
                    <span className="ml-1 rounded bg-surface-subtle px-1 py-0.5 text-fg-muted">
                      {formatDuration(entry.toolCall.duration)}
                    </span>
                  ) : null}
                </span>

                <span className="flex items-center gap-1 text-xs text-fg-muted">
                  {isExpanded ? (
                    <CaretDown className="h-3 w-3" />
                  ) : (
                    <CaretRight className="h-3 w-3" />
                  )}
                </span>
              </div>
            </button>

            {isExpanded ? (
              <div className="border-t border-border bg-surface-subtle p-3">
                {/* Error message if present */}
                {entry.toolCall.error ? (
                  <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                    {entry.toolCall.error}
                  </div>
                ) : null}
                <pre className="overflow-x-auto font-mono text-xs text-fg-muted">
                  <code>
                    {JSON.stringify(
                      {
                        input: entry.toolCall.input,
                        ...(entry.toolCall.output !== undefined && {
                          output: entry.toolCall.output,
                        }),
                      },
                      null,
                      2
                    )}
                  </code>
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
