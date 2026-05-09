/**
 * Integration coverage for the small lib/streams modules:
 * - stream-id.ts (factories, classifyStreamId, assertStreamIdKind, expectedStreamIdKindForEventType)
 * - envelope.ts (parsePayloadStreamMetadata + normalizeStructuredStreamWireEvent gate)
 * - health-check.ts (StreamsHealthCheck lifecycle + threshold + recovery)
 *
 * These modules have unit-project tests but are at 0% / partial in the
 * integration project coverage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cursorToApproxOffset,
  getPayloadStreamMetadata,
  normalizeStreamWireEvent,
  normalizeStructuredStreamWireEvent,
  requirePayloadStreamMetadata,
} from '../../src/lib/streams/envelope';
import { StreamsHealthCheck } from '../../src/lib/streams/health-check';
import {
  assertStreamIdKind,
  CLI_MONITOR_STREAM_ID,
  classifyStreamId,
  expectedStreamIdKindForEventType,
  planStreamId,
  sandboxStreamId,
  sessionStreamId,
  terraformStreamId,
} from '../../src/lib/streams/stream-id';

describe('lib/streams/stream-id', () => {
  it('builds prefixed IDs via factory functions', () => {
    expect(planStreamId('abc123')).toBe('plan:abc123');
    expect(sandboxStreamId('def456')).toBe('sandbox:def456');
    expect(terraformStreamId('ghi789')).toBe('terraform:ghi789');
    expect(sessionStreamId('cuid_xyz')).toBe('cuid_xyz');
  });

  it('rejects invalid stream-ID bodies (empty, contains colon, special chars)', () => {
    expect(() => planStreamId('')).toThrow(/not a valid identifier/);
    expect(() => sandboxStreamId('has:colon')).toThrow(/not a valid identifier/);
    expect(() => terraformStreamId('has space')).toThrow(/not a valid identifier/);
    expect(() => sessionStreamId('!special')).toThrow(/not a valid identifier/);
  });

  it('classifyStreamId identifies all known prefixes + bare CUIDs', () => {
    expect(classifyStreamId('plan:foo')).toBe('plan');
    expect(classifyStreamId('sandbox:foo')).toBe('sandbox');
    expect(classifyStreamId('terraform:foo')).toBe('terraform');
    expect(classifyStreamId('cli-monitor')).toBe('cli-monitor');
    expect(classifyStreamId('bareCuid12345')).toBe('session');
  });

  it('classifyStreamId returns null for empty and non-string inputs', () => {
    expect(classifyStreamId('')).toBeNull();
    expect(classifyStreamId(null as unknown as string)).toBeNull();
    expect(classifyStreamId(undefined as unknown as string)).toBeNull();
  });

  it('classifyStreamId returns null for unknown-prefix IDs (foreign:something)', () => {
    expect(classifyStreamId('unknown:foo')).toBeNull();
  });

  it('CLI_MONITOR_STREAM_ID is the literal cli-monitor', () => {
    expect(CLI_MONITOR_STREAM_ID).toBe('cli-monitor');
  });

  it('assertStreamIdKind throws on mismatch', () => {
    expect(() => assertStreamIdKind('plan:x', 'session')).toThrow(/Expected session/);
    expect(() => assertStreamIdKind('not:known', 'session')).toThrow(/Expected session/);
  });

  it('assertStreamIdKind passes when prefix matches', () => {
    expect(() => assertStreamIdKind('plan:foo', 'plan')).not.toThrow();
    expect(() => assertStreamIdKind('cli-monitor', 'cli-monitor')).not.toThrow();
  });

  it('expectedStreamIdKindForEventType maps event-type prefixes to stream kinds', () => {
    expect(expectedStreamIdKindForEventType('plan:foo')).toBe('plan');
    expect(expectedStreamIdKindForEventType('sandbox:status')).toBe('sandbox');
    expect(expectedStreamIdKindForEventType('terraform:job')).toBe('terraform');
    expect(expectedStreamIdKindForEventType('container-agent:token')).toBe('session');
    expect(expectedStreamIdKindForEventType('topology:agent_spawned')).toBe('session');
    expect(expectedStreamIdKindForEventType('agent:event')).toBe('session');
  });
});

describe('lib/streams/envelope', () => {
  const validMeta = {
    schemaVersion: 1 as const,
    eventId: 'evt-1',
    streamId: 'stream-1',
    blockId: null,
    partType: 'lifecycle' as const,
    durability: 'durable' as const,
    sequence: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('getPayloadStreamMetadata returns null when data has no meta', () => {
    expect(getPayloadStreamMetadata({ foo: 'bar' })).toBeNull();
    expect(getPayloadStreamMetadata(null)).toBeNull();
    expect(getPayloadStreamMetadata('string')).toBeNull();
  });

  it('getPayloadStreamMetadata returns null when meta is invalid', () => {
    expect(getPayloadStreamMetadata({ meta: { schemaVersion: 99 } })).toBeNull();
  });

  it('getPayloadStreamMetadata returns parsed meta when valid', () => {
    const result = getPayloadStreamMetadata({ meta: validMeta });
    expect(result).toEqual(validMeta);
  });

  it('requirePayloadStreamMetadata reports MISSING_METADATA for null/undefined', () => {
    const result = requirePayloadStreamMetadata({ foo: 'bar' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_METADATA');
  });

  it('requirePayloadStreamMetadata reports INVALID_PAYLOAD_METADATA for malformed meta', () => {
    const result = requirePayloadStreamMetadata({ meta: { schemaVersion: 'wrong' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PAYLOAD_METADATA');
  });

  it('requirePayloadStreamMetadata returns ok with parsed meta when valid', () => {
    const result = requirePayloadStreamMetadata({ meta: validMeta });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(validMeta);
  });

  it('normalizeStreamWireEvent returns parsed event when shape matches', () => {
    const event = { type: 'foo', data: { hello: 'world' } };
    expect(normalizeStreamWireEvent(event)).toEqual(event);
  });

  it('normalizeStreamWireEvent returns null for invalid shape', () => {
    expect(normalizeStreamWireEvent({ type: '' })).toBeNull();
    expect(normalizeStreamWireEvent(null)).toBeNull();
    expect(normalizeStreamWireEvent('string')).toBeNull();
  });

  it('normalizeStructuredStreamWireEvent passes connected event without metadata', () => {
    const result = normalizeStructuredStreamWireEvent({ type: 'connected', data: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('connected');
  });

  it('normalizeStructuredStreamWireEvent reports MISSING_METADATA when neither wire nor payload meta present', () => {
    const result = normalizeStructuredStreamWireEvent({ type: 'foo', data: { x: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_METADATA');
  });

  it('normalizeStructuredStreamWireEvent passes when wire meta is provided', () => {
    const result = normalizeStructuredStreamWireEvent({
      type: 'foo',
      data: { x: 1 },
      meta: validMeta,
    });
    expect(result.ok).toBe(true);
  });

  it('normalizeStructuredStreamWireEvent passes when payload meta is provided and lifts it onto the wire envelope', () => {
    const result = normalizeStructuredStreamWireEvent({
      type: 'foo',
      data: { x: 1, meta: validMeta },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.meta).toEqual(validMeta);
  });

  it('normalizeStructuredStreamWireEvent reports CONFLICTING_METADATA when wire/payload disagree', () => {
    const altMeta = { ...validMeta, eventId: 'evt-different' };
    const result = normalizeStructuredStreamWireEvent({
      type: 'foo',
      data: { x: 1, meta: altMeta },
      meta: validMeta,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICTING_METADATA');
  });

  it('normalizeStructuredStreamWireEvent reports INVALID_WIRE_EVENT for malformed envelope', () => {
    const result = normalizeStructuredStreamWireEvent({ data: 'no type' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_WIRE_EVENT');
  });

  it('cursorToApproxOffset parses numeric string and returns undefined for null/empty/NaN', () => {
    expect(cursorToApproxOffset('42')).toBe(42);
    expect(cursorToApproxOffset(null)).toBeUndefined();
    expect(cursorToApproxOffset(undefined)).toBeUndefined();
    expect(cursorToApproxOffset('not-a-number')).toBeUndefined();
  });
});

describe('lib/streams/health-check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts healthy and remains healthy after a successful check', async () => {
    const checkFn = vi.fn().mockResolvedValue(undefined);
    const hc = new StreamsHealthCheck({ checkFn, intervalMs: 1000, failureThreshold: 3 });

    hc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hc.isHealthy()).toBe(true);
    hc.stop();
  });

  it('flips to unhealthy after consecutive failures meeting threshold', async () => {
    const checkFn = vi.fn().mockRejectedValue(new Error('upstream gone'));
    const hc = new StreamsHealthCheck({ checkFn, intervalMs: 100, failureThreshold: 2 });
    hc.start();

    // first failure → still healthy (threshold=2)
    await vi.advanceTimersByTimeAsync(50);
    expect(hc.isHealthy()).toBe(true);

    // second tick → second failure → unhealthy
    await vi.advanceTimersByTimeAsync(100);
    expect(hc.isHealthy()).toBe(false);
    expect(hc.getStatus().consecutiveFailures).toBeGreaterThanOrEqual(2);
    hc.stop();
  });

  it('recovers when checkFn succeeds after being unhealthy', async () => {
    let shouldFail = true;
    const checkFn = vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error('flaky');
    });
    const hc = new StreamsHealthCheck({ checkFn, intervalMs: 100, failureThreshold: 1 });
    hc.start();

    await vi.advanceTimersByTimeAsync(50);
    expect(hc.isHealthy()).toBe(false);

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(hc.isHealthy()).toBe(true);
    expect(hc.getStatus().consecutiveFailures).toBe(0);
    hc.stop();
  });

  it('start is idempotent (calling twice does not register multiple intervals)', () => {
    const checkFn = vi.fn().mockResolvedValue(undefined);
    const hc = new StreamsHealthCheck({ checkFn, intervalMs: 1000 });
    hc.start();
    hc.start();
    hc.stop();
  });

  it('stop is safe to call when never started or twice', () => {
    const hc = new StreamsHealthCheck({ checkFn: vi.fn(), intervalMs: 1000 });
    expect(() => hc.stop()).not.toThrow();
    hc.start();
    hc.stop();
    expect(() => hc.stop()).not.toThrow();
  });

  it('getStatus returns last check timestamp once a check has run', async () => {
    const checkFn = vi.fn().mockResolvedValue(undefined);
    const hc = new StreamsHealthCheck({ checkFn, intervalMs: 100 });
    expect(hc.getStatus().lastCheckAt).toBeNull();
    hc.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(hc.getStatus().lastCheckAt).toBeTruthy();
    hc.stop();
  });
});
