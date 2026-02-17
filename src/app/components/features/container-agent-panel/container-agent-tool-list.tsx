import {
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Code,
  Terminal,
  XCircle,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useState } from 'react';
import type { ContainerAgentToolExecution } from '@/app/hooks/use-container-agent';
import { cn } from '@/lib/utils/cn';

interface ContainerAgentToolListProps {
  tools: ContainerAgentToolExecution[];
}

const toolStatusVariants = cva('flex items-center gap-1', {
  variants: {
    status: {
      running: 'text-accent',
      complete: 'text-success',
      error: 'text-danger',
    },
  },
});

const toolIconMap: Record<string, typeof Terminal> = {
  bash: Terminal,
  read_file: Code,
  write_file: Code,
  edit_file: Code,
  glob: Code,
  grep: Code,
};

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function ToolItem({ tool }: { tool: ContainerAgentToolExecution }): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const Icon = toolIconMap[tool.toolName] ?? Code;

  const statusIcon =
    tool.status === 'running' ? (
      <CircleNotch className="h-3.5 w-3.5 animate-spin" />
    ) : tool.status === 'complete' ? (
      <CheckCircle className="h-3.5 w-3.5" weight="fill" />
    ) : (
      <XCircle className="h-3.5 w-3.5" weight="fill" />
    );

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Tool header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-subtle transition-colors"
      >
        {isExpanded ? (
          <CaretDown className="h-3.5 w-3.5 text-fg-muted" />
        ) : (
          <CaretRight className="h-3.5 w-3.5 text-fg-muted" />
        )}

        <Icon className="h-4 w-4 text-fg-muted" />

        <span className="flex-1 truncate text-sm font-medium text-fg">{tool.toolName}</span>

        <span className={toolStatusVariants({ status: tool.status })}>{statusIcon}</span>

        {tool.durationMs !== undefined && (
          <span className="text-xs text-fg-muted font-mono">{formatDuration(tool.durationMs)}</span>
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border bg-surface-subtle px-3 py-2 space-y-2 min-w-0">
          {/* Input */}
          <div>
            <p className="text-xs font-medium text-fg-muted mb-1">Input</p>
            <pre className="rounded bg-canvas p-2 text-xs text-fg whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
              {formatInput(tool.input)}
            </pre>
          </div>

          {/* Result */}
          {tool.result !== undefined && (
            <div>
              <p
                className={cn(
                  'text-xs font-medium mb-1',
                  tool.isError ? 'text-danger' : 'text-fg-muted'
                )}
              >
                {tool.isError ? 'Error' : 'Output'}
              </p>
              <pre
                className={cn(
                  'rounded p-2 text-xs whitespace-pre-wrap break-all max-h-48 overflow-y-auto',
                  tool.isError ? 'bg-danger/10 text-danger' : 'bg-canvas text-fg'
                )}
              >
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContainerAgentToolList({ tools }: ContainerAgentToolListProps): React.JSX.Element {
  const runningCount = tools.filter((t) => t.status === 'running').length;
  const completedCount = tools.filter((t) => t.status === 'complete').length;
  const errorCount = tools.filter((t) => t.status === 'error').length;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-border bg-surface-subtle px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-fg">Tool Executions</span>
          <div className="flex items-center gap-2 text-xs">
            {runningCount > 0 && (
              <span className="flex items-center gap-1 text-accent">
                <CircleNotch className="h-3 w-3 animate-spin" />
                {runningCount}
              </span>
            )}
            {completedCount > 0 && (
              <span className="flex items-center gap-1 text-success">
                <CheckCircle className="h-3 w-3" weight="fill" />
                {completedCount}
              </span>
            )}
            {errorCount > 0 && (
              <span className="flex items-center gap-1 text-danger">
                <XCircle className="h-3 w-3" weight="fill" />
                {errorCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tool list */}
      <div className="flex-1 overflow-y-auto">
        {tools.length === 0 ? (
          <div className="flex items-center justify-center p-4 text-sm text-fg-muted">
            No tool executions yet
          </div>
        ) : (
          tools.map((tool) => <ToolItem key={tool.toolId} tool={tool} />)
        )}
      </div>
    </div>
  );
}
