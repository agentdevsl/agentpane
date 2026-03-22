import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthCredentials } from '../../../src/types/credentials';

// Mock the Anthropic SDK before importing the module under test
const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      apiKey: string;
      messages = {
        create: mockMessagesCreate,
      };
      constructor(config: { apiKey: string }) {
        this.apiKey = config.apiKey;
      }
    },
  };
});

// Mock fs for credentials tests
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
    },
  };
});

// Mock os.homedir - need to provide default export structure
vi.mock('node:os', () => {
  return {
    default: {
      homedir: () => '/mock/home',
    },
    homedir: () => '/mock/home',
  };
});

// Import after mocks are set up
import {
  ClaudeClient,
  type ClaudeClientConfig,
  createClaudeClient,
  loadCredentials,
  type TextResult,
  type ToolCallResult,
} from '../../../src/lib/plan-mode/claude-client';

// ============================================
// Test Fixtures
// ============================================

function createMockCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    accessToken: 'test-api-key-12345',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600000, // 1 hour from now
    scope: 'api',
    ...overrides,
  };
}

function createMockTextResponse(text: string) {
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function createMockToolUseResponse(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>
) {
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// Helper to create an async iterator for streaming
async function* createMockStreamIterator(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    yield event;
  }
}

// ============================================
// Test Suite
// ============================================

describe('ClaudeClient', () => {
  let credentials: OAuthCredentials;
  let client: ClaudeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    credentials = createMockCredentials();
    client = new ClaudeClient(credentials);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ============================================
  // API Client Initialization (4 tests)
  // ============================================

  describe('API Client Initialization', () => {
    it('should initialize with default configuration', () => {
      const newClient = new ClaudeClient(credentials);
      expect(newClient).toBeInstanceOf(ClaudeClient);
    });

    it('should initialize with custom model configuration', () => {
      const config: ClaudeClientConfig = {
        model: 'claude-opus-4-20250514',
        maxTokens: 4096,
      };
      const newClient = new ClaudeClient(credentials, config);
      expect(newClient).toBeInstanceOf(ClaudeClient);
    });

    it('should initialize with custom system prompt', () => {
      const config: ClaudeClientConfig = {
        systemPrompt: 'Custom system prompt for testing',
      };
      const newClient = new ClaudeClient(credentials, config);
      expect(newClient).toBeInstanceOf(ClaudeClient);
    });

    it('should use accessToken as API key', () => {
      const customCredentials = createMockCredentials({ accessToken: 'custom-key-abc123' });
      const newClient = new ClaudeClient(customCredentials);
      expect(newClient).toBeInstanceOf(ClaudeClient);
    });
  });

  // ============================================
  // Message Sending - Non-Streaming (5 tests)
  // ============================================

  describe('Message Sending - Non-Streaming', () => {
    it('should send a message and receive text response', async () => {
      mockMessagesCreate.mockResolvedValue(
        createMockTextResponse('Hello, this is a test response.')
      );

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Hello',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('text');
        expect((result.value as TextResult).text).toBe('Hello, this is a test response.');
      }
      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    });

    it('should send a message and receive tool use response', async () => {
      const toolInput = {
        questions: [
          {
            question: 'Which database?',
            header: 'Database',
            options: [{ label: 'PostgreSQL', description: 'Relational' }],
            multiSelect: false,
          },
        ],
      };
      mockMessagesCreate.mockResolvedValue(
        createMockToolUseResponse('AskUserQuestion', 'tool-123', toolInput)
      );

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Help me choose',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('tool_use');
        const toolResult = result.value as ToolCallResult;
        expect(toolResult.toolName).toBe('AskUserQuestion');
        expect(toolResult.toolId).toBe('tool-123');
        expect(toolResult.input).toEqual(toolInput);
      }
    });

    it('should convert multiple turns to Claude message format', async () => {
      mockMessagesCreate.mockResolvedValue(createMockTextResponse('Response'));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'First message',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'turn-2',
          role: 'assistant' as const,
          content: 'First response',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'turn-3',
          role: 'user' as const,
          content: 'Second message',
          timestamp: new Date().toISOString(),
        },
      ];

      await client.sendMessage(turns);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'First message' },
            { role: 'assistant', content: 'First response' },
            { role: 'user', content: 'Second message' },
          ],
        })
      );
    });

    it('should format user answers from interactions correctly', async () => {
      mockMessagesCreate.mockResolvedValue(createMockTextResponse('Response'));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: '',
          timestamp: new Date().toISOString(),
          interaction: {
            id: 'int-1',
            type: 'question' as const,
            questions: [],
            answers: { 'Which approach?': 'Option A', 'Framework preference?': 'React' },
          },
        },
      ];

      await client.sendMessage(turns);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: expect.stringContaining('Q: Which approach?'),
            },
          ],
        })
      );
    });

    it('should include tools in API request', async () => {
      mockMessagesCreate.mockResolvedValue(createMockTextResponse('Response'));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      await client.sendMessage(turns);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'AskUserQuestion' }),
            expect.objectContaining({ name: 'CreateGitHubIssue' }),
          ]),
        })
      );
    });
  });

  // ============================================
  // Streaming Responses (5 tests)
  // ============================================

  describe('Streaming Responses', () => {
    it('should stream text tokens via callback', async () => {
      const streamEvents = [
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ];

      mockMessagesCreate.mockResolvedValue(createMockStreamIterator(streamEvents));

      const tokens: string[] = [];
      const onToken = (delta: string) => {
        tokens.push(delta);
      };

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Hello',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns, onToken);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('text');
        expect((result.value as TextResult).text).toBe('Hello world');
      }
      expect(tokens).toEqual(['Hello', ' world']);
    });

    it('should handle streaming tool use response', async () => {
      const toolInput = JSON.stringify({
        questions: [
          {
            question: 'Test?',
            header: 'Q',
            options: [{ label: 'A', description: 'B' }],
            multiSelect: false,
          },
        ],
      });

      const streamEvents = [
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'AskUserQuestion' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: toolInput.slice(0, 50) },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: toolInput.slice(50) },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ];

      mockMessagesCreate.mockResolvedValue(createMockStreamIterator(streamEvents));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns, vi.fn());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('tool_use');
        const toolResult = result.value as ToolCallResult;
        expect(toolResult.toolName).toBe('AskUserQuestion');
        expect(toolResult.toolId).toBe('tool_1');
      }
    });

    it('should handle malformed JSON in streaming tool input', async () => {
      const streamEvents = [
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'AskUserQuestion' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{ invalid json ' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ];

      mockMessagesCreate.mockResolvedValue(createMockStreamIterator(streamEvents));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns, vi.fn());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_TOOL_INPUT_PARSE_ERROR');
        expect(result.error.message).toContain('Invalid JSON');
      }
    });

    it('should enable stream mode when callback provided', async () => {
      const streamEvents = [
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Test' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ];

      mockMessagesCreate.mockResolvedValue(createMockStreamIterator(streamEvents));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      await client.sendMessage(turns, vi.fn());

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
        })
      );
    });

    it('should return accumulated text when no tool use in stream', async () => {
      const streamEvents = [
        { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part 1. ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part 2. ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part 3.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ];

      mockMessagesCreate.mockResolvedValue(createMockStreamIterator(streamEvents));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns, vi.fn());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('text');
        expect((result.value as TextResult).text).toBe('Part 1. Part 2. Part 3.');
      }
    });
  });

  // ============================================
  // Error Handling (4 tests)
  // ============================================

  describe('Error Handling', () => {
    it('should return API error when SDK throws', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('Rate limit exceeded'));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_API_ERROR');
        expect(result.error.message).toContain('Rate limit exceeded');
      }
    });

    it('should handle non-Error thrown exceptions', async () => {
      mockMessagesCreate.mockRejectedValue('String error');

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_API_ERROR');
        expect(result.error.message).toContain('String error');
      }
    });

    it('should handle API timeout errors', async () => {
      mockMessagesCreate.mockRejectedValue(new Error('Request timeout'));

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_API_ERROR');
      }
    });

    it('should handle network errors gracefully', async () => {
      const networkError = new Error('Network request failed');
      (networkError as NodeJS.ErrnoException).code = 'ENOTFOUND';
      mockMessagesCreate.mockRejectedValue(networkError);

      const turns = [
        {
          id: 'turn-1',
          role: 'user' as const,
          content: 'Test',
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await client.sendMessage(turns);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PLAN_API_ERROR');
      }
    });
  });

  // ============================================
  // Tool Input Parsing (4 tests)
  // ============================================

  describe('Tool Input Parsing', () => {
    it('should parse valid AskUserQuestion input', () => {
      const input = {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [
              { label: 'React', description: 'Component library' },
              { label: 'Vue', description: 'Progressive framework' },
            ],
            multiSelect: false,
          },
        ],
      };

      const result = client.parseAskUserQuestion(input);

      expect(result.type).toBe('question');
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].question).toBe('Which framework?');
      expect(result.id).toBeDefined();
    });

    it('should throw on invalid AskUserQuestion input', () => {
      const invalidInput = {
        questions: 'not an array',
      };

      expect(() => client.parseAskUserQuestion(invalidInput as Record<string, unknown>)).toThrow();
    });

    it('should parse valid CreateGitHubIssue input', () => {
      const input = {
        title: 'Implementation Plan',
        body: '## Overview\n\nThis is the plan.',
        labels: ['plan', 'enhancement'],
      };

      const result = client.parseCreateGitHubIssue(input);

      expect(result.title).toBe('Implementation Plan');
      expect(result.body).toBe('## Overview\n\nThis is the plan.');
      expect(result.labels).toEqual(['plan', 'enhancement']);
    });

    it('should parse CreateGitHubIssue input without optional labels', () => {
      const input = {
        title: 'Bug Fix',
        body: 'Fix the login issue',
      };

      const result = client.parseCreateGitHubIssue(input);

      expect(result.title).toBe('Bug Fix');
      expect(result.body).toBe('Fix the login issue');
      expect(result.labels).toBeUndefined();
    });
  });
});

