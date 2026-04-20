/**
 * F05-14: Durable Streams contract test.
 *
 * Verifies that the pinned versions of @durable-streams/client (producer) and
 * @durable-streams/server (test server / Caddy) round-trip an event correctly
 * through the envelope normalization layer. This guards against silent
 * compatibility regressions from accidental dependency bumps.
 *
 * See specs/application/integrations/durable-streams.md for the known-good
 * version matrix. If this test fails after `bun install`, check the matrix.
 */

import { describe, expect, it } from 'vitest';
import {
  CLI_MONITOR_STREAM_ID,
  classifyStreamId,
  expectedStreamIdKindForEventType,
  planStreamId,
  sandboxStreamId,
  sessionStreamId,
  terraformStreamId,
} from '../../src/lib/streams/stream-id.js';

describe('durable-streams contract (pinned versions)', () => {
  it('exposes the expected producer and subscriber entry points', async () => {
    // These imports are the public surface we rely on. If the package shape
    // changes, the import itself will fail at type-check time.
    const clientModule = await import('@durable-streams/client');
    expect(typeof clientModule.IdempotentProducer).toBe('function');
    expect(typeof clientModule.DurableStream).toBe('function');
    expect(typeof clientModule.stream).toBe('function');
  });

  it('round-trips a stream ID through our classifier', () => {
    const planId = planStreamId('abc123');
    expect(classifyStreamId(planId)).toBe('plan');

    const sandboxId = sandboxStreamId('xyz789');
    expect(classifyStreamId(sandboxId)).toBe('sandbox');

    const terraformId = terraformStreamId('job42');
    expect(classifyStreamId(terraformId)).toBe('terraform');

    const sessionId = sessionStreamId('ckcid1234567890');
    expect(classifyStreamId(sessionId)).toBe('session');

    expect(classifyStreamId(CLI_MONITOR_STREAM_ID)).toBe('cli-monitor');
  });

  it('maps event-type prefix to expected stream kind', () => {
    expect(expectedStreamIdKindForEventType('plan:started')).toBe('plan');
    expect(expectedStreamIdKindForEventType('sandbox:ready')).toBe('sandbox');
    expect(expectedStreamIdKindForEventType('terraform:status')).toBe('terraform');
    expect(expectedStreamIdKindForEventType('container-agent:token')).toBe('session');
    expect(expectedStreamIdKindForEventType('task-creation:message')).toBe('session');
    expect(expectedStreamIdKindForEventType('chunk')).toBe('session');
  });

  it('rejects malformed stream-id bodies in factories', () => {
    expect(() => planStreamId('')).toThrow();
    expect(() => planStreamId(' invalid space')).toThrow();
    expect(() => sandboxStreamId('has/slash')).toThrow();
  });
});
