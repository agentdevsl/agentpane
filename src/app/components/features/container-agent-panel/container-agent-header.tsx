import {
  ArrowsClockwise,
  CircleNotch,
  GitBranch,
  Robot,
  Timer,
  WifiHigh,
  WifiSlash,
} from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useRef } from 'react';
import { ExecutionBadge } from '@/app/components/ui/execution-badge';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { ConnectionState } from '@/lib/streams/client';

export type ContainerAgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'completed'
  | 'plan_ready'
  | 'error'
  | 'cancelled';

interface ContainerAgentHeaderProps {
  status: ContainerAgentStatus;
  model?: string;
  branch?: string;
  currentTurn: number;
  maxTurns?: number;
  startedAt?: number;
  sandboxProvider?: string;
  sandboxContainerId?: string;
  connectionState: ConnectionState;
  isStreaming: boolean;
}

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
  {
    variants: {
      status: {
        idle: 'bg-surface-subtle text-fg-muted',
        starting: 'bg-accent/15 text-accent',
        running: 'bg-success/15 text-success',
        completed: 'bg-accent/15 text-accent',
        plan_ready: 'bg-attention/15 text-attention',
        error: 'bg-danger/15 text-danger',
        cancelled: 'bg-attention/15 text-attention',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  }
);

const statusDotVariants = cva('h-1.5 w-1.5 rounded-full', {
  variants: {
    status: {
      idle: 'bg-fg-muted',
      starting: 'bg-accent animate-pulse',
      running: 'bg-success animate-pulse',
      completed: 'bg-accent',
      plan_ready: 'bg-attention',
      error: 'bg-danger',
      cancelled: 'bg-attention',
    },
  },
  defaultVariants: {
    status: 'idle',
  },
});

const statusLabels: Record<ContainerAgentStatus, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  completed: 'Completed',
  plan_ready: 'Plan Ready',
  error: 'Error',
  cancelled: 'Cancelled',
};

function formatElapsedTime(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function ContainerAgentHeader({
  status,
  model,
  branch,
  currentTurn,
  maxTurns,
  startedAt,
  sandboxProvider,
  sandboxContainerId,
  connectionState,
  isStreaming,
}: ContainerAgentHeaderProps): React.JSX.Element {
  const elapsedRef = useRef<HTMLSpanElement>(null);

  // Update elapsed time every second when running (direct DOM update to avoid re-renders)
  useWatchEffect(() => {
    if (!startedAt || (status !== 'running' && status !== 'starting')) {
      return;
    }

    if (elapsedRef.current) {
      elapsedRef.current.textContent = formatElapsedTime(startedAt);
    }

    const interval = window.setInterval(() => {
      if (elapsedRef.current) {
        elapsedRef.current.textContent = formatElapsedTime(startedAt);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [startedAt, status]);

  const isActive = status === 'running' || status === 'starting';

  return (
    <div className="flex items-center gap-4">
      {/* Agent icon and title */}
      <div className="flex items-center gap-2">
        <Robot className="h-5 w-5 text-fg-muted" weight="duotone" />
        <div>
          <p className="text-sm font-medium text-fg">Container Agent</p>
          {model ? <p className="text-xs text-fg-muted">{model}</p> : null}
        </div>
      </div>

      {/* Status badge */}
      <div
        className={statusBadgeVariants({ status })}
        data-testid="container-agent-status"
        data-status={status}
      >
        <span className={statusDotVariants({ status })} />
        {statusLabels[status]}
      </div>

      {/* Sandbox provider badge */}
      <ExecutionBadge
        sandboxProvider={sandboxProvider}
        sandboxContainerId={sandboxContainerId}
        size="full"
      />

      {/* Branch indicator */}
      {branch ? (
        <div
          className="flex items-center gap-1.5 text-sm text-fg-muted"
          data-testid="branch-indicator"
          title={branch}
        >
          <GitBranch className="h-4 w-4" />
          <span className="max-w-[160px] truncate font-mono text-xs">{branch}</span>
        </div>
      ) : null}

      {/* Turn counter */}
      {maxTurns ? (
        <div className="flex items-center gap-1.5 text-sm text-fg-muted" data-testid="turn-counter">
          <ArrowsClockwise className="h-4 w-4" />
          <span className="font-mono tabular-nums">
            {currentTurn}/{maxTurns}
          </span>
        </div>
      ) : null}

      {/* Elapsed time */}
      {startedAt && isActive ? (
        <div className="flex items-center gap-1.5 text-sm text-fg-muted" data-testid="elapsed-time">
          <Timer className="h-4 w-4" />
          <span ref={elapsedRef} className="font-mono tabular-nums">
            0:00
          </span>
        </div>
      ) : null}

      {/* Streaming indicator */}
      {isStreaming ? (
        <div
          className="flex items-center gap-1.5 text-xs text-success"
          data-testid="streaming-indicator"
        >
          <CircleNotch className="h-3 w-3 animate-spin" />
          <span>Streaming</span>
        </div>
      ) : null}

      {/* Connection state */}
      <div className="flex items-center gap-1" title={`Connection: ${connectionState}`}>
        {connectionState === 'connected' ? (
          <WifiHigh className="h-4 w-4 text-success" weight="fill" />
        ) : connectionState === 'connecting' ? (
          <WifiHigh className="h-4 w-4 text-fg-muted animate-pulse" />
        ) : connectionState === 'reconnecting' ? (
          <WifiHigh className="h-4 w-4 text-attention animate-pulse" />
        ) : connectionState === 'disconnected' ? (
          <WifiSlash className="h-4 w-4 text-danger" />
        ) : null}
      </div>
    </div>
  );
}
