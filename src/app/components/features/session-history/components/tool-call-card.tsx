import {
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Clock,
  Terminal,
  XCircle,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import type { ToolCallCardProps, ToolCallStatus } from '../types';
import { TOOL_CALL_STATUS_COLORS } from '../types';
import { formatDuration } from '../utils/format-duration';

const MAX_PAYLOAD_LENGTH = 500;

const cardVariants = cva('rounded-md border transition-colors duration-fast ease-out', {
  variants: {
    status: {
      running: 'border-accent/40 bg-accent/5',
      complete: 'border-success/40 bg-success/5',
      error: 'border-danger/40 bg-danger/5',
    },
  },
  defaultVariants: {
    status: 'running',
  },
});

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
  {
    variants: {
      status: {
        running: 'bg-accent/15 text-accent animate-pulse',
        complete: 'bg-success/15 text-success',
        error: 'bg-danger/15 text-danger',
      },
    },
    defaultVariants: {
      status: 'running',
    },
  }
);

const statusIcons: Record<
  ToolCallStatus,
  React.ComponentType<{ className?: string; weight?: 'bold' | 'fill' }>
> = {
  running: CircleNotch,
  complete: CheckCircle,
  error: XCircle,
};

function formatPayload(payload: unknown, isExpanded: boolean): string {
  try {
    const jsonString = JSON.stringify(payload, null, 2);

    if (!isExpanded && jsonString.length > MAX_PAYLOAD_LENGTH) {
      return `${jsonString.slice(0, MAX_PAYLOAD_LENGTH)}...`;
    }

    return jsonString;
  } catch (error) {
    console.warn(
      '[ToolCallCard] Failed to serialize payload:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return '[Unable to display payload - serialization failed]';
  }
}

function getInputSummary(input: unknown): string {
  if (input == null) {
    return '';
  }

  try {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;

      // Common tool input patterns
      if ('file_path' in obj && typeof obj.file_path === 'string') {
        return obj.file_path;
      }
      if ('file' in obj && typeof obj.file === 'string') {
        return obj.file;
      }
      if ('path' in obj && typeof obj.path === 'string') {
        return obj.path;
      }
      if ('pattern' in obj && typeof obj.pattern === 'string') {
        return obj.pattern;
      }
      if ('command' in obj && typeof obj.command === 'string') {
        const cmd = obj.command;
        return cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd;
      }
      if ('query' in obj && typeof obj.query === 'string') {
        const query = obj.query;
        return query.length > 50 ? `${query.slice(0, 50)}...` : query;
      }

      // Fallback: show first string value
      for (const value of Object.values(obj)) {
        if (typeof value === 'string' && value.length > 0) {
          return value.length > 50 ? `${value.slice(0, 50)}...` : value;
        }
      }
    }
  } catch (error) {
    console.warn('[ToolCallCard] Error extracting input summary:', error);
    return '';
  }

  return '';
}

export function ToolCallCard({
  toolCall,
  defaultExpanded = false,
  onExpandedChange,
}: ToolCallCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const StatusIcon = statusIcons[toolCall.status];
  const inputSummary = getInputSummary(toolCall.input);
  const hasOutput = toolCall.output !== undefined;
  const hasError = toolCall.status === 'error' && toolCall.error;

  const handleToggle = () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    onExpandedChange?.(newExpanded);
  };

  return (
    <div
      className={cardVariants({ status: toolCall.status })}
      data-testid="tool-call-card"
      data-tool-status={toolCall.status}
    >
      {/* Header - always visible */}
      <button
        type="button"
        className="flex w-full items-center gap-2 p-2.5 text-left"
        onClick={handleToggle}
        aria-expanded={isExpanded}
      >
        {/* Expand/collapse indicator */}
        <span className="flex-shrink-0 text-fg-subtle">
          {isExpanded ? (
            <CaretDown className="h-3.5 w-3.5" weight="bold" />
          ) : (
            <CaretRight className="h-3.5 w-3.5" weight="bold" />
          )}
        </span>

        {/* Timestamp */}
        <span className="min-w-12 flex-shrink-0 font-mono text-xs text-fg-subtle">
          {toolCall.timeOffset}
        </span>

        {/* Tool icon and name */}
        <span className="flex items-center gap-1.5">
          {toolCall.status === 'running' ? (
            <CircleNotch
              className={cn(
                'h-3.5 w-3.5 animate-spin',
                TOOL_CALL_STATUS_COLORS[toolCall.status].text
              )}
              weight="bold"
            />
          ) : (
            <Terminal
              className={cn('h-3.5 w-3.5', TOOL_CALL_STATUS_COLORS[toolCall.status].text)}
              weight="bold"
            />
          )}
          <span className="font-mono text-sm font-medium text-fg">{toolCall.tool}</span>
        </span>

        {/* Input summary (truncated) */}
        {inputSummary ? (
          <span className="truncate text-xs text-fg-muted">{inputSummary}</span>
        ) : null}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Duration badge */}
        {toolCall.duration !== undefined ? (
          <span className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
            <Clock className="h-3 w-3" weight="bold" />
            {formatDuration(toolCall.duration)}
          </span>
        ) : null}

        {/* Status badge */}
        <span className={cn(statusBadgeVariants({ status: toolCall.status }), 'flex-shrink-0')}>
          <StatusIcon
            className={cn('h-3 w-3', toolCall.status === 'running' && 'animate-spin')}
            weight={toolCall.status === 'complete' || toolCall.status === 'error' ? 'fill' : 'bold'}
          />
          {toolCall.status}
        </span>
      </button>

      {/* Expanded content */}
      {isExpanded ? (
        <div className="border-t border-border bg-surface-subtle p-3">
          {/* Error message */}
          {hasError ? (
            <div className="mb-3 rounded border border-danger/30 bg-danger/10 p-2">
              <span className="text-xs font-medium text-danger">Error: </span>
              <span className="text-xs text-danger">{toolCall.error}</span>
            </div>
          ) : null}

          {/* Input section */}
          <div className="mb-3">
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-fg-muted">
              Input
            </span>
            <pre className="overflow-x-auto rounded bg-surface-muted p-2 font-mono text-xs text-fg-muted">
              <code>{formatPayload(toolCall.input, isExpanded)}</code>
            </pre>
          </div>

          {/* Output section */}
          {hasOutput ? (
            <div>
              <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                Output
              </span>
              <pre className="max-h-64 overflow-auto rounded bg-surface-muted p-2 font-mono text-xs text-fg-muted">
                <code>{formatPayload(toolCall.output, isExpanded)}</code>
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
