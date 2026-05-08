import { expect, vi } from 'vitest';

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? 1000;
  const interval = options.interval ?? 10;

  await vi.waitFor(
    async () => {
      expect(await condition()).toBe(true);
    },
    { timeout, interval }
  );
}

export async function waitForEvent<T>(
  readEvents: () => readonly T[] | Promise<readonly T[]>,
  predicate: (event: T) => boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<T> {
  let matched: T | undefined;

  await vi.waitFor(
    async () => {
      const events = await readEvents();
      matched = events.find(predicate);
      expect(matched).toBeDefined();
    },
    { timeout: options.timeout ?? 1000, interval: options.interval ?? 10 }
  );

  if (!matched) {
    throw new Error('Timed out waiting for event');
  }

  return matched;
}
