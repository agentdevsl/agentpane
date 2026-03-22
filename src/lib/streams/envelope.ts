import { z } from 'zod';

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

export function normalizeStreamWireEvent(item: unknown): StreamWireEvent | null {
  const parsed = streamWireEventSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

export function cursorToApproxOffset(cursor: string | null | undefined): number | undefined {
  if (!cursor) {
    return undefined;
  }

  const value = Number.parseInt(cursor, 10);
  return Number.isNaN(value) ? undefined : value;
}
