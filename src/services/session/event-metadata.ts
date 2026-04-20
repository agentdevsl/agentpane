import { createId } from '@paralleldrive/cuid2';
import { getRequestId } from '@/lib/context/request-context';
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
  /**
   * F10-03: optional correlation id. When omitted, we fall back to the
   * AsyncLocalStorage request id so events published inside a Hono request
   * chain automatically carry the correlation key.
   */
  correlationId?: string | null;
}

export interface StreamPayloadMetadataOptions {
  streamId: string;
  partType: StreamPartType;
  data: Record<string, unknown>;
  blockId?: string | null;
  durability?: StreamDurability;
  sequence?: number | null;
  timestamp?: number;
  /** F10-03: see SessionEventMetadataOptions.correlationId. */
  correlationId?: string | null;
}

export function createSessionEventMetadata(params: {
  eventId: string;
  sessionId: string;
  partType: StreamPartType;
  blockId?: string | null;
  durability?: StreamDurability;
  sequence?: number | null;
  timestamp: number;
  correlationId?: string | null;
}): StreamEventMetadata {
  // F10-03: when the caller didn't pass a correlationId, fall back to the
  // current request id in AsyncLocalStorage. Outside a request the store
  // returns undefined — we serialize that as null so the field shape is
  // consistent across sinks.
  const resolvedCorrelationId =
    params.correlationId === undefined ? (getRequestId() ?? null) : (params.correlationId ?? null);
  return {
    schemaVersion: 1,
    eventId: params.eventId,
    streamId: params.sessionId,
    blockId: params.blockId ?? null,
    partType: params.partType,
    durability: params.durability ?? 'durable',
    sequence: params.sequence ?? null,
    createdAt: new Date(params.timestamp).toISOString(),
    correlationId: resolvedCorrelationId,
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
      correlationId: options.correlationId,
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
      correlationId: options.correlationId,
    }),
  };
}
