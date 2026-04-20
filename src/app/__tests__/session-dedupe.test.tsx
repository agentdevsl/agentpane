/**
 * F09-02 seed test: frontend session event dedupe.
 *
 * Exercises `applyPendingSessionUpdates` — the reducer behind `useSession`'s
 * rAF-batched state — to assert that duplicate incoming events produce a
 * single collection entry. This is the hot path exercised on durable-stream
 * reconnect when the producer replays a window the client has already seen.
 *
 * The reducer's own dedupe surface is `toolCalls[].id` and `presence[].userId`
 * (merge-by-key semantics); chunk dedupe happens upstream in the callbacks via
 * `seenEventIdsRef` (not directly testable without a component harness).
 *
 * See `specs/arch_review_april/09-testing.md` F09-02.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPendingSessionUpdates,
  createInitialSessionStateForTest,
  createPendingSessionUpdatesForTest,
} from '@/app/hooks/use-session';

describe('useSession / applyPendingSessionUpdates — dedupe semantics', () => {
  it('merges tool calls by id — same id twice yields one entry', () => {
    const initial = createInitialSessionStateForTest();
    const batch1 = createPendingSessionUpdatesForTest();
    batch1.toolCalls.push({
      id: 'tool-1',
      tool: 'Bash',
      input: { cmd: 'ls' },
      status: 'running',
      timestamp: 100,
    });
    const stateAfterFirst = applyPendingSessionUpdates(initial, batch1);
    expect(stateAfterFirst.toolCalls).toHaveLength(1);

    // Simulate durable-stream reconnect replaying the same tool event,
    // followed by a status update arriving with the same id.
    const batch2 = createPendingSessionUpdatesForTest();
    batch2.toolCalls.push({
      id: 'tool-1',
      tool: 'Bash',
      input: { cmd: 'ls' },
      status: 'complete',
      timestamp: 200,
      output: 'file.txt',
    });
    const stateAfterSecond = applyPendingSessionUpdates(stateAfterFirst, batch2);

    // Single entry — not duplicated — and the later status wins.
    expect(stateAfterSecond.toolCalls).toHaveLength(1);
    expect(stateAfterSecond.toolCalls[0]?.status).toBe('complete');
    expect(stateAfterSecond.toolCalls[0]?.output).toBe('file.txt');
  });

  it('merges presence by userId — same user twice yields one entry with latest cursor', () => {
    const initial = createInitialSessionStateForTest();
    const batch1 = createPendingSessionUpdatesForTest();
    batch1.presence.push({ userId: 'alice', lastSeen: 100, cursor: { x: 0, y: 0 } });
    batch1.presence.push({ userId: 'bob', lastSeen: 100 });
    const state1 = applyPendingSessionUpdates(initial, batch1);
    expect(state1.presence).toHaveLength(2);

    // Alice's presence arrives again (duplicate emission during reconnect).
    const batch2 = createPendingSessionUpdatesForTest();
    batch2.presence.push({ userId: 'alice', lastSeen: 200, cursor: { x: 10, y: 20 } });
    const state2 = applyPendingSessionUpdates(state1, batch2);

    expect(state2.presence).toHaveLength(2);
    const alice = state2.presence.find((p) => p.userId === 'alice');
    expect(alice?.lastSeen).toBe(200);
    expect(alice?.cursor).toEqual({ x: 10, y: 20 });
  });

  it('appends chunks in order without implicit dedupe (dedupe is upstream)', () => {
    // Chunks are append-only in the reducer; the hook's `seenEventIdsRef`
    // handles dedupe *before* chunks enter the pending batch. This test
    // documents the contract: if two identical chunks reach the reducer, both
    // land — so the upstream dedupe must be preserved.
    const initial = createInitialSessionStateForTest();
    const batch = createPendingSessionUpdatesForTest();
    batch.chunks.push({ text: 'hello', timestamp: 100 });
    batch.chunks.push({ text: 'hello', timestamp: 100 });
    const state = applyPendingSessionUpdates(initial, batch);
    expect(state.chunks).toHaveLength(2);
  });
});
