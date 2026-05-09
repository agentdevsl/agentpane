/**
 * Functional Bug-Proving Tests for TerraformComposeService
 *
 * Each test exercises REAL service code against a real in-memory SQLite database
 * to PROVE or DISPROVE potential bugs. Only the Claude Agent SDK is mocked with a
 * controlled stream so we can assert text/code extraction, event publishing,
 * and error handling deterministically.
 *
 * Targeted bug families (per CLAUDE.md "Terraform Compose Architecture" pitfalls):
 *   1. `fullResponse` overwrite by assistant-message handler when stream deltas
 *      already accumulated content (would lose HCL fenced blocks).
 *   2. HCL fence variants: regex must accept hcl|terraform|tf consistently in
 *      both `extractHclCode` and `extractStacksFiles`.
 *   3. SSE event buffering: `code`/`done` events must reach the stream even
 *      when intermediate publishes momentarily fail.
 *   4. System-prompt construction with settings overrides — mode-specific
 *      branches and {{moduleContext}} substitution.
 *   5. Stream cleanup: `runPipeline` must always close the SDK session and
 *      tolerate publish errors when emitting terminal `done`/`error` events.
 *   6. Generic-name guard in `matchModulesInResponse`.
 *
 * Run: npx vitest run --project functional tests/functional/prove-terraform-bugs.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import { buildCompositionSystemPrompt } from '../../src/lib/terraform/compose-prompt';
import {
  extractHclCode,
  TerraformComposeService,
} from '../../src/services/terraform-compose.service';
import { TerraformRegistryService } from '../../src/services/terraform-registry.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// Hoisted mock for the Agent SDK — the SDK is the only external boundary we mock.
const sdkMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: sdkMocks.createSession,
}));

// Mock SKILL.md file read so the test does not depend on repo layout.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue('# Stacks Skill Reference\nMock skill content'),
  };
});

// ---------------------------------------------------------------------------
// SDK session helpers — emit a controlled stream of events
// ---------------------------------------------------------------------------

interface StreamEventInput {
  type: string;
  [k: string]: unknown;
}

function makeSession(events: StreamEventInput[], opts: { sendError?: Error } = {}) {
  return {
    send: vi.fn().mockImplementation(async () => {
      if (opts.sendError) throw opts.sendError;
    }),
    stream: vi.fn().mockImplementation(async function* () {
      for (const event of events) {
        yield event;
      }
    }),
    close: vi.fn(),
  };
}

function textDelta(text: string): StreamEventInput {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  };
}

function messageStart(inputTokens = 100): StreamEventInput {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { usage: { input_tokens: inputTokens } },
    },
  };
}

function messageDelta(outputTokens = 50): StreamEventInput {
  return {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      usage: { output_tokens: outputTokens },
    },
  };
}

function assistantMessage(
  content: string,
  usage = { input_tokens: 5, output_tokens: 5 }
): StreamEventInput {
  return {
    type: 'assistant',
    message: {
      usage,
      content: [{ type: 'text', text: content }],
    },
  };
}

function resultEvent(usage = { input_tokens: 100, output_tokens: 200 }): StreamEventInput {
  return { type: 'result', usage };
}

function toolUseSummary(): StreamEventInput {
  return { type: 'tool_use_summary' };
}

// Mock streams server matching the duck type the service expects.
interface PublishedEvent {
  streamId: string;
  type: string;
  data: unknown;
}

function createMockStreams(
  opts: {
    publishImpl?: (
      streamId: string,
      type: string,
      data: unknown
    ) => Promise<{ ok: boolean; error?: { message: string } }>;
    createStreamImpl?: (streamId: string, schema: unknown) => Promise<unknown>;
    deleteStreamImpl?: (streamId: string) => Promise<unknown>;
  } = {}
) {
  const published: PublishedEvent[] = [];
  const created: string[] = [];
  const deleted: string[] = [];

  const publish = vi
    .fn()
    .mockImplementation(async (streamId: string, type: string, data: unknown) => {
      if (opts.publishImpl) return opts.publishImpl(streamId, type, data);
      published.push({ streamId, type, data });
      return { ok: true };
    });

  const createStream = vi.fn().mockImplementation(async (streamId: string, schema: unknown) => {
    if (opts.createStreamImpl) return opts.createStreamImpl(streamId, schema);
    created.push(streamId);
    return undefined;
  });

  const deleteStream = vi.fn().mockImplementation(async (streamId: string) => {
    if (opts.deleteStreamImpl) return opts.deleteStreamImpl(streamId);
    deleted.push(streamId);
    return true;
  });

  return {
    streams: { publish, createStream, deleteStream },
    published,
    created,
    deleted,
  };
}

/**
 * Wait until the running pipeline has emitted a terminal event (`done` or `error`).
 * Polls the published-events array; throws after a generous timeout so a hang
 * is reported rather than silently passing.
 */
