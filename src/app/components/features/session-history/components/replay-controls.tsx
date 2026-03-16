import { Pause, Play, SkipBack, SkipForward } from '@phosphor-icons/react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { ReplaySpeed } from '../hooks/use-session-replay';

export interface ReplayControlsProps {
  /** Whether playback is active */
  isPlaying: boolean;
  /** Current time in milliseconds */
  currentTime: number;
  /** Total duration in milliseconds */
  totalTime: number;
  /** Current playback speed */
  speed: ReplaySpeed;
  /** Progress percentage (0-100) */
  progress: number;
  /** Callback to start playback */
  onPlay: () => void;
  /** Callback to pause playback */
  onPause: () => void;
  /** Callback to seek to a specific time */
  onSeek: (time: number) => void;
  /** Callback to set playback speed */
  onSpeedChange: (speed: ReplaySpeed) => void;
  /** Callback to jump to start */
  onJumpToStart: () => void;
  /** Callback to jump to end */
  onJumpToEnd: () => void;
  /** Optional className for the container */
  className?: string;
}

const SPEED_OPTIONS: ReplaySpeed[] = [1, 2, 4];

/**
 * Format milliseconds to MM:SS display format
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * ReplayControls component for session replay playback.
 * Provides play/pause, progress bar with seeking, speed selection,
 * and jump to start/end controls.
 */
