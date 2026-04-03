/**
 * Integration tests for agent-sdk-utils.ts — buildSdkEnv(), agentQuery(), agentPrompt().
 *
 * Tests verify environment variable filtering, SDK session management,
 * streaming accumulation, usage extraction, and error handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── SDK Mock ──────────────────────────────────────────────────────────────────

const mockSessionSend = vi.fn().mockResolvedValue(undefined);
const mockSessionClose = vi.fn();
let mockStreamIterable: AsyncIterable<unknown>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(() => ({
    send: mockSessionSend,
    stream: () => mockStreamIterable,
    close: mockSessionClose,
  })),
  unstable_v2_prompt: vi.fn(),
}));

// Suppress logger output
vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
import { unstable_v2_prompt } from '@anthropic-ai/claude-agent-sdk';
import { agentPrompt, agentQuery, buildSdkEnv } from '../../src/lib/agents/agent-sdk-utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < items.length) {
            return { value: items[index++], done: false as const };
          }
          return { value: undefined as unknown as T, done: true as const };
        },
      };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Agent SDK Utils (IT-1600 to IT-1601)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── buildSdkEnv ─────────────────────────────────────────────────────────

  describe('buildSdkEnv', () => {
    it('IT-1600: strips the exact CLAUDECODE key', () => {
      const originalEnv = { ...process.env };
      try {
        // The regex matches exactly "CLAUDECODE" (with $ anchor), not CLAUDECODE_*
        process.env.CLAUDECODE = 'secret-value';
        process.env.HOME = '/home/test';

        const env = buildSdkEnv();

        expect(env.CLAUDECODE).toBeUndefined();
        expect(env.HOME).toBe('/home/test');
      } finally {
        process.env = originalEnv;
      }
    });

    it('IT-1602: strips DATABASE_URL and DB_* vars', () => {
      const originalEnv = { ...process.env };
      try {
        process.env.DATABASE_URL = 'sqlite:///test.db';
        process.env.DB_HOST = 'localhost';
        process.env.DB_PASSWORD = 'secret';
        process.env.PATH = '/usr/bin';

        const env = buildSdkEnv();

        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.DB_HOST).toBeUndefined();
        expect(env.DB_PASSWORD).toBeUndefined();
        expect(env.PATH).toBe('/usr/bin');
      } finally {
        process.env = originalEnv;
      }
    });

    it('IT-1603: strips ENCRYPTION_KEY, SESSION_SECRET, GITHUB_APP_PRIVATE_KEY', () => {
      const originalEnv = { ...process.env };
      try {
        process.env.ENCRYPTION_KEY = 'aes-256-key';
        process.env.SESSION_SECRET = 'session-secret';
        process.env.GITHUB_APP_PRIVATE_KEY = 'rsa-private';
        process.env.SAFE_VAR = 'keep-me';

        const env = buildSdkEnv();

        expect(env.ENCRYPTION_KEY).toBeUndefined();
        expect(env.SESSION_SECRET).toBeUndefined();
        expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
        expect(env.SAFE_VAR).toBe('keep-me');
      } finally {
        process.env = originalEnv;
      }
    });

    it('IT-1604: extra param overrides base env', () => {
      const originalEnv = { ...process.env };
      try {
        process.env.MY_VAR = 'original';

        const env = buildSdkEnv({ MY_VAR: 'overridden', NEW_VAR: 'new-value' });

        expect(env.MY_VAR).toBe('overridden');
        expect(env.NEW_VAR).toBe('new-value');
      } finally {
        process.env = originalEnv;
      }
    });

    it('IT-1605: DB_* wildcard blocks DB_HOST, DB_PASSWORD etc', () => {
      const originalEnv = { ...process.env };
      try {
        // The regex has DB_.* which matches DB_ followed by anything
        process.env.DB_PORT = '5432';
        process.env.DB_NAME = 'mydb';
        process.env.DBSAFE = 'not-blocked'; // No underscore after DB

        const env = buildSdkEnv();

        expect(env.DB_PORT).toBeUndefined();
        expect(env.DB_NAME).toBeUndefined();
        // DBSAFE does not match DB_.* pattern
        expect(env.DBSAFE).toBe('not-blocked');
      } finally {
        process.env = originalEnv;
      }
    });
  });

  // ── agentQuery ──────────────────────────────────────────────────────────

  describe('agentQuery', () => {
    it('IT-1606: accumulates text from content_block_delta events', async () => {
      mockStreamIterable = createAsyncIterable([
        {
          type: 'stream_event',
          event: { type: 'message_start', message: { model: 'claude-sonnet-4-6' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'World' } },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
        },
      ]);

      const result = await agentQuery('Test prompt');

      expect(result.text).toBe('Hello World');
      expect(mockSessionSend).toHaveBeenCalledWith('Test prompt');
      expect(mockSessionClose).toHaveBeenCalled();
    });

    it('IT-1607: extracts usage from message_start and message_delta', async () => {
      mockStreamIterable = createAsyncIterable([
        {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: {
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 100 },
            },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Response' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'message_delta',
            usage: { output_tokens: 50 },
          },
        },
      ]);

      const result = await agentQuery('Test');

      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('IT-1608: onToken callback receives text deltas', async () => {
      const tokens: string[] = [];
      mockStreamIterable = createAsyncIterable([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } },
        },
      ]);

      await agentQuery('Test', { onToken: (delta) => tokens.push(delta) });

      expect(tokens).toEqual(['A', 'B']);
    });

    it('IT-1609: assistant message overwrites accumulated text', async () => {
      mockStreamIterable = createAsyncIterable([
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streaming' } },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Final complete response' }] },
        },
      ]);

      const result = await agentQuery('Test');

      expect(result.text).toBe('Final complete response');
    });

    it('IT-1610: session.close called in finally block even on error', async () => {
      mockStreamIterable = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              throw new Error('Stream error');
            },
          };
        },
      };

      await expect(agentQuery('Test')).rejects.toThrow('Stream error');
      expect(mockSessionClose).toHaveBeenCalled();
    });
  });

  // ── agentPrompt ─────────────────────────────────────────────────────────

  describe('agentPrompt', () => {
    it('IT-1611: returns text from successful prompt result', async () => {
      const mockPrompt = vi.mocked(unstable_v2_prompt);
      mockPrompt.mockResolvedValue({
        is_error: false,
        result: 'Generated workflow YAML',
        usage: { input_tokens: 200, output_tokens: 100 },
      } as never);

      const result = await agentPrompt('Generate a workflow');

      expect(result.text).toBe('Generated workflow YAML');
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    });

    it('IT-1601: throws on error result with error message', async () => {
      const mockPrompt = vi.mocked(unstable_v2_prompt);
      mockPrompt.mockResolvedValue({
        is_error: true,
        errors: ['Rate limit exceeded'],
        usage: { input_tokens: 0, output_tokens: 0 },
      } as never);

      await expect(agentPrompt('Generate')).rejects.toThrow('Rate limit exceeded');
    });
  });
});