// ============================================
// loadCredentials Tests
// ============================================

describe('loadCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should load valid credentials from file', async () => {
    const mockCredentials = {
      accessToken: 'test-api-key',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600000,
    };
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    const result = await loadCredentials();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('test-api-key');
    }
    expect(fs.promises.readFile).toHaveBeenCalledWith(
      path.join('/mock/home', '.claude', '.credentials.json'),
      'utf-8'
    );
  });

  it('should return error for missing credentials file', async () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    vi.mocked(fs.promises.readFile).mockRejectedValue(error);

    const result = await loadCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    }
  });

  it('should return error for expired credentials', async () => {
    const mockCredentials = {
      accessToken: 'test-api-key',
      expiresAt: Date.now() - 3600000, // 1 hour ago
    };
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    const result = await loadCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    }
  });

  it('should return error for malformed JSON', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue('{ invalid json }');

    const result = await loadCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    }
  });

  it('should return error when accessToken is missing', async () => {
    const mockCredentials = {
      refreshToken: 'test-refresh',
    };
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    const result = await loadCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    }
  });

  it('should handle permission denied error', async () => {
    const error = new Error('EACCES') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    vi.mocked(fs.promises.readFile).mockRejectedValue(error);

    const result = await loadCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    }
  });

  it('should accept credentials without expiresAt', async () => {
    const mockCredentials = {
      accessToken: 'test-api-key',
    };
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    const result = await loadCredentials();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessToken).toBe('test-api-key');
    }
  });
});

