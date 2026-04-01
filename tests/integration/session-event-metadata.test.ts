/**
 * Integration tests for session event metadata helpers.
 *
 * These are pure functions that create structured session events with metadata
 * envelopes. No database or external I/O is involved, but we test them as
 * integration tests because they produce the canonical event shape consumed by
 * the session event persistence layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamDurability, StreamPartType } from '../../src/lib/streams/envelope';
import type {
  SessionEventMetadataOptions,
  StreamPayloadMetadataOptions,
} from '../../src/services/session/event-metadata';
import {
  createSessionEventMetadata,
  createSessionEventWithMetadata,
  createStreamPayloadWithMetadata,
} from '../../src/services/session/event-metadata';
import { clearTestDatabase, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session Event Metadata (IT-SEM-001)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =========================================================================
  // createSessionEventMetadata
  // =========================================================================

  describe('createSessionEventMetadata', () => {
    it('IT-SEM-001a: creates metadata with all required fields', () => {
      const timestamp = Date.now();
      const meta = createSessionEventMetadata({
        eventId: 'evt-123',
        sessionId: 'session-abc',
        partType: 'lifecycle',
        timestamp,
      });

      expect(meta.schemaVersion).toBe(1);
      expect(meta.eventId).toBe('evt-123');
      expect(meta.streamId).toBe('session-abc');
      expect(meta.partType).toBe('lifecycle');
      expect(meta.durability).toBe('durable'); // default
      expect(meta.blockId).toBeNull(); // default
      expect(meta.sequence).toBeNull(); // default
      expect(meta.createdAt).toBe(new Date(timestamp).toISOString());
    });

    it('IT-SEM-001b: respects optional blockId parameter', () => {
      const meta = createSessionEventMetadata({
        eventId: 'evt-1',
        sessionId: 'sess-1',
        partType: 'chunk_start',
        blockId: 'block-42',
        timestamp: Date.now(),
      });

      expect(meta.blockId).toBe('block-42');
    });

    it('IT-SEM-001c: respects optional durability parameter', () => {
      const meta = createSessionEventMetadata({
        eventId: 'evt-1',
        sessionId: 'sess-1',
        partType: 'chunk_delta',
        durability: 'transient',
        timestamp: Date.now(),
      });

      expect(meta.durability).toBe('transient');
    });

    it('IT-SEM-001d: respects optional sequence parameter', () => {
      const meta = createSessionEventMetadata({
        eventId: 'evt-1',
        sessionId: 'sess-1',
        partType: 'tool_start',
        sequence: 42,
        timestamp: Date.now(),
      });

      expect(meta.sequence).toBe(42);
    });

    it('IT-SEM-001e: handles null blockId explicitly', () => {
      const meta = createSessionEventMetadata({
        eventId: 'evt-1',
        sessionId: 'sess-1',
        partType: 'lifecycle',
        blockId: null,
        timestamp: Date.now(),
      });

      expect(meta.blockId).toBeNull();
    });

    it('IT-SEM-001f: handles null sequence explicitly', () => {
      const meta = createSessionEventMetadata({
        eventId: 'evt-1',
        sessionId: 'sess-1',
        partType: 'lifecycle',
        sequence: null,
        timestamp: Date.now(),
      });

      expect(meta.sequence).toBeNull();
    });

    it('IT-SEM-001g: converts timestamp to ISO string', () => {
      const timestamp = 1700000000000; // Known epoch
      const meta = createSessionEventMetadata({
        eventId: 'evt-1',
        sessionId: 'sess-1',
        partType: 'lifecycle',
        timestamp,
      });

      expect(meta.createdAt).toBe(new Date(1700000000000).toISOString());
    });
  });

  // =========================================================================
  // createSessionEventWithMetadata
  // =========================================================================

  describe('createSessionEventWithMetadata', () => {
    it('IT-SEM-002a: creates a full SessionEvent with embedded metadata', () => {
      const options: SessionEventMetadataOptions = {
        sessionId: 'session-xyz',
        type: 'agent:started',
        partType: 'lifecycle',
        data: { agentId: 'agent-1', taskId: 'task-1' },
      };

      const event = createSessionEventWithMetadata(options);

      // Top-level fields
      expect(event.id).toBeTruthy();
      expect(event.type).toBe('agent:started');
      expect(event.timestamp).toBeGreaterThan(0);

      // Data contains original fields plus meta
      const data = event.data as Record<string, unknown>;
      expect(data.agentId).toBe('agent-1');
      expect(data.taskId).toBe('task-1');
      expect(data.meta).toBeDefined();

      // Metadata
      const meta = data.meta as Record<string, unknown>;
      expect(meta.schemaVersion).toBe(1);
      expect(meta.streamId).toBe('session-xyz');
      expect(meta.partType).toBe('lifecycle');
      expect(meta.eventId).toBe(event.id);
    });

    it('IT-SEM-002b: uses provided timestamp when specified', () => {
      const fixedTime = 1700000000000;
      const event = createSessionEventWithMetadata({
        sessionId: 'sess-1',
        type: 'chunk',
        partType: 'chunk_delta',
        data: { text: 'hello' },
        timestamp: fixedTime,
      });

      expect(event.timestamp).toBe(fixedTime);
      const meta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(meta.createdAt).toBe(new Date(fixedTime).toISOString());
    });

    it('IT-SEM-002c: generates unique event IDs', () => {
      const options: SessionEventMetadataOptions = {
        sessionId: 'sess-1',
        type: 'agent:turn',
        partType: 'lifecycle',
        data: { turnNumber: 1 },
      };

      const event1 = createSessionEventWithMetadata(options);
      const event2 = createSessionEventWithMetadata(options);

      expect(event1.id).not.toBe(event2.id);
    });

    it('IT-SEM-002d: passes through blockId to metadata', () => {
      const event = createSessionEventWithMetadata({
        sessionId: 'sess-1',
        type: 'chunk',
        partType: 'chunk_start',
        data: {},
        blockId: 'block-99',
      });

      const meta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(meta.blockId).toBe('block-99');
    });

    it('IT-SEM-002e: passes through durability to metadata', () => {
      const event = createSessionEventWithMetadata({
        sessionId: 'sess-1',
        type: 'chunk',
        partType: 'chunk_delta',
        data: {},
        durability: 'transient',
      });

      const meta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(meta.durability).toBe('transient');
    });

    it('IT-SEM-002f: passes through sequence to metadata', () => {
      const event = createSessionEventWithMetadata({
        sessionId: 'sess-1',
        type: 'tool:start',
        partType: 'tool_start',
        data: { toolName: 'Bash' },
        sequence: 7,
      });

      const meta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(meta.sequence).toBe(7);
    });

    it('IT-SEM-002g: handles all session event types', () => {
      const eventTypes: Array<SessionEventMetadataOptions['type']> = [
        'chunk',
        'tool:start',
        'tool:result',
        'agent:started',
        'agent:turn',
        'agent:completed',
        'agent:error',
        'state:update',
      ];

      for (const type of eventTypes) {
        const event = createSessionEventWithMetadata({
          sessionId: 'sess-1',
          type,
          partType: 'lifecycle',
          data: {},
        });
        expect(event.type).toBe(type);
        expect(event.id).toBeTruthy();
      }
    });

    it('IT-SEM-002h: handles all part types', () => {
      const partTypes: StreamPartType[] = [
        'chunk_start',
        'chunk_delta',
        'chunk_end',
        'tool_start',
        'tool_result',
        'tool_error',
        'system',
        'lifecycle',
        'diff',
      ];

      for (const partType of partTypes) {
        const event = createSessionEventWithMetadata({
          sessionId: 'sess-1',
          type: 'chunk',
          partType,
          data: {},
        });
        const meta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
        expect(meta.partType).toBe(partType);
      }
    });
  });

  // =========================================================================
  // createStreamPayloadWithMetadata
  // =========================================================================

  describe('createStreamPayloadWithMetadata', () => {
    it('IT-SEM-003a: creates payload with data fields and metadata', () => {
      const options: StreamPayloadMetadataOptions = {
        streamId: 'stream-abc',
        partType: 'lifecycle',
        data: { status: 'running', progress: 50 },
      };

      const payload = createStreamPayloadWithMetadata(options);

      // Original data fields preserved
      expect(payload.status).toBe('running');
      expect(payload.progress).toBe(50);

      // Metadata attached
      expect(payload.meta).toBeDefined();
      const meta = payload.meta as Record<string, unknown>;
      expect(meta.schemaVersion).toBe(1);
      expect(meta.streamId).toBe('stream-abc');
      expect(meta.partType).toBe('lifecycle');
    });

    it('IT-SEM-003b: uses provided eventId when specified', () => {
      const payload = createStreamPayloadWithMetadata({
        streamId: 'stream-1',
        partType: 'lifecycle',
        data: {},
        eventId: 'custom-evt-id',
      });

      const meta = payload.meta as Record<string, unknown>;
      expect(meta.eventId).toBe('custom-evt-id');
    });

    it('IT-SEM-003c: generates eventId when not provided', () => {
      const payload = createStreamPayloadWithMetadata({
        streamId: 'stream-1',
        partType: 'lifecycle',
        data: {},
      });

      const meta = payload.meta as Record<string, unknown>;
      expect(meta.eventId).toBeTruthy();
      expect(typeof meta.eventId).toBe('string');
    });

    it('IT-SEM-003d: uses provided timestamp', () => {
      const fixedTime = 1700000000000;
      const payload = createStreamPayloadWithMetadata({
        streamId: 'stream-1',
        partType: 'lifecycle',
        data: {},
        timestamp: fixedTime,
      });

      const meta = payload.meta as Record<string, unknown>;
      expect(meta.createdAt).toBe(new Date(fixedTime).toISOString());
    });

    it('IT-SEM-003e: defaults timestamp to now when not provided', () => {
      const before = Date.now();
      const payload = createStreamPayloadWithMetadata({
        streamId: 'stream-1',
        partType: 'lifecycle',
        data: {},
      });
      const after = Date.now();

      const meta = payload.meta as Record<string, unknown>;
      const createdAt = new Date(meta.createdAt as string).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);
    });

    it('IT-SEM-003f: does not overwrite data fields with meta', () => {
      const payload = createStreamPayloadWithMetadata({
        streamId: 'stream-1',
        partType: 'lifecycle',
        data: { key1: 'val1', key2: 42, nested: { a: true } },
      });

      expect(payload.key1).toBe('val1');
      expect(payload.key2).toBe(42);
      expect((payload.nested as Record<string, unknown>).a).toBe(true);
      expect(payload.meta).toBeDefined();
    });

    it('IT-SEM-003g: all durability values work correctly', () => {
      const durabilities: StreamDurability[] = ['durable', 'transient'];

      for (const durability of durabilities) {
        const payload = createStreamPayloadWithMetadata({
          streamId: 'stream-1',
          partType: 'lifecycle',
          data: {},
          durability,
        });
        const meta = payload.meta as Record<string, unknown>;
        expect(meta.durability).toBe(durability);
      }
    });
  });

  // =========================================================================
  // Cross-function consistency
  // =========================================================================

  describe('cross-function consistency', () => {
    it('IT-SEM-004a: event and payload share the same eventId', () => {
      const event = createSessionEventWithMetadata({
        sessionId: 'sess-1',
        type: 'agent:started',
        partType: 'lifecycle',
        data: { agentId: 'a1' },
      });

      const dataMeta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(dataMeta.eventId).toBe(event.id);
    });

    it('IT-SEM-004b: event timestamp matches metadata createdAt', () => {
      const fixedTime = 1700000000000;
      const event = createSessionEventWithMetadata({
        sessionId: 'sess-1',
        type: 'chunk',
        partType: 'chunk_start',
        data: {},
        timestamp: fixedTime,
      });

      const dataMeta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(dataMeta.createdAt).toBe(new Date(fixedTime).toISOString());
      expect(event.timestamp).toBe(fixedTime);
    });

    it('IT-SEM-004c: metadata streamId matches the sessionId parameter', () => {
      const event = createSessionEventWithMetadata({
        sessionId: 'my-session-id',
        type: 'agent:turn',
        partType: 'lifecycle',
        data: {},
      });

      const dataMeta = (event.data as Record<string, unknown>).meta as Record<string, unknown>;
      expect(dataMeta.streamId).toBe('my-session-id');
    });

    it('IT-SEM-004d: payload with eventId produces consistent metadata', () => {
      const eventId = 'custom-event-id';
      const payload = createStreamPayloadWithMetadata({
        streamId: 'stream-1',
        partType: 'tool_result',
        data: { result: 'ok' },
        eventId,
      });

      const meta = payload.meta as Record<string, unknown>;
      expect(meta.eventId).toBe(eventId);
      expect(meta.streamId).toBe('stream-1');
      expect(meta.partType).toBe('tool_result');
    });
  });
});
