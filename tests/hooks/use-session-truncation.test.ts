/**
 * F05-04: use-session chunk truncation.
 *
 * When the pending-updates batch pushes the chunk list past MAX_CHUNKS,
 * applyPendingSessionUpdates should:
 *   1. Trim from the head (oldest first)
 *   2. Set truncated = true
 *   3. Accumulate truncatedCount across batches
 */

import { describe, expect, it } from 'vitest';
import {
  applyPendingSessionUpdates,
  createInitialSessionStateForTest,
  createPendingSessionUpdatesForTest,
  MAX_CHUNKS,
  type SessionChunk,
} from '../../src/app/hooks/use-session.js';

function chunk(i: number): SessionChunk {
  return { text: `chunk-${i}`, timestamp: i };
}

describe('useSession truncation (F05-04)', () => {
  it('does not mark truncated below MAX_CHUNKS', () => {
    const prev = createInitialSessionStateForTest();
    const batch = createPendingSessionUpdatesForTest();
    batch.chunks = [chunk(1), chunk(2), chunk(3)];
    const next = applyPendingSessionUpdates(prev, batch);
    expect(next.chunks).toHaveLength(3);
    expect(next.truncated).toBe(false);
    expect(next.truncatedCount).toBe(0);
  });

  it('trims chunks past MAX_CHUNKS and sets truncated flag', () => {
    const prev = createInitialSessionStateForTest();
    const batch = createPendingSessionUpdatesForTest();
    const overflow = 250;
    batch.chunks = Array.from({ length: MAX_CHUNKS + overflow }, (_, i) => chunk(i));
    const next = applyPendingSessionUpdates(prev, batch);
    expect(next.chunks).toHaveLength(MAX_CHUNKS);
    expect(next.truncated).toBe(true);
    expect(next.truncatedCount).toBe(overflow);
    // Verify head was trimmed (oldest dropped).
    expect(next.chunks[0]?.text).toBe(`chunk-${overflow}`);
  });

  it('accumulates truncatedCount across batches', () => {
    let state = createInitialSessionStateForTest();
    let batch = createPendingSessionUpdatesForTest();
    batch.chunks = Array.from({ length: MAX_CHUNKS + 100 }, (_, i) => chunk(i));
    state = applyPendingSessionUpdates(state, batch);
    expect(state.truncatedCount).toBe(100);

    batch = createPendingSessionUpdatesForTest();
    batch.chunks = Array.from({ length: 50 }, (_, i) => chunk(MAX_CHUNKS + 100 + i));
    state = applyPendingSessionUpdates(state, batch);
    expect(state.truncatedCount).toBe(150);
    expect(state.truncated).toBe(true);
  });
});