export function ReplayControls({
  isPlaying,
  currentTime,
  totalTime,
  speed,
  progress,
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
  onJumpToStart,
  onJumpToEnd,
  className,
}: ReplayControlsProps): React.JSX.Element {
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);

  // Handle play/pause toggle
  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      onPause();
    } else {
      onPlay();
    }
  }, [isPlaying, onPlay, onPause]);

  // Calculate time from mouse position on progress bar
  const calculateTimeFromPosition = useCallback(
    (clientX: number): number => {
      if (!progressBarRef.current) return 0;

      const rect = progressBarRef.current.getBoundingClientRect();
      const position = (clientX - rect.left) / rect.width;
      const clampedPosition = Math.max(0, Math.min(1, position));
      return clampedPosition * totalTime;
    },
    [totalTime]
  );

  // Handle click on progress bar
  const handleProgressClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const time = calculateTimeFromPosition(event.clientX);
      onSeek(time);
    },
    [calculateTimeFromPosition, onSeek]
  );

  // Handle keyboard on progress bar
  const handleProgressKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const SKIP_AMOUNT = 5000; // 5 seconds

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          onSeek(Math.max(0, currentTime - SKIP_AMOUNT));
          break;
        case 'ArrowRight':
          event.preventDefault();
          onSeek(Math.min(totalTime, currentTime + SKIP_AMOUNT));
          break;
        case 'Home':
          event.preventDefault();
          onJumpToStart();
          break;
        case 'End':
          event.preventDefault();
          onJumpToEnd();
          break;
      }
    },
    [onSeek, currentTime, totalTime, onJumpToStart, onJumpToEnd]
  );

  // Handle mouse down on progress handle
  const handleHandleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const time = calculateTimeFromPosition(moveEvent.clientX);
        onSeek(time);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [calculateTimeFromPosition, onSeek]
  );

  // Handle mouse move over progress bar for hover preview
  const handleProgressMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;

    const rect = progressBarRef.current.getBoundingClientRect();
    const position = ((event.clientX - rect.left) / rect.width) * 100;
    setHoverPosition(Math.max(0, Math.min(100, position)));
  }, []);

  // Handle mouse leave on progress bar
  const handleProgressMouseLeave = useCallback(() => {
    setHoverPosition(null);
  }, []);

  // Handle keyboard navigation on container
  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const SKIP_AMOUNT = 5000; // 5 seconds

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          handlePlayPause();
          break;
        case 'ArrowLeft':
        case 'j':
          event.preventDefault();
          onSeek(Math.max(0, currentTime - SKIP_AMOUNT));
          break;
        case 'ArrowRight':
        case 'l':
          event.preventDefault();
          onSeek(Math.min(totalTime, currentTime + SKIP_AMOUNT));
          break;
        case 'Home':
          event.preventDefault();
          onJumpToStart();
          break;
        case 'End':
          event.preventDefault();
          onJumpToEnd();
          break;
      }
    },
    [handlePlayPause, onSeek, currentTime, totalTime, onJumpToStart, onJumpToEnd]
  );

  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border border-border bg-surface-subtle p-3',
        'transition-all duration-150 ease-out',
        className
      )}
      role="toolbar"
      aria-label="Session replay controls"
      onKeyDown={handleContainerKeyDown}
      data-testid="replay-controls"
    >
      {/* Play/Pause Button */}
      <button
        type="button"
        onClick={handlePlayPause}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full',
          'bg-accent text-fg-on-emphasis',
          'transition-all duration-150 ease-out',
          'hover:bg-accent-hover hover:scale-105',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted'
        )}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        data-testid="replay-play-pause"
      >
        {isPlaying ? (
          <Pause className="h-4.5 w-4.5" weight="fill" />
        ) : (
          <Play className="ml-0.5 h-4.5 w-4.5" weight="fill" />
        )}
      </button>

      {/* Progress Container */}
      <div className="flex flex-1 items-center gap-3">
        {/* Current Time */}
        <span
          className="min-w-[50px] font-mono text-xs text-fg-muted"
          data-testid="replay-current-time"
        >
          {formatTime(currentTime)}
        </span>

        {/* Progress Bar */}
        <div
          ref={progressBarRef}
          className={cn(
            'relative flex-1 h-1.5 cursor-pointer',
            'bg-bg-emphasis rounded-full',
            'transition-all duration-150 ease-out'
          )}
          onClick={handleProgressClick}
          onKeyDown={handleProgressKeyDown}
          onMouseMove={handleProgressMouseMove}
          onMouseLeave={handleProgressMouseLeave}
          role="slider"
          aria-label="Playback progress"
          aria-valuemin={0}
          aria-valuemax={totalTime}
          aria-valuenow={currentTime}
          aria-valuetext={`${formatTime(currentTime)} of ${formatTime(totalTime)}`}
          tabIndex={0}
          data-testid="replay-progress-bar"
        >
          {/* Hover indicator */}
          {hoverPosition !== null && !isDragging ? (
            <div
              className="absolute top-0 h-full rounded-full bg-fg-subtle/30"
              style={{ width: `${hoverPosition}%` }}
            />
          ) : null}

          {/* Progress fill */}
          <div
            className={cn(
              'absolute left-0 top-0 h-full rounded-full bg-accent',
              'transition-[width] duration-75 ease-out',
              isDragging && 'transition-none'
            )}
            style={{ width: `${progress}%` }}
            data-testid="replay-progress-fill"
          />

          {/* Draggable handle */}
          <div
            className={cn(
              'absolute top-1/2 -translate-y-1/2 -translate-x-1/2',
              'h-3.5 w-3.5 rounded-full',
              'bg-fg-on-emphasis shadow-md',
              'cursor-grab transition-transform duration-150 ease-out',
              'hover:scale-110',
              isDragging && 'cursor-grabbing scale-110',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted'
            )}
            style={{ left: `${progress}%` }}
            onMouseDown={handleHandleMouseDown}
            aria-hidden="true"
            data-testid="replay-progress-handle"
          />
        </div>

        {/* Total Time */}
        <span
          className="min-w-[50px] font-mono text-xs text-fg-muted"
          data-testid="replay-total-time"
        >
          {formatTime(totalTime)}
        </span>
      </div>

      {/* Speed Selector */}
      <fieldset
        className="flex items-center gap-1 rounded-md bg-bg-muted p-1 border-none"
        aria-label="Playback speed"
        data-testid="replay-speed-selector"
      >
        <legend className="sr-only">Playback speed</legend>
        {SPEED_OPTIONS.map((speedOption) => (
          <button
            key={speedOption}
            type="button"
            onClick={() => onSpeedChange(speedOption)}
            className={cn(
              'px-2 py-1 rounded text-xs font-medium',
              'transition-all duration-150 ease-out',
              speed === speedOption ? 'bg-bg-emphasis text-fg' : 'text-fg-muted hover:text-fg'
            )}
            aria-pressed={speed === speedOption}
            data-testid={`replay-speed-${speedOption}x`}
          >
            {speedOption}x
          </button>
        ))}
      </fieldset>

      {/* Jump Controls */}
      <div className="flex items-center gap-2" data-testid="replay-jump-controls">
        <Button
          variant="outline"
          size="sm"
          onClick={onJumpToStart}
          className="h-7 px-2 text-xs"
          aria-label="Jump to start"
          data-testid="replay-jump-start"
        >
          <SkipBack className="mr-1 h-3 w-3" weight="fill" />
          Start
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onJumpToEnd}
          className="h-7 px-2 text-xs"
          aria-label="Jump to end"
          data-testid="replay-jump-end"
        >
          End
          <SkipForward className="ml-1 h-3 w-3" weight="fill" />
        </Button>
      </div>
    </div>
  );
}
