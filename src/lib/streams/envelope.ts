import { z } from 'zod';

export const STREAM_PROTOCOL_MIGRATION_GATE = 'OC-005d structured-envelope-only migration gate';

export const streamDurabilitySchema = z.enum(['transient', 'durable']);

export type StreamDurability = z.infer<typeof streamDurabilitySchema>;

export const streamPartTypeSchema = z.enum([
  'chunk_start',
  'chunk_delta',
  'chunk_end',
  'tool_start',
  'tool_result',
  'tool_error',
  'system',
  'lifecycle',
  'diff',
]);

export type StreamPartType = z.infer<typeof streamPartTypeSchema>;

export const streamEventMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  streamId: z.string().min(1),
  blockId: z.string().min(1).nullable(),
  partType: streamPartTypeSchema,
  durability: streamDurabilitySchema,
  sequence: z.number().int().nonnegative().nullable(),
  createdAt: z.string().min(1),
});

export type StreamEventMetadata = z.infer<typeof streamEventMetadataSchema>;

export const streamWireEventSchema = z.object({
  type: z.string().min(1),
  data: z.unknown(),
  timestamp: z.number().optional(),
  meta: streamEventMetadataSchema.optional(),
});

export type StreamWireEvent = z.infer<typeof streamWireEventSchema>;

export type StreamEnvelopeGateErrorCode =
  | 'INVALID_WIRE_EVENT'
  | 'MISSING_METADATA'
  | 'INVALID_PAYLOAD_METADATA'
  | 'CONFLICTING_METADATA';

export type StreamEnvelopeGateError = {
  code: StreamEnvelopeGateErrorCode;
  message: string;
};

export type StreamEnvelopeGateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StreamEnvelopeGateError };

type PayloadMetadataParseResult =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'valid'; meta: StreamEventMetadata };

function createGateError(
  code: StreamEnvelopeGateErrorCode,
  message: string
): StreamEnvelopeGateResult<never> {
  return {
    ok: false,
    error: { code, message },
  };
}

function parsePayloadStreamMetadata(data: unknown): PayloadMetadataParseResult {
  if (!data || typeof data !== 'object' || !('meta' in data)) {
    return { status: 'missing' };
  }

  const parsed = streamEventMetadataSchema.safeParse(data.meta);
  if (!parsed.success) {
    return { status: 'invalid' };
  }

  return {
    status: 'valid',
    meta: parsed.data,
  };
}

function metadataMatches(a: StreamEventMetadata, b: StreamEventMetadata): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.eventId === b.eventId &&
    a.streamId === b.streamId &&
    a.blockId === b.blockId &&
    a.partType === b.partType &&
    a.durability === b.durability &&
    a.sequence === b.sequence &&
    a.createdAt === b.createdAt
  );
}

export function getPayloadStreamMetadata(data: unknown): StreamEventMetadata | null {
  const parsed = parsePayloadStreamMetadata(data);
  return parsed.status === 'valid' ? parsed.meta : null;
}

export function requirePayloadStreamMetadata(
  data: unknown,
  context = 'Stream event'
): StreamEnvelopeGateResult<StreamEventMetadata> {
  const parsed = parsePayloadStreamMetadata(data);

  if (parsed.status === 'missing') {
    return createGateError(
      'MISSING_METADATA',
      `${context} is missing structured stream metadata and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
    );
  }

  if (parsed.status === 'invalid') {
    return createGateError(
      'INVALID_PAYLOAD_METADATA',
      `${context} has invalid structured stream metadata and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
    );
  }

  return {
    ok: true,
    value: parsed.meta,
  };
}

export function normalizeStreamWireEvent(item: unknown): StreamWireEvent | null {
  const parsed = streamWireEventSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

export function normalizeStructuredStreamWireEvent(
  item: unknown
): StreamEnvelopeGateResult<StreamWireEvent> {
  const parsed = streamWireEventSchema.safeParse(item);
  if (!parsed.success) {
    return createGateError(
      'INVALID_WIRE_EVENT',
      `Stream item is not a valid wire event and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
    );
  }

  const wireEvent = parsed.data;
  if (wireEvent.type === 'connected') {
    return {
      ok: true,
      value: wireEvent,
    };
  }

  const payloadMetadata = parsePayloadStreamMetadata(wireEvent.data);

  if (wireEvent.meta) {
    if (payloadMetadata.status === 'invalid') {
      return createGateError(
        'INVALID_PAYLOAD_METADATA',
        `Stream event '${wireEvent.type}' has invalid payload metadata and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
      );
    }

    if (
      payloadMetadata.status === 'valid' &&
      !metadataMatches(wireEvent.meta, payloadMetadata.meta)
    ) {
      return createGateError(
        'CONFLICTING_METADATA',
        `Stream event '${wireEvent.type}' mixes conflicting wire and payload metadata and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
      );
    }

    return {
      ok: true,
      value: wireEvent,
    };
  }

  if (payloadMetadata.status === 'valid') {
    return {
      ok: true,
      value: {
        ...wireEvent,
        meta: payloadMetadata.meta,
      },
    };
  }

  if (payloadMetadata.status === 'invalid') {
    return createGateError(
      'INVALID_PAYLOAD_METADATA',
      `Stream event '${wireEvent.type}' has invalid payload metadata and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
    );
  }

  return createGateError(
    'MISSING_METADATA',
    `Stream event '${wireEvent.type}' is missing structured stream metadata and is blocked by the ${STREAM_PROTOCOL_MIGRATION_GATE}.`
  );
}

export function cursorToApproxOffset(cursor: string | null | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }

  const value = Number.parseInt(cursor, 10);
  return Number.isNaN(value) ? undefined : value;
}
