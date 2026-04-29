import { Pause, Play, Square, Timer } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { useRef } from 'react';
import { Button } from '@/app/components/ui/button';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';

export type AgentStatus = 'idle' | 'starting' | 'running' | 'paused' | 'error' | 'completed';

interface HeaderBarProps {
  sessionId: string;
  status: AgentStatus;
  startTime?: number;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const statusBadgeVariants = cva(
  'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium',
  {
    variants: {
      status: {
        idle: 'bg-surface-subtle text-fg-muted',
        starting: 'bg-accent/15 text-accent',
        running: 'bg-success/15 text-success',
        paused: 'bg-attention/15 text-attention',
        error: 'bg-danger/15 text-danger',
        completed: 'bg-accent/15 text-accent',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  }
);

const statusDotVariants = cva('h-2 w-2 rounded-full', {
  variants: {
    status: {
      idle: 'bg-fg-muted',
      starting: 'bg-accent animate-pulse',
      running: 'bg-success animate-pulse',
      paused: 'bg-attention',
      error: 'bg-danger',
      completed: 'bg-accent',
    },
  },
  defaultVariants: {
    status: 'idle',
  },
});

const statusLabels: Record<AgentStatus, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  paused: 'Paused',
  error: 'Error',
  completed: 'Completed',
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

export function HeaderBar({
  sessionId,
  status,
  startTime,
  onPause,
  onResume,
  onStop,
}: HeaderBarProps): React.JSX.Element {
  const elapsedRef = useRef<HTMLSpanElement>(null);

  // Update elapsed time every second when running (direct DOM update to avoid re-renders)
  useWatchEffect(() => {
    if (!startTime || status !== 'running') {
      return;
    }

    if (elapsedRef.current) {
      elapsedRef.current.textContent = formatElapsedTime(startTime);
    }

    const interval = window.setInterval(() => {
      if (elapsedRef.current) {
        elapsedRef.current.textContent = formatElapsedTime(startTime);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [startTime, status]);

  const isActive = status === 'running' || status === 'paused' || status === 'starting';
  const isPaused = status === 'paused';
  const isRunning = status === 'running';

  return (
    <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
      {/* Left side - Session info */}
      <div className="flex items-center gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-fg-muted">Session</p>
          <h1 className="text-base font-semibold text-fg truncate max-w-xs" title={sessionId}>
            {sessionId.slice(0, 8)}...
          </h1>
        </div>

        {/* Status badge */}
        <div
          className={statusBadgeVariants({ status })}
          data-testid="agent-status"
          data-status={status}
        >
          <span className={statusDotVariants({ status })} />
          {statusLabels[status]}
        </div>

        {/* Elapsed timer */}
        {startTime && isActive && (
          <div
            className="flex items-center gap-1.5 text-sm text-fg-muted"
            data-testid="turn-counter"
          >
            <Timer className="h-4 w-4" />
            <span ref={elapsedRef} className="font-mono tabular-nums">
              0:00
            </span>
          </div>
        )}
      </div>

      {/* Right side - Controls */}
      <div className="flex items-center gap-2">
        {isRunning && (
          <Button variant="outline" size="sm" onClick={onPause} data-testid="pause-button">
            <Pause className="h-4 w-4" weight="fill" />
            Pause
          </Button>
        )}
        {isPaused && (
          <Button variant="outline" size="sm" onClick={onResume} data-testid="resume-button">
            <Play className="h-4 w-4" weight="fill" />
            Resume
          </Button>
        )}
        {isActive && (
          <div data-testid="stop-confirmation">
            <Button variant="destructive" size="sm" onClick={onStop} data-testid="stop-button">
              <Square className="h-4 w-4" weight="fill" />
              Stop
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
