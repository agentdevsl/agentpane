import { useCallback, useMemo, useRef, useState } from 'react';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { SessionEvent } from '@/services/session.service';

export type ReplaySpeed = 1 | 2 | 4;

export interface UseSessionReplayOptions {
  /** Array of session events to replay */
  events: SessionEvent[];
  /** Total duration of the session in milliseconds */
  totalDuration: number;
}

export interface UseSessionReplayReturn {
  /** Whether playback is currently active */
  isPlaying: boolean;
  /** Current playback time in milliseconds from session start */
  currentTime: number;
  /** Total session duration in milliseconds */
  totalTime: number;
  /** Current playback speed multiplier */
  speed: ReplaySpeed;
  /** Index of the current event being displayed */
  currentEventIndex: number;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Seek to a specific time (in milliseconds) */
  seek: (time: number) => void;
  /** Seek to a specific event by index */
  seekToEvent: (index: number) => void;
  /** Set the playback speed */
  setSpeed: (speed: ReplaySpeed) => void;
  /** Jump to the start of the session */
  jumpToStart: () => void;
  /** Jump to the end of the session */
  jumpToEnd: () => void;
  /** Progress percentage (0-100) */
  progress: number;
}

/**
 * Find the event index at a given time offset from the start.
 * Returns the index of the last event that occurred at or before the given time.
 */
function findEventIndexAtTime(
  events: SessionEvent[],
  startTime: number,
  targetTime: number
): number {
  if (events.length === 0) return -1;

  const absoluteTargetTime = startTime + targetTime;

  // Binary search for efficiency with large event arrays
  let left = 0;
  let right = events.length - 1;
  let result = -1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const event = events[mid];
    if (event && event.timestamp <= absoluteTargetTime) {
      result = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
}

/**
 * Hook for managing session replay playback.
 * Uses requestAnimationFrame for smooth animation and supports
 * speed multipliers for faster review.
 */
export function useSessionReplay({
  events,
  totalDuration,
}: UseSessionReplayOptions): UseSessionReplayReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeedState] = useState<ReplaySpeed>(1);

  // Refs for animation frame management
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Store mutable values in refs to avoid recreating animate callback
  const speedRef = useRef(speed);
  const totalDurationRef = useRef(totalDuration);
  const isPlayingRef = useRef(isPlaying);

  // Keep refs in sync with state
  speedRef.current = speed;
  totalDurationRef.current = totalDuration;
  isPlayingRef.current = isPlaying;

  // Compute the start time from the first event
  const startTime = useMemo(() => {
    if (events.length === 0) return 0;
    const firstEvent = events[0];
    return firstEvent ? firstEvent.timestamp : 0;
  }, [events]);

  // Clamp time to valid range
  const clampTime = useCallback(
    (time: number) => Math.max(0, Math.min(time, totalDuration)),
    [totalDuration]
  );

  // Find the current event index based on currentTime
  const currentEventIndex = useMemo(
    () => findEventIndexAtTime(events, startTime, currentTime),
    [events, startTime, currentTime]
  );

  // Calculate progress percentage
  const progress = useMemo(() => {
    if (totalDuration === 0) return 0;
    return (currentTime / totalDuration) * 100;
  }, [currentTime, totalDuration]);

  // Stable animation loop that reads from refs
  const animate = useCallback((timestamp: number) => {
    if (lastFrameTimeRef.current === 0) {
      lastFrameTimeRef.current = timestamp;
    }

    const deltaTime = timestamp - lastFrameTimeRef.current;
    lastFrameTimeRef.current = timestamp;

    // Apply speed multiplier to delta time (read from ref)
    const adjustedDelta = deltaTime * speedRef.current;

    setCurrentTime((prevTime) => {
      const newTime = prevTime + adjustedDelta;

      // Stop at the end (read duration from ref)
      if (newTime >= totalDurationRef.current) {
        setIsPlaying(false);
        return totalDurationRef.current;
      }

      return newTime;
    });

    // Continue animation if still playing
    if (isPlayingRef.current) {
      animationFrameRef.current = requestAnimationFrame(animate);
    }
  }, []); // No dependencies - uses refs for mutable values

  // Start playback
  const play = useCallback(() => {
    // If at the end, restart from beginning
    if (currentTime >= totalDuration) {
      setCurrentTime(0);
    }

    setIsPlaying(true);
    lastFrameTimeRef.current = 0;
    animationFrameRef.current = requestAnimationFrame(animate);
  }, [animate, currentTime, totalDuration]);

  // Pause playback
  const pause = useCallback(() => {
    setIsPlaying(false);
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastFrameTimeRef.current = 0;
  }, []);

  // Seek to a specific time
  const seek = useCallback(
    (time: number) => {
      const clampedTime = clampTime(time);
      setCurrentTime(clampedTime);

      // If playing, reset the animation frame timing
      if (isPlaying) {
        lastFrameTimeRef.current = 0;
      }
    },
    [clampTime, isPlaying]
  );

  // Seek to a specific event by index
  const seekToEvent = useCallback(
    (index: number) => {
      if (index < 0 || index >= events.length) return;

      const event = events[index];
      if (!event) return;
      const eventTime = event.timestamp - startTime;
      seek(clampTime(eventTime));
    },
    [events, startTime, seek, clampTime]
  );

  // Set playback speed
  const setSpeed = useCallback((newSpeed: ReplaySpeed) => {
    setSpeedState(newSpeed);
  }, []);

  // Jump to start
  const jumpToStart = useCallback(() => {
    setCurrentTime(0);
    if (isPlaying) {
      lastFrameTimeRef.current = 0;
    }
  }, [isPlaying]);

  // Jump to end
  const jumpToEnd = useCallback(() => {
    setCurrentTime(totalDuration);
    pause();
  }, [totalDuration, pause]);

  // Handle playing state changes - stable animate callback means this only re-runs on isPlaying change
  useWatchEffect(() => {
    if (isPlaying) {
      lastFrameTimeRef.current = 0;
      animationFrameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isPlaying, animate]);

  // Cleanup on unmount
  useMountEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  });

  return {
    isPlaying,
    currentTime,
    totalTime: totalDuration,
    speed,
    currentEventIndex,
    play,
    pause,
    seek,
    seekToEvent,
    setSpeed,
    jumpToStart,
    jumpToEnd,
    progress,
  };
}
