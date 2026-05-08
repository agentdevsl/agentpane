/** biome-ignore-all lint/nursery/noFloatingPromises: fc.assert is synchronous for these properties. */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CLI_MONITOR_STREAM_ID,
  classifyStreamId,
  expectedStreamIdKindForEventType,
  planStreamId,
  sandboxStreamId,
  sessionStreamId,
  terraformStreamId,
} from '../../../src/lib/streams/stream-id';

const streamIdChars = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  '_',
  '-',
] as const;

const streamIdFirstChars = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
] as const;

const streamIdTail = fc
  .array(fc.constantFrom(...streamIdChars), { minLength: 1, maxLength: 48 })
  .map((chars) => chars.join(''));
const streamIdBody = fc
  .tuple(fc.constantFrom(...streamIdFirstChars), streamIdTail)
  .map(([first, tail]) => `${first}${tail}`);

describe('stream-id property invariants', () => {
  it('factory-created stream IDs always classify to their factory kind', () => {
    fc.assert(
      fc.property(streamIdBody, (id) => {
        expect(classifyStreamId(planStreamId(id))).toBe('plan');
        expect(classifyStreamId(sandboxStreamId(id))).toBe('sandbox');
        expect(classifyStreamId(terraformStreamId(id))).toBe('terraform');
        expect(classifyStreamId(sessionStreamId(id))).toBe('session');
        expect(classifyStreamId(CLI_MONITOR_STREAM_ID)).toBe('cli-monitor');
      })
    );
  });

  it('event-type prefixes map to the same stream kind expected by publish routing', () => {
    fc.assert(
      fc.property(streamIdBody, (suffix) => {
        expect(expectedStreamIdKindForEventType(`plan:${suffix}`)).toBe('plan');
        expect(expectedStreamIdKindForEventType(`sandbox:${suffix}`)).toBe('sandbox');
        expect(expectedStreamIdKindForEventType(`terraform:${suffix}`)).toBe('terraform');
        expect(expectedStreamIdKindForEventType(`container-agent:${suffix}`)).toBe('session');
        expect(expectedStreamIdKindForEventType(suffix)).toBe('session');
      })
    );
  });

  it('unknown colon-prefixed stream IDs are not silently classified as session streams', () => {
    const unknownPrefix = streamIdBody.filter(
      (prefix) => !['plan', 'sandbox', 'terraform'].includes(prefix)
    );

    fc.assert(
      fc.property(unknownPrefix, streamIdBody, (prefix, suffix) => {
        expect(classifyStreamId(`${prefix}:${suffix}`)).toBeNull();
      })
    );
  });
});
