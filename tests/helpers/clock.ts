import { vi } from 'vitest';

export type FrozenClock = {
  now: Date;
  tick: (ms: number) => void;
  restore: () => void;
};

export function useFrozenClock(
  now: Date | string = new Date('2026-01-01T00:00:00.000Z')
): FrozenClock {
  const frozen = typeof now === 'string' ? new Date(now) : now;
  vi.useFakeTimers();
  vi.setSystemTime(frozen);

  return {
    now: frozen,
    tick: (ms: number) => vi.advanceTimersByTime(ms),
    restore: () => {
      vi.useRealTimers();
    },
  };
}
