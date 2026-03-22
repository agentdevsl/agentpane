import { createId } from '@paralleldrive/cuid2';
import type { StreamDurability, StreamEventMetadata, StreamPartType } from '@/lib/streams/envelope';
import type { SessionEvent, SessionEventType } from './types.js';

export interface SessionEventMetadataOptions {
  sessionId: string;
  type: SessionEventType;
  partType: StreamPartType;
  data: Record<string, unknown>;
  blockId?: string | null;
  durability?: StreamDurability;
  sequence?: number | null;
  timestamp?: number;
}

export interface StreamPayloadMetadataOptions {
  streamId: string;
  partType: StreamPartType;
  data: Record<string, unknown>;
  blockId?: string | null;
  durability?: StreamDurability;
  sequence?: number | null;
  timestamp?: number;
}

export function createSessionEventMetadata(params: {
  eventId: string;
  sessionId: string;
  partType: StreamPartType;
  blockId?: string | null;
  durability?: StreamDurability;
  sequence?: number | null;
  timestamp: number;
}): StreamEventMetadata {
  return {
    schemaVersion: 1,
    eventId: params.eventId,
    streamId: params.sessionId,
    blockId: params.blockId ?? null,
    partType: params.partType,
    durability: params.durability ?? 'durable',
    sequence: params.sequence ?? null,
    createdAt: new Date(params.timestamp).toISOString(),
  };
}

export function createSessionEventWithMetadata(options: SessionEventMetadataOptions): SessionEvent {
  const timestamp = options.timestamp ?? Date.now();
  const eventId = createId();

  return {
    id: eventId,
    type: options.type,
    timestamp,
    data: createStreamPayloadWithMetadata({
      streamId: options.sessionId,
      partType: options.partType,
      data: options.data,
      blockId: options.blockId,
      durability: options.durability,
      sequence: options.sequence,
      timestamp,
      eventId,
    }),
  };
}

export function createStreamPayloadWithMetadata(
  options: StreamPayloadMetadataOptions & { eventId?: string }
): Record<string, unknown> {
  const timestamp = options.timestamp ?? Date.now();
  const eventId = options.eventId ?? createId();

  return {
    ...options.data,
    meta: createSessionEventMetadata({
      eventId,
      sessionId: options.streamId,
      partType: options.partType,
      blockId: options.blockId,
      durability: options.durability,
      sequence: options.sequence,
      timestamp,
    }),
  };
}