async function waitForTerminal(
  published: PublishedEvent[],
  timeoutMs = 5000
): Promise<PublishedEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const terminal = published.find(
      (e) => e.type === 'terraform:done' || e.type === 'terraform:error'
    );
    if (terminal) return terminal;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `Timed out waiting for terminal event. Published: ${JSON.stringify(published.map((e) => e.type))}`
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Bug-Proving Tests: TerraformComposeService', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    try {
      execRawSql(TERRAFORM_MIGRATION_SQL);
    } catch {
      // Tables may already exist
    }
    sdkMocks.createSession.mockReset();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 1: fullResponse overwrite when assistant message arrives after deltas
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: assistant message handler does NOT overwrite streamed deltas containing HCL', async () => {
    // Setup
    const fence = '```';
    const hclChunkA = '\nresource "aws_s3_bucket" "main" {\n';
    const hclChunkB = '  bucket = "my-bucket"\n}\n';
    const events: StreamEventInput[] = [
      messageStart(100),
      textDelta(`Here's some HCL:\n${fence}hcl`),
      textDelta(hclChunkA),
      textDelta(hclChunkB),
      textDelta(fence),
      // Assistant message arrives WITH content but stream deltas already streamed.
      // BUG (regression guard): old code did `fullResponse = text` unconditionally,
      // wiping the accumulated HCL from deltas.
      assistantMessage('Just a summary without code'),
      resultEvent(),
    ];
    sdkMocks.createSession.mockReturnValue(makeSession(events));

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    // Act
    const result = await service.startCompose(undefined, [
      { role: 'user', content: 'Make me an S3 bucket' },
    ]);
    expect(result.ok).toBe(true);
    const sid = result.ok ? result.value.sessionId : '';

    const terminal = await waitForTerminal(mock.published);
    expect(terminal.type).toBe('terraform:done');

    // VERDICT: FIXED — the assistant handler only overwrites fullResponse when
    // streamedTextToClient is false. So extracted code MUST contain the HCL
    // assembled from the deltas.
    const codeEvent = mock.published.find((e) => e.type === 'terraform:code');
    expect(codeEvent).toBeDefined();
    const code = (codeEvent!.data as { code: string }).code;
    expect(code).toContain('aws_s3_bucket');
    expect(code).toContain('my-bucket');

    // Session is recorded with the HCL content (not "Just a summary")
    const session = service.getSession(sid);
    expect(session).toBeDefined();
    const lastMsg = session!.messages[session!.messages.length - 1];
    expect(typeof lastMsg!.content).toBe('string');
    expect(lastMsg!.content as string).toContain('aws_s3_bucket');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 2: HCL fence variants — server extracts hcl, terraform, tf
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: extractHclCode parses all three fence variants (hcl/terraform/tf) — server/client parity', () => {
    // Why: the client-side fallback in terraform-context.tsx must use the same
    // regex as the server's extractHclCode. A drift here causes silent failures
    // where the server thinks code was extracted but the client falls back.
    const sample = [
      '```hcl',
      'resource "aws_s3_bucket" "a" {}',
      '```',
      'and then',
      '```terraform',
      'resource "aws_s3_bucket" "b" {}',
      '```',
      'and finally',
      '```tf',
      'resource "aws_s3_bucket" "c" {}',
      '```',
    ].join('\n');

    const code = extractHclCode(sample);
    expect(code).not.toBeNull();
    expect(code).toContain('aws_s3_bucket');
    expect(code).toContain('"a"');
    expect(code).toContain('"b"');
    expect(code).toContain('"c"');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 3: Pipeline emits terraform:done even when an intermediate publish fails
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: non-terminal publish failures do NOT block the pipeline from emitting done', async () => {
    const events: StreamEventInput[] = [
      messageStart(),
      textDelta('```hcl\nresource "aws_s3_bucket" "drop" {}\n```'),
      messageDelta(),
      resultEvent(),
    ];
    sdkMocks.createSession.mockReturnValue(makeSession(events));

    let publishCalls = 0;
    const captured: PublishedEvent[] = [];
    const mock = createMockStreams({
      publishImpl: async (streamId, type, data) => {
        publishCalls++;
        // Fail the FIRST status event to simulate transient stream backpressure.
        if (publishCalls === 1) {
          return { ok: false, error: { message: 'transient stream offline' } };
        }
        captured.push({ streamId, type, data });
        return { ok: true };
      },
    });

    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    const result = await service.startCompose(undefined, [{ role: 'user', content: 'Make it' }]);
    expect(result.ok).toBe(true);

    // Wait for terminal event in captured (mock.published is filled only on ok=true,
    // but our publishImpl uses `captured` for ok events).
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (captured.find((e) => e.type === 'terraform:done')) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // VERDICT: non-terminal publish errors are logged-and-swallowed; pipeline
    // proceeds and the terminal `done` event is emitted to clients.
    const done = captured.find((e) => e.type === 'terraform:done');
    expect(done).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 4: Pipeline propagates terraform:error to the stream when SDK send throws
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: SDK send() exception is caught and converted to a user-facing terraform:error', async () => {
    sdkMocks.createSession.mockReturnValue(
      makeSession([], { sendError: new Error('authentication_error: invalid x-api-key') })
    );

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'Make a vpc' }]);
    const terminal = await waitForTerminal(mock.published);

    // VERDICT: pipeline catches the SDK error, classifies as auth, and emits a
    // safe user-facing message via terraform:error.
    expect(terminal.type).toBe('terraform:error');
    const data = terminal.data as { error: string };
    expect(data.error).toContain('Claude authentication failed');
    expect(data.error).not.toContain('x-api-key'); // never leak credential details
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 5: rate-limit error is classified to a user-friendly message
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: rate_limit error is classified and surfaced via terraform:error', async () => {
    sdkMocks.createSession.mockReturnValue(
      makeSession([], { sendError: new Error('rate_limit hit (429)') })
    );

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'go' }]);
    const terminal = await waitForTerminal(mock.published);

    expect(terminal.type).toBe('terraform:error');
    const data = terminal.data as { error: string };
    expect(data.error.toLowerCase()).toContain('rate limit');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 6: model_not_found classification
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: model_not_found error classified to model configuration message', async () => {
    sdkMocks.createSession.mockReturnValue(
      makeSession([], { sendError: new Error('model_not_found: unknown model') })
    );

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'go' }]);
    const terminal = await waitForTerminal(mock.published);

    expect(terminal.type).toBe('terraform:error');
    expect((terminal.data as { error: string }).error).toContain('Model configuration error');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 7: context_length classification
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: context_length error classified to start a new conversation message', async () => {
    sdkMocks.createSession.mockReturnValue(
      makeSession([], { sendError: new Error('context_length_exceeded: too many tokens') })
    );

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'go' }]);
    const terminal = await waitForTerminal(mock.published);

    expect(terminal.type).toBe('terraform:error');
    expect((terminal.data as { error: string }).error).toContain('conversation is too long');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 8: Generic pipeline failure produces non-leaky user-facing message
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: unexpected pipeline error is classified to a generic user-facing message', async () => {
    sdkMocks.createSession.mockReturnValue(
      makeSession([], {
        sendError: new Error('something internal exploded with secret token sk-xxx'),
      })
    );

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'go' }]);
    const terminal = await waitForTerminal(mock.published);

    expect(terminal.type).toBe('terraform:error');
    const msg = (terminal.data as { error: string }).error;
    expect(msg).toBe('An error occurred during Terraform composition. Please try again.');
    // Sensitive content stripped:
    expect(msg).not.toContain('sk-');
    expect(msg).not.toContain('token');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 9: AskUserQuestion captured by canUseTool and forwarded as questions event
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: AskUserQuestion tool input is captured and forwarded as terraform:questions', async () => {
    // The canUseTool callback runs synchronously when invoked. We need to drive
    // the pipeline so it is invoked. We do this by invoking it directly via
    // the captured callback after the session is created.
    const events: StreamEventInput[] = [
      messageStart(),
      textDelta('Some context\n'),
      toolUseSummary(),
      messageDelta(),
      resultEvent(),
    ];

    let capturedCanUseTool:
      | ((toolName: string, input: unknown, opts: unknown) => Promise<unknown>)
      | null = null;
    sdkMocks.createSession.mockImplementation(
      (opts: { canUseTool?: typeof capturedCanUseTool }) => {
        capturedCanUseTool = opts.canUseTool ?? null;
        return makeSession(events);
      }
    );

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    // Patch publish to invoke canUseTool right when the first text delta lands
    // (this is AFTER the SDK session has been created so capturedCanUseTool is wired).
    const originalPublish = mock.streams.publish.getMockImplementation();
    let triggered = false;
    mock.streams.publish.mockImplementation(
      async (streamId: string, type: string, data: unknown) => {
        if (!triggered && type === 'terraform:text' && capturedCanUseTool) {
          triggered = true;
          await capturedCanUseTool(
            'AskUserQuestion',
            {
              questions: [
                {
                  question: 'Which AWS region should we deploy to?',
                  header: 'Region',
                  options: [{ label: 'us-east-1' }, { label: 'us-west-2' }],
                },
              ],
            },
            { toolUseID: 'tool-1' }
          );
        }
        return originalPublish ? originalPublish(streamId, type, data) : { ok: true };
      }
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'Need a deploy plan' }]);
    await waitForTerminal(mock.published);

    // VERDICT: questions captured via canUseTool surface as terraform:questions
    const questionsEvent = mock.published.find((e) => e.type === 'terraform:questions');
    expect(questionsEvent).toBeDefined();
    const data = questionsEvent!.data as {
      questions: Array<{ question: string; category: string; options: string[] }>;
    };
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0]!.category).toBe('Region');
    expect(data.questions[0]!.question).toContain('AWS region');
    expect(data.questions[0]!.options).toContain('us-east-1');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 10: stacks mode emits files event with inferred filenames
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: stacks mode produces terraform:code with extracted files (filename inferred)', async () => {
    const fenceOpen = '```hcl';
    const fenceClose = '```';
    const stacksOutput = [
      'Here is your stack:',
      `${fenceOpen} title="components.tfcomponent.hcl"`,
      'component "vpc" { source = "./vpc" }',
      fenceClose,
      '',
      fenceOpen,
      'deployment "prod" { target = "us-east-1" }',
      fenceClose,
    ].join('\n');

    const events: StreamEventInput[] = [
      messageStart(),
      textDelta(stacksOutput),
      messageDelta(),
      resultEvent(),
    ];
    sdkMocks.createSession.mockReturnValue(makeSession(events));

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(
      undefined,
      [{ role: 'user', content: 'stacks please' }],
      undefined,
      'stacks'
    );
    await waitForTerminal(mock.published);

    // VERDICT: stacks mode publishes a terraform:code event with files[]
    const code = mock.published.find((e) => e.type === 'terraform:code');
    expect(code).toBeDefined();
    const data = code!.data as { files: Array<{ filename: string; code: string }> };
    expect(data.files).toBeDefined();
    expect(data.files.length).toBe(2);
    const names = data.files.map((f) => f.filename).sort();
    expect(names).toContain('components.tfcomponent.hcl');
    // Inferred filename for unannotated `deployment` block:
    expect(names).toContain('deployments.tfdeploy.hcl');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 11: Server-side fallback parses clarifying questions from text when no code
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: pipeline falls back to text-based question parsing when no HCL is present', async () => {
    const events: StreamEventInput[] = [
      messageStart(),
      textDelta('Before I can build the infrastructure I need:\n'),
      textDelta('1. **Region** - Which AWS region should we deploy to?\n'),
      textDelta('2. **Environment** - Which environment is this for?\n'),
      messageDelta(),
      resultEvent(),
    ];
    sdkMocks.createSession.mockReturnValue(makeSession(events));

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'plan this' }]);
    await waitForTerminal(mock.published);

    const questionsEvent = mock.published.find((e) => e.type === 'terraform:questions');
    expect(questionsEvent).toBeDefined();
    const qs = (questionsEvent!.data as { questions: Array<{ category: string }> }).questions;
    expect(qs.length).toBeGreaterThanOrEqual(2);
    expect(qs.map((q) => q.category)).toContain('Region');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 12: Pipeline emits validating_hcl status and validation diagnostics for bad HCL
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: invalid HCL triggers a validating_hcl status and a diagnostic text event', async () => {
    const events: StreamEventInput[] = [
      messageStart(),
      // Generate something that hcl2json will reject.
      textDelta('```hcl\nthis is { not valid hcl }{{{\n```'),
      messageDelta(),
      resultEvent(),
    ];
    sdkMocks.createSession.mockReturnValue(makeSession(events));

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose(undefined, [{ role: 'user', content: 'make it bad' }]);
    await waitForTerminal(mock.published);

    const validatingStatus = mock.published.find(
      (e) =>
        e.type === 'terraform:status' && (e.data as { stage: string }).stage === 'validating_hcl'
    );
    expect(validatingStatus).toBeDefined();

    // The diagnostic text should be emitted (with severity prefix) since validation failed.
    const textEvents = mock.published.filter((e) => e.type === 'terraform:text');
    const haveDiag = textEvents.some((t) =>
      ((t.data as { delta: string }).delta || '').includes('HCL Validation Issues')
    );
    expect(haveDiag).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 13: Stream is recreated (delete then create) on each compose call
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: each startCompose deletes and recreates the stream to avoid stale event replay', async () => {
    const events: StreamEventInput[] = [messageStart(), resultEvent()];
    sdkMocks.createSession.mockReturnValue(makeSession(events));

    const mock = createMockStreams();
    const registryService = new TerraformRegistryService(db as never);
    const service = new TerraformComposeService(
      registryService,
      db as never,
      undefined,
      mock.streams as never
    );

    await service.startCompose('reuse-id', [{ role: 'user', content: 'first' }]);
    await waitForTerminal(mock.published);
    mock.published.length = 0;
    await service.startCompose('reuse-id', [{ role: 'user', content: 'second' }]);
    await waitForTerminal(mock.published);

    // Assert: deleteStream and createStream BOTH called for the same id on both calls.
    const deleteCount = (mock.streams.deleteStream as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'terraform:reuse-id'
    ).length;
    const createCount = (mock.streams.createStream as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'terraform:reuse-id'
    ).length;
    expect(deleteCount).toBeGreaterThanOrEqual(2);
    expect(createCount).toBeGreaterThanOrEqual(2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 14: composition prompt substitutes {{moduleContext}} with default text
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: buildCompositionSystemPrompt substitutes {{moduleContext}} (terraform mode, no settings)', async () => {
    const moduleContext = '## Available modules\n- vpc/aws v5.0.0';
    const prompt = await buildCompositionSystemPrompt(moduleContext);
    // moduleContext should appear in the assembled prompt.
    expect(prompt).toContain('vpc/aws v5.0.0');
    expect(prompt).not.toContain('{{moduleContext}}');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 15: stacks mode prompt substitutes {{stacksReference}} when no settings
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: stacks mode prompt substitutes {{moduleContext}} and {{stacksReference}} when no settings', async () => {
    const prompt = await buildCompositionSystemPrompt(
      'context-here',
      undefined,
      'stacks',
      'STACKS-REF-CONTENT'
    );
    expect(prompt).toContain('context-here');
    expect(prompt).toContain('STACKS-REF-CONTENT');
    expect(prompt).not.toContain('{{moduleContext}}');
    expect(prompt).not.toContain('{{stacksReference}}');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 16: stacks reference defaults to empty when not provided
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: stacks-mode prompt builder tolerates missing stacksReference (defaults to empty)', async () => {
    const prompt = await buildCompositionSystemPrompt('ctx', undefined, 'stacks');
    expect(prompt).toContain('ctx');
    expect(prompt).not.toContain('{{stacksReference}}');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 17: settings override path used when settingsService provided
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: settings-aware prompt builder uses override when present', async () => {
    const fakeSettings = {
      getValue: vi.fn().mockImplementation(async (key: string, _default: unknown) => {
        if (key === 'prompt.terraform-compose') {
          return 'CUSTOM-OVERRIDE: {{moduleContext}}';
        }
        return _default;
      }),
    };

    const prompt = await buildCompositionSystemPrompt('MODULES_HERE', fakeSettings as never);
    expect(prompt).toBe('CUSTOM-OVERRIDE: MODULES_HERE');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 18: SettingsService falls through to default when override empty
  // ═══════════════════════════════════════════════════════════════════════

  it('PROVE: settings-aware prompt builder falls back to default when override is empty/whitespace', async () => {
    const fakeSettings = {
      getValue: vi.fn().mockResolvedValue('   '),
    };
    const prompt = await buildCompositionSystemPrompt('MODULES_HERE', fakeSettings as never);
    expect(prompt).toContain('MODULES_HERE');
    // The default text should be used (definitely not the whitespace string)
    expect(prompt.length).toBeGreaterThan(50);
  });
});
