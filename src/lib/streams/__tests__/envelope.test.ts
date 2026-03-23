import { describe, expect, it } from 'vitest';
import {
  cursorToApproxOffset,
  getPayloadStreamMetadata,
  normalizeStreamWireEvent,
  normalizeStructuredStreamWireEvent,
  requirePayloadStreamMetadata,
  STREAM_PROTOCOL_MIGRATION_GATE,
  streamEventMetadataSchema,
} from '../envelope.js';

describe('stream envelope helpers', () => {
  it('parses valid stream metadata', () => {
    const parsed = streamEventMetadataSchema.safeParse({
      schemaVersion: 1,
      eventId: 'evt_123',
      streamId: 'session_123',
      blockId: 'block_123',
      partType: 'chunk_delta',
      durability: 'transient',
      sequence: 2,
      createdAt: '2026-03-23T00:00:00.000Z',
    });

    expect(parsed.success).toBe(true);
  });

  it('normalizes a wire event with metadata', () => {
    const normalized = normalizeStreamWireEvent({
      type: 'chunk',
      data: { text: 'hello' },
      timestamp: 123,
      meta: {
        schemaVersion: 1,
        eventId: 'evt_123',
        streamId: 'session_123',
        blockId: 'block_123',
        partType: 'chunk_delta',
        durability: 'transient',
        sequence: 0,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
    });

    expect(normalized).toEqual({
      type: 'chunk',
      data: { text: 'hello' },
      timestamp: 123,
      meta: {
        schemaVersion: 1,
        eventId: 'evt_123',
        streamId: 'session_123',
        blockId: 'block_123',
        partType: 'chunk_delta',
        durability: 'transient',
        sequence: 0,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
    });
  });

  it('allows payload-level metadata to pass through unchanged', () => {
    const normalized = normalizeStreamWireEvent({
      type: 'chunk',
      data: {
        text: 'hello',
        meta: {
          schemaVersion: 1,
          eventId: 'evt_payload',
          streamId: 'session_payload',
          blockId: 'block_payload',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 1,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      },
    });

    expect(normalized?.data).toEqual({
      text: 'hello',
      meta: {
        schemaVersion: 1,
        eventId: 'evt_payload',
        streamId: 'session_payload',
        blockId: 'block_payload',
        partType: 'chunk_delta',
        durability: 'transient',
        sequence: 1,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
    });
  });

  it('promotes payload metadata into the structured wire event via the migration gate', () => {
    const normalized = normalizeStructuredStreamWireEvent({
      type: 'chunk',
      data: {
        text: 'hello',
        meta: {
          schemaVersion: 1,
          eventId: 'evt_payload',
          streamId: 'session_payload',
          blockId: 'block_payload',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 1,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      },
      timestamp: 123,
    });

    expect(normalized).toEqual({
      ok: true,
      value: {
        type: 'chunk',
        data: {
          text: 'hello',
          meta: {
            schemaVersion: 1,
            eventId: 'evt_payload',
            streamId: 'session_payload',
            blockId: 'block_payload',
            partType: 'chunk_delta',
            durability: 'transient',
            sequence: 1,
            createdAt: '2026-03-23T00:00:00.000Z',
          },
        },
        timestamp: 123,
        meta: {
          schemaVersion: 1,
          eventId: 'evt_payload',
          streamId: 'session_payload',
          blockId: 'block_payload',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 1,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      },
    });
  });

  it('blocks missing structured metadata via the migration gate', () => {
    const normalized = normalizeStructuredStreamWireEvent({
      type: 'chunk',
      data: { text: 'hello' },
      timestamp: 123,
    });

    expect(normalized.ok).toBe(false);
    if (!normalized.ok) {
      expect(normalized.error.code).toBe('MISSING_METADATA');
      expect(normalized.error.message).toContain(STREAM_PROTOCOL_MIGRATION_GATE);
    }
  });

  it('blocks conflicting wire and payload metadata via the migration gate', () => {
    const normalized = normalizeStructuredStreamWireEvent({
      type: 'chunk',
      data: {
        text: 'hello',
        meta: {
          schemaVersion: 1,
          eventId: 'evt-payload',
          streamId: 'session-1',
          blockId: 'block-1',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 0,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      },
      meta: {
        schemaVersion: 1,
        eventId: 'evt-wire',
        streamId: 'session-1',
        blockId: 'block-1',
        partType: 'chunk_delta',
        durability: 'transient',
        sequence: 0,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
      timestamp: 123,
    });

    expect(normalized.ok).toBe(false);
    if (!normalized.ok) {
      expect(normalized.error.code).toBe('CONFLICTING_METADATA');
    }
  });

  it('reads payload metadata through the shared helper', () => {
    expect(
      getPayloadStreamMetadata({
        text: 'hello',
        meta: {
          schemaVersion: 1,
          eventId: 'evt_123',
          streamId: 'session_123',
          blockId: 'block_123',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 2,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      })
    ).toMatchObject({
      eventId: 'evt_123',
      streamId: 'session_123',
    });
  });

  it('requires payload metadata through the shared migration gate helper', () => {
    const result = requirePayloadStreamMetadata(
      {
        text: 'hello',
        meta: {
          schemaVersion: 1,
          eventId: 'evt_123',
          streamId: 'session_123',
          blockId: 'block_123',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 2,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      },
      'Chunk payload'
    );

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        eventId: 'evt_123',
        streamId: 'session_123',
        blockId: 'block_123',
        partType: 'chunk_delta',
        durability: 'transient',
        sequence: 2,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
    });
  });

  it('rejects invalid wire events', () => {
    const normalized = normalizeStreamWireEvent({
      data: { text: 'hello' },
    });

    expect(normalized).toBeNull();
  });

  it('returns an approximate numeric offset only when available', () => {
    expect(cursorToApproxOffset('3_128')).toBe(3);
    expect(cursorToApproxOffset('opaque-cursor')).toBeUndefined();
    expect(cursorToApproxOffset(null)).toBeUndefined();
  });
});
