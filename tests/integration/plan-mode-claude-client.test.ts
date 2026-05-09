/**
 * Integration tests for src/lib/plan-mode/claude-client.ts.
 *
 * Wraps the Anthropic SDK with streaming + tool-use parsing for plan mode.
 * Mocks the SDK and the on-disk credentials reader so we can exercise:
 * - loadCredentials + createClaudeClient (success + missing creds)
 * - Constructor config (default + custom model/maxTokens/systemPrompt)
 * - sendMessage non-streaming (text result, tool_use result, API error,
 *   turnsToMessages with interaction.answers)
 * - sendMessage streaming (text deltas accumulated, tool_use input
 *   accumulated from input_json_delta, JSON parse error path, SDK throw)
 * - parseAskUserQuestion + parseCreateGitHubIssue (success + Zod failures)
 *
 * IT-IDs: IT-2500 to IT-2529
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: sdkMocks.messagesCreate };
  },
}));

const credsMocks = vi.hoisted(() => ({
  readCredentialsFile: vi.fn(),
}));
vi.mock('../../src/lib/utils/resolve-anthropic-key.js', () => ({
  readCredentialsFile: credsMocks.readCredentialsFile,
}));

import {
  ClaudeClient,
  createClaudeClient,
  loadCredentials,
} from '../../src/lib/plan-mode/claude-client';
import type { PlanTurn } from '../../src/lib/plan-mode/types';

const sampleCreds = {
  accessToken: 'sk-ant-fake',
  refreshToken: '',
  expiresAt: Date.now() + 3600_000,
  scope: 'user:inference',
};

beforeEach(() => {
  vi.clearAllMocks();
  credsMocks.readCredentialsFile.mockResolvedValue(sampleCreds);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── loadCredentials + createClaudeClient ──────────────────────────────

describe('loadCredentials', () => {
  it('IT-2500: returns the credentials object on success', async () => {
    const result = await loadCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accessToken).toBe('sk-ant-fake');
  });

  it('IT-2501: returns CREDENTIALS_NOT_FOUND when file missing', async () => {
    credsMocks.readCredentialsFile.mockResolvedValue(null);
    const result = await loadCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
  });
});

describe('createClaudeClient factory', () => {
  it('IT-2502: returns a ClaudeClient when credentials present', async () => {
    const result = await createClaudeClient();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeInstanceOf(ClaudeClient);
  });

  it('IT-2503: propagates CREDENTIALS_NOT_FOUND from loadCredentials', async () => {
    credsMocks.readCredentialsFile.mockResolvedValue(null);
    const result = await createClaudeClient();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PLAN_CREDENTIALS_NOT_FOUND');
  });

  it('IT-2504: forwards config (model, systemPrompt) to the constructor', async () => {
    const result = await createClaudeClient({
      model: 'custom-model',
      systemPrompt: 'You are a tester.',
    });
    expect(result.ok).toBe(true);
  });
});

// ─── Constructor ─────────────────────────────────────────────────────

describe('ClaudeClient constructor', () => {
  it('IT-2505: accepts default config (no overrides)', () => {
    const c = new ClaudeClient(sampleCreds);
    expect(c).toBeInstanceOf(ClaudeClient);
  });

  it('IT-2506: honors custom model / maxTokens / systemPrompt', () => {
    const c = new ClaudeClient(sampleCreds, {
      model: 'claude-opus-4-7',
      maxTokens: 4096,
      systemPrompt: 'You are a test assistant.',
    });
    expect(c).toBeInstanceOf(ClaudeClient);
  });
});

// ─── ClaudeClient.sendMessage non-streaming ────────────────────────────

describe('ClaudeClient.sendMessage (non-streaming)', () => {
  function makeClient(systemPrompt?: string) {
    return new ClaudeClient(sampleCreds, { systemPrompt });
  }

  function turn(role: 'user' | 'assistant', content: string, interaction?: unknown): PlanTurn {
    return {
      role,
      content,
      interaction: interaction as never,
      tokenCount: 0,
      timestamp: new Date().toISOString(),
    } as unknown as PlanTurn;
  }

  it('IT-2510: returns text result when response has only text blocks', async () => {
    sdkMocks.messagesCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    });
    const client = makeClient('test-prompt');
    const result = await client.sendMessage([turn('user', 'hi')]);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === 'text') {
      expect(result.value.text).toBe('Hello world');
    }
  });

  it('IT-2511: returns tool_use result when first content block is a tool call', async () => {
    sdkMocks.messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'AskUserQuestion',
          input: { questions: [] },
        },
      ],
    });
    const client = makeClient('test-prompt');
    const result = await client.sendMessage([turn('user', 'hi')]);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === 'tool_use') {
      expect(result.value.toolName).toBe('AskUserQuestion');
      expect(result.value.toolId).toBe('tool-1');
    }
  });

  it('IT-2512: returns API_ERROR when the SDK throws', async () => {
    sdkMocks.messagesCreate.mockRejectedValue(new Error('rate limited'));
    const client = makeClient('test-prompt');
    const result = await client.sendMessage([turn('user', 'hi')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_API_ERROR');
      expect(result.error.message).toContain('rate limited');
    }
  });

  it('IT-2513: turnsToMessages formats interaction.answers as Q/A pairs', async () => {
    sdkMocks.messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const client = makeClient('test-prompt');
    await client.sendMessage([
      turn('user', 'initial'),
      turn('assistant', 'questions...'),
      turn('user', '', { answers: { 'What region?': 'us-east-1', 'Env?': 'prod' } }),
    ]);
    const call = sdkMocks.messagesCreate.mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages).toHaveLength(3);
    expect(call.messages[2]!.content).toContain('Q: What region?');
    expect(call.messages[2]!.content).toContain('A: us-east-1');
    expect(call.messages[2]!.content).toContain('Q: Env?');
  });
});

// ─── ClaudeClient.sendMessage streaming ───────────────────────────────

describe('ClaudeClient.sendMessage (streaming)', () => {
  function turn(role: 'user' | 'assistant', content: string): PlanTurn {
    return {
      role,
      content,
      tokenCount: 0,
      timestamp: new Date().toISOString(),
    } as unknown as PlanTurn;
  }

  async function* streamEvents(events: unknown[]): AsyncIterable<unknown> {
    for (const e of events) yield e;
  }

  it('IT-2515: streams text deltas and accumulates final text', async () => {
    sdkMocks.messagesCreate.mockResolvedValue(
      streamEvents([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        { type: 'content_block_stop' },
      ])
    );
    const client = new ClaudeClient(sampleCreds, { systemPrompt: 'test' });
    const tokens: string[] = [];
    const result = await client.sendMessage([turn('user', 'hi')], (t) => tokens.push(t));
    expect(result.ok).toBe(true);
    expect(tokens).toEqual(['Hel', 'lo']);
    if (result.ok && result.value.type === 'text') {
      expect(result.value.text).toBe('Hello');
    }
  });

  it('IT-2516: parses tool_use input from accumulated input_json_delta events', async () => {
    sdkMocks.messagesCreate.mockResolvedValue(
      streamEvents([
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion' },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"questions":[' },
        },
        {
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: '{"question":"q","header":"H","options":[],"multiSelect":false}]}',
          },
        },
        { type: 'content_block_stop' },
      ])
    );
    const client = new ClaudeClient(sampleCreds, { systemPrompt: 'test' });
    const result = await client.sendMessage([turn('user', 'hi')], () => {});
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === 'tool_use') {
      expect(result.value.toolName).toBe('AskUserQuestion');
      expect(result.value.input).toMatchObject({ questions: expect.any(Array) });
    }
  });

  it('IT-2517: returns TOOL_INPUT_PARSE_ERROR when accumulated JSON is invalid', async () => {
    sdkMocks.messagesCreate.mockResolvedValue(
      streamEvents([
        {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-x', name: 'CreateGitHubIssue' },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{not-valid' },
        },
        { type: 'content_block_stop' },
      ])
    );
    const client = new ClaudeClient(sampleCreds, { systemPrompt: 'test' });
    const result = await client.sendMessage([turn('user', 'hi')], () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAN_TOOL_INPUT_PARSE_ERROR');
      expect(result.error.message).toContain('CreateGitHubIssue');
    }
  });

  it('IT-2518: streaming API_ERROR wraps SDK throw', async () => {
    sdkMocks.messagesCreate.mockRejectedValue(new Error('connection reset'));
    const client = new ClaudeClient(sampleCreds, { systemPrompt: 'test' });
    const result = await client.sendMessage([turn('user', 'hi')], () => {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PLAN_API_ERROR');
  });
});

// ─── parseAskUserQuestion / parseCreateGitHubIssue ────────────────────

describe('ClaudeClient parse helpers', () => {
  const client = new ClaudeClient(sampleCreds, { systemPrompt: 'test' });

  it('IT-2520: parseAskUserQuestion validates and shapes a UserInteraction', () => {
    const interaction = client.parseAskUserQuestion({
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(interaction.id).toBeTruthy();
    expect(interaction.type).toBe('question');
    expect(interaction.questions).toHaveLength(1);
    expect(interaction.questions[0]!.options).toHaveLength(2);
  });

  it('IT-2521: parseAskUserQuestion throws on invalid input shape', () => {
    expect(() => client.parseAskUserQuestion({ questions: 'not-array' })).toThrow();
  });

  it('IT-2522: parseCreateGitHubIssue extracts title/body/labels', () => {
    const issue = client.parseCreateGitHubIssue({
      title: 'Bug',
      body: 'desc',
      labels: ['bug', 'p0'],
    });
    expect(issue.title).toBe('Bug');
    expect(issue.body).toBe('desc');
    expect(issue.labels).toEqual(['bug', 'p0']);
  });

  it('IT-2523: parseCreateGitHubIssue tolerates omitted labels', () => {
    const issue = client.parseCreateGitHubIssue({ title: 't', body: 'b' });
    expect(issue.labels).toBeUndefined();
  });

  it('IT-2524: parseCreateGitHubIssue throws when title is missing', () => {
    expect(() => client.parseCreateGitHubIssue({ body: 'just body' })).toThrow();
  });
});
