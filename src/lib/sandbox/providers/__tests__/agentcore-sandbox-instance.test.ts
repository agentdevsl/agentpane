import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentCoreInstanceOptions,
  AgentCoreSandboxInstance,
  type SSEEvent,
} from '../agentcore-sandbox-instance.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../../logging/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSSEChunk(
  events: Array<{ type: string; data: Record<string, unknown> }>
): Uint8Array {
  const lines = events
    .map((e) => `data: ${JSON.stringify({ type: e.type, data: e.data })}`)
    .join('\n\n');
  return new TextEncoder().encode(`${lines}\n\n`);
}

function createSSEChunkWithEventField(
  eventType: string,
  data: Record<string, unknown>
): Uint8Array {
  return new TextEncoder().encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

function createReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index++;
      } else {
        controller.close();
      }
    },
  });
}

function createInstance(
  overrides: Partial<AgentCoreInstanceOptions> = {}
): AgentCoreSandboxInstance {
  return new AgentCoreSandboxInstance({
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime-id',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    projectId: 'proj-001',
    sandboxId: 'sandbox-001',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCoreSandboxInstance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.log noise from info/debug logs
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor and properties
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('should set properties from options', () => {
      const instance = createInstance();

      expect(instance.runtimeArn).toBe(
        'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/test-runtime-id'
      );
      expect(instance.projectId).toBe('proj-001');
      expect(instance.sandboxId).toBe('sandbox-001');
    });
  });

  // -------------------------------------------------------------------------
  // Status tracking
  // -------------------------------------------------------------------------

  describe('status', () => {
    it('should have initial status of running', () => {
      const instance = createInstance();
      expect(instance.status).toBe('running');
    });

    it('should change status to stopped after stop()', async () => {
      const instance = createInstance();
      expect(instance.status).toBe('running');

      await instance.stop();
      expect(instance.status).toBe('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // refreshStatus
  // -------------------------------------------------------------------------

  describe('refreshStatus', () => {
    it('should return current status', async () => {
      const instance = createInstance();
      const status = await instance.refreshStatus();
      expect(status).toBe('running');
    });

    it('should return stopped after stop', async () => {
      const instance = createInstance();
      await instance.stop();
      const status = await instance.refreshStatus();
      expect(status).toBe('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // SSE Parsing (via invoke)
  // -------------------------------------------------------------------------

  describe('parseSSEStream (tested via invoke)', () => {
    // We test SSE parsing indirectly through invoke. We need to mock fetch.

    it('should parse SSE stream into events', async () => {
      const sseChunk = createSSEChunk([
        { type: 'agent:started', data: { message: 'hello' } },
        { type: 'agent:turn', data: { turnCount: 1 } },
      ]);

      const mockResponse = {
        ok: true,
        status: 200,
        body: createReadableStream([sseChunk]),
        text: vi.fn(),
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: 'agent:started',
        data: { message: 'hello' },
      });
      expect(events[1]).toEqual({
        type: 'agent:turn',
        data: { turnCount: 1 },
      });

      vi.unstubAllGlobals();
    });

    it('should handle multiple events in a single chunk', async () => {
      const chunk = createSSEChunk([
        { type: 'agent:token', data: { delta: 'a' } },
        { type: 'agent:token', data: { delta: 'b' } },
        { type: 'agent:token', data: { delta: 'c' } },
      ]);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: createReadableStream([chunk]),
          text: vi.fn(),
        })
      );

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events.map((e) => (e.data as { delta: string }).delta)).toEqual(['a', 'b', 'c']);

      vi.unstubAllGlobals();
    });

    it('should handle events split across chunks', async () => {
      // Split a single event across two chunks
      const fullEvent = `data: ${JSON.stringify({ type: 'agent:started', data: { message: 'split' } })}\n\n`;
      const midpoint = Math.floor(fullEvent.length / 2);
      const chunk1 = new TextEncoder().encode(fullEvent.slice(0, midpoint));
      const chunk2 = new TextEncoder().encode(fullEvent.slice(midpoint));

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: createReadableStream([chunk1, chunk2]),
          text: vi.fn(),
        })
      );

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'agent:started',
        data: { message: 'split' },
      });

      vi.unstubAllGlobals();
    });

    it('should skip malformed SSE data', async () => {
      // Mix valid and invalid data lines
      const sseText =
        'data: not valid json\n\n' +
        `data: ${JSON.stringify({ type: 'agent:started', data: { ok: true } })}\n\n` +
        'data: {broken\n\n';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: createReadableStream([new TextEncoder().encode(sseText)]),
          text: vi.fn(),
        })
      );

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      // Only the valid event should be parsed
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('agent:started');

      vi.unstubAllGlobals();
    });

    it('should handle SSE comment lines (starting with colon)', async () => {
      const sseText =
        ': this is a comment\n' +
        `data: ${JSON.stringify({ type: 'agent:started', data: { ok: true } })}\n\n`;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: createReadableStream([new TextEncoder().encode(sseText)]),
          text: vi.fn(),
        })
      );

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('agent:started');

      vi.unstubAllGlobals();
    });

    it('should support unwrapped format with event field', async () => {
      const chunk = createSSEChunkWithEventField('agent:turn', { turnCount: 1, content: 'hi' });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: createReadableStream([chunk]),
          text: vi.fn(),
        })
      );

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'agent:turn',
        data: { turnCount: 1, content: 'hi' },
      });

      vi.unstubAllGlobals();
    });

    it('should skip blocks with no data lines', async () => {
      const sseText = 'event: agent:turn\n\n'; // event field but no data

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          body: createReadableStream([new TextEncoder().encode(sseText)]),
          text: vi.fn(),
        })
      );

      const instance = createInstance();
      const events: SSEEvent[] = [];

      for await (const event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        events.push(event);
      }

      expect(events).toHaveLength(0);

      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // Invoke payload and URL construction
  // -------------------------------------------------------------------------

  describe('invoke', () => {
    it('should send correct payload to AgentCore', async () => {
      const payload = { prompt: 'Implement feature X', maxTurns: 50 };
      let capturedBody: string | undefined;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, options: RequestInit) => {
          capturedBody = options.body as string;
          return Promise.resolve({
            ok: true,
            body: createReadableStream([]),
            text: vi.fn(),
          });
        })
      );

      const instance = createInstance();

      // Consume the generator
      for await (const _event of instance.invoke(payload, 'session-1')) {
        // no-op
      }

      expect(capturedBody).toBeDefined();
      expect(JSON.parse(capturedBody!)).toEqual(payload);

      vi.unstubAllGlobals();
    });

    it('should construct correct URL with runtime ID and session ID', async () => {
      let capturedUrl: string | undefined;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          capturedUrl = url;
          return Promise.resolve({
            ok: true,
            body: createReadableStream([]),
            text: vi.fn(),
          });
        })
      );

      const instance = createInstance();

      for await (const _event of instance.invoke({ prompt: 'test' }, 'my-session-123')) {
        // no-op
      }

      expect(capturedUrl).toBeDefined();
      expect(capturedUrl).toContain('bedrock-agentcore.us-east-1.amazonaws.com');
      expect(capturedUrl).toContain('/agentruntimes/test-runtime-id/');
      expect(capturedUrl).toContain('/sessions/my-session-123/invoke');

      vi.unstubAllGlobals();
    });

    it('should include proper headers (Content-Type, Accept, Auth)', async () => {
      let capturedHeaders: Record<string, string> | undefined;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, options: RequestInit) => {
          capturedHeaders = options.headers as Record<string, string>;
          return Promise.resolve({
            ok: true,
            body: createReadableStream([]),
            text: vi.fn(),
          });
        })
      );

      const instance = createInstance();

      for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        // no-op
      }

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!['Content-Type']).toBe('application/json');
      expect(capturedHeaders!.Accept).toBe('text/event-stream');
      // SigV4 headers
      expect(capturedHeaders!.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
      expect(capturedHeaders!['x-amz-date']).toBeDefined();
      expect(capturedHeaders!['x-amz-content-sha256']).toBeDefined();

      vi.unstubAllGlobals();
    });

    it('should use POST method', async () => {
      let capturedMethod: string | undefined;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, options: RequestInit) => {
          capturedMethod = options.method;
          return Promise.resolve({
            ok: true,
            body: createReadableStream([]),
            text: vi.fn(),
          });
        })
      );

      const instance = createInstance();

      for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        // no-op
      }

      expect(capturedMethod).toBe('POST');

      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should throw SESSION_INVOKE_FAILED on HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: vi.fn().mockResolvedValue('Access denied'),
        })
      );

      const instance = createInstance();

      await expect(async () => {
        for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
          // no-op
        }
      }).rejects.toMatchObject({
        code: 'AGENTCORE-602',
        message: expect.stringContaining('HTTP 403'),
      });

      vi.unstubAllGlobals();
    });

    it('should throw SESSION_INVOKE_FAILED when response body is empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: null,
          text: vi.fn(),
        })
      );

      const instance = createInstance();

      await expect(async () => {
        for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
          // no-op
        }
      }).rejects.toMatchObject({
        code: 'AGENTCORE-602',
        message: expect.stringContaining('empty'),
      });

      vi.unstubAllGlobals();
    });

    it('should throw SESSION_INVOKE_FAILED on fetch error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS resolution failed')));

      const instance = createInstance();

      await expect(async () => {
        for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
          // no-op
        }
      }).rejects.toMatchObject({
        code: 'AGENTCORE-602',
        message: expect.stringContaining('DNS resolution failed'),
      });

      vi.unstubAllGlobals();
    });

    it('should throw SESSION_INVOKE_FAILED when error text cannot be read', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: vi.fn().mockRejectedValue(new Error('body stream already read')),
        })
      );

      const instance = createInstance();

      await expect(async () => {
        for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
          // no-op
        }
      }).rejects.toMatchObject({
        code: 'AGENTCORE-602',
        message: expect.stringContaining('HTTP 500'),
      });

      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // extractRuntimeId
  // -------------------------------------------------------------------------

  describe('runtime ID extraction', () => {
    it('should extract runtime ID from full ARN in URL', async () => {
      let capturedUrl: string | undefined;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          capturedUrl = url;
          return Promise.resolve({
            ok: true,
            body: createReadableStream([]),
            text: vi.fn(),
          });
        })
      );

      const instance = createInstance({
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/my-runtime-abc',
      });

      for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        // no-op
      }

      expect(capturedUrl).toContain('/agentruntimes/my-runtime-abc/');

      vi.unstubAllGlobals();
    });

    it('should use raw string when ARN has no slash', async () => {
      let capturedUrl: string | undefined;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          capturedUrl = url;
          return Promise.resolve({
            ok: true,
            body: createReadableStream([]),
            text: vi.fn(),
          });
        })
      );

      const instance = createInstance({
        runtimeArn: 'plain-runtime-id',
      });

      for await (const _event of instance.invoke({ prompt: 'test' }, 'session-1')) {
        // no-op
      }

      expect(capturedUrl).toContain('/agentruntimes/plain-runtime-id/');

      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('should set status to stopped', async () => {
      const instance = createInstance();
      expect(instance.status).toBe('running');

      await instance.stop();
      expect(instance.status).toBe('stopped');
    });
  });
});
