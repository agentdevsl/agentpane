import { describe, expect, it } from 'vitest';
import { requestContextStorage } from '../../../lib/context/request-context.js';
import {
  requirePayloadStreamMetadata,
  streamEventMetadataSchema,
} from '../../../lib/streams/envelope.js';
import {
  createSessionEventWithMetadata,
  createStreamPayloadWithMetadata,
} from '../event-metadata.js';

describe('F10-03 — correlationId propagation through envelope metadata', () => {
  it('defaults correlationId to the AsyncLocalStorage request id', () => {
    const event = requestContextStorage.run({ requestId: 'req-flow-1' }, () =>
      createSessionEventWithMetadata({
        sessionId: 'sess_abc',
        type: 'agent:started',
        partType: 'lifecycle',
        data: { agentId: 'a1' },
      })
    );

    const meta = (event.data as { meta: Record<string, unknown> }).meta;
    expect(meta).toBeDefined();
    const parsed = streamEventMetadataSchema.parse(meta);
    expect(parsed.correlationId).toBe('req-flow-1');
  });

  it('carries correlationId through createStreamPayloadWithMetadata', () => {
    const payload = createStreamPayloadWithMetadata({
      streamId: 'sess_abc',
      partType: 'lifecycle',
      data: { foo: 'bar' },
      correlationId: 'req-explicit',
    });

    const validate = requirePayloadStreamMetadata(payload, 'test event');
    expect(validate.ok).toBe(true);
    if (validate.ok) {
      expect(validate.value.correlationId).toBe('req-explicit');
    }
  });

  it('serialises correlationId as null outside a request context when caller omits it', () => {
    const payload = createStreamPayloadWithMetadata({
      streamId: 'sess_abc',
      partType: 'lifecycle',
      data: { foo: 'bar' },
    });

    const validate = requirePayloadStreamMetadata(payload, 'test event');
    expect(validate.ok).toBe(true);
    if (validate.ok) {
      expect(validate.value.correlationId).toBeNull();
    }
  });

  it('accepts the legacy metadata shape (no correlationId) for backwards compat', () => {
    const legacy = {
      schemaVersion: 1 as const,
      eventId: 'evt1',
      streamId: 's1',
      blockId: null,
      partType: 'lifecycle' as const,
      durability: 'durable' as const,
      sequence: null,
      createdAt: new Date().toISOString(),
    };
    const result = streamEventMetadataSchema.safeParse(legacy);
    expect(result.success).toBe(true);
  });
});
