import {
  ArrowRight,
  CheckCircle,
  Code,
  Gear,
  Info,
  Lightning,
  Terminal,
  WarningCircle,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { memo } from 'react';
import { cn } from '@/lib/utils/cn';
import type { StreamLine as StreamLineData, StreamLineType } from './use-stream-parser';

interface StreamLineProps {
  line: StreamLineData;
  showTimestamp?: boolean;
}

// Line container variants for background highlighting
const lineContainerVariants = cva(
  'group flex items-start gap-2 py-1 px-1 -mx-1 rounded transition-colors',
  {
    variants: {
      type: {
        prompt: 'bg-success/5 hover:bg-success/10',
        command: 'hover:bg-surface-subtle',
        output: 'hover:bg-surface-subtle',
        thinking: 'bg-warning/5 hover:bg-warning/10',
        action: 'bg-accent/5 hover:bg-accent/10',
        tool: 'bg-done/5 hover:bg-done/10',
        success: 'bg-success/5 hover:bg-success/10',
        error: 'bg-danger/5 hover:bg-danger/10',
      },
    },
    defaultVariants: {
      type: 'output',
    },
  }
);

const lineTypeConfig: Record<
  StreamLineType,
  {
    icon: React.ElementType;
    textClass: string;
    iconClass: string;
  }
> = {
  prompt: {
    icon: Terminal,
    textClass: 'text-success font-semibold',
    iconClass: 'text-success',
  },
  command: {
    icon: Code,
    textClass: 'text-fg',
    iconClass: 'text-fg-muted',
  },
  output: {
    icon: Info,
    textClass: 'text-fg-muted',
    iconClass: 'text-fg-subtle',
  },
  thinking: {
    icon: Lightning,
    textClass: 'text-warning italic',
    iconClass: 'text-warning',
  },
  action: {
    icon: ArrowRight,
    textClass: 'text-accent',
    iconClass: 'text-accent',
  },
  tool: {
    icon: Gear,
    textClass: 'text-done',
    iconClass: 'text-done',
  },
  success: {
    icon: CheckCircle,
    textClass: 'text-success',
    iconClass: 'text-success',
  },
  error: {
    icon: WarningCircle,
    textClass: 'text-danger',
    iconClass: 'text-danger',
  },
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export const StreamLine = memo(
  function StreamLine({ line, showTimestamp = true }: StreamLineProps): React.JSX.Element {
    const config = lineTypeConfig[line.type];
    const Icon = config.icon;

    return (
      <div
        className={lineContainerVariants({ type: line.type })}
        data-testid={
          line.type === 'tool' ? 'tool-call' : line.type === 'command' ? 'file-change' : undefined
        }
      >
        {showTimestamp && (
          <span className="flex-shrink-0 w-16 text-xs text-fg-subtle font-mono tabular-nums opacity-60 group-hover:opacity-100 transition-opacity">
            {formatTimestamp(line.timestamp)}
          </span>
        )}
        <span className={cn('flex-shrink-0 mt-0.5', config.iconClass)}>
          <Icon className="h-3.5 w-3.5" weight="bold" />
        </span>
        <span
          className={cn('flex-1 font-mono text-sm whitespace-pre-wrap break-all', config.textClass)}
        >
          {line.content}
        </span>
        {line.toolName && (
          <span className="flex-shrink-0 text-xs text-done bg-done/10 px-1.5 py-0.5 rounded font-medium">
            {line.toolName}
          </span>
        )}
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.showTimestamp === next.showTimestamp &&
      prev.line.id === next.line.id &&
      prev.line.type === next.line.type &&
      prev.line.content === next.line.content &&
      prev.line.timestamp === next.line.timestamp &&
      prev.line.agentId === next.line.agentId &&
      prev.line.toolName === next.line.toolName
    );
  }
);

// Blinking cursor for active streaming
export function StreamCursor(): React.JSX.Element {
  return (
    <span
      className="inline-block w-2 h-4 bg-fg animate-pulse"
      style={{ animationDuration: '1s' }}
    />
  );
}