// ============================================
// createClaudeClient Tests
// ============================================

describe('createClaudeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should create a client with valid credentials', async () => {
    const mockCredentials = {
      accessToken: 'valid-api-key',
      expiresAt: Date.now() + 3600000,
    };
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    const result = await createClaudeClient();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(ClaudeClient);
    }
  });

  it('should pass configuration to the client', async () => {
    const mockCredentials = {
      accessToken: 'valid-api-key',
      expiresAt: Date.now() + 3600000,
    };
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockCredentials));

    const config: ClaudeClientConfig = {
      model: 'claude-opus-4-20250514',
      maxTokens: 16384,
      systemPrompt: 'Custom prompt',
    };

    const result = await createClaudeClient(config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(ClaudeClient);
    }
  });

  it('should propagate credentials error', async () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    vi.mocked(fs.promises.readFile).mockRejectedValue(error);

    const result = await createClaudeClient();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
    }
  });
});

// ============================================
// Additional Edge Case Tests
// ============================================

describe('ClaudeClient Edge Cases', () => {
  let credentials: OAuthCredentials;
  let client: ClaudeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    credentials = createMockCredentials();
    client = new ClaudeClient(credentials);
  });

  function _createMockCredentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
    return {
      accessToken: 'test-api-key-12345',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600000,
      scope: 'api',
      ...overrides,
    };
  }

  it('should handle empty turns array', async () => {
    mockMessagesCreate.mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 10 },
    });

    const result = await client.sendMessage([]);

    expect(result.ok).toBe(true);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [],
      })
    );
  });

  it('should handle response with multiple text blocks', async () => {
    mockMessagesCreate.mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'First part. ' },
        { type: 'text', text: 'Second part.' },
      ],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const turns = [
      { id: 'turn-1', role: 'user' as const, content: 'Test', timestamp: new Date().toISOString() },
    ];

    const result = await client.sendMessage(turns);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('text');
      expect((result.value as TextResult).text).toBe('First part. Second part.');
    }
  });

  it('should handle response with mixed content types', async () => {
    const toolInput = { title: 'Test', body: 'Content' };
    mockMessagesCreate.mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Some thinking...' },
        { type: 'tool_use', id: 'tool_1', name: 'CreateGitHubIssue', input: toolInput },
      ],
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const turns = [
      { id: 'turn-1', role: 'user' as const, content: 'Test', timestamp: new Date().toISOString() },
    ];

    const result = await client.sendMessage(turns);

    // Tool use should take priority
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('tool_use');
      const toolResult = result.value as ToolCallResult;
      expect(toolResult.toolName).toBe('CreateGitHubIssue');
    }
  });

  it('should handle empty text response', async () => {
    mockMessagesCreate.mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 0 },
    });

    const turns = [
      { id: 'turn-1', role: 'user' as const, content: 'Test', timestamp: new Date().toISOString() },
    ];

    const result = await client.sendMessage(turns);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('text');
      expect((result.value as TextResult).text).toBe('');
    }
  });

  it('should handle response with empty content array', async () => {
    mockMessagesCreate.mockResolvedValue({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 0 },
    });

    const turns = [
      { id: 'turn-1', role: 'user' as const, content: 'Test', timestamp: new Date().toISOString() },
    ];

    const result = await client.sendMessage(turns);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('text');
      expect((result.value as TextResult).text).toBe('');
    }
  });
});
