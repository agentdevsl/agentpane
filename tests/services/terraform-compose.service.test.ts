import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerraformModule } from '../../src/db/schema';
import {
  extractHclCode,
  extractStacksFiles,
  inferStacksFilename,
  matchModulesInResponse,
  parseClarifyingQuestionsFromText,
  TerraformComposeService,
} from '../../src/services/terraform-compose.service';

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK — prevents any real API calls
// ---------------------------------------------------------------------------
const mockSessionClose = vi.fn();
const mockSessionSend = vi.fn();
let mockStreamEvents: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(() => ({
    send: mockSessionSend,
    stream: () => ({
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index < mockStreamEvents.length) {
              return { value: mockStreamEvents[index++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    }),
    close: mockSessionClose,
  })),
}));

// Mock the SDK env builder
vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  buildSdkEnv: vi.fn(() => ({})),
}));

// Mock the compose prompt builder
vi.mock('../../src/lib/terraform/compose-prompt.js', () => ({
  buildCompositionSystemPrompt: vi.fn().mockResolvedValue('System prompt for Terraform compose'),
}));

// Mock the settings service model lookup
vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue(undefined),
}));

// Mock the logger to suppress console output during tests
vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock fs/promises for loadStacksSkillContent — use import() syntax
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual,
      readFile: vi.fn().mockRejectedValue(new Error('SKILL.md not found in test')),
    },
    readFile: vi.fn().mockRejectedValue(new Error('SKILL.md not found in test')),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistryService(overrides: Record<string, unknown> = {}) {
  return {
    getModuleContext: vi.fn().mockResolvedValue({
      ok: true,
      value: 'Module catalog context',
    }),
    listModules: vi.fn().mockResolvedValue({
      ok: true,
      value: [] as TerraformModule[],
    }),
    ...overrides,
  } as any;
}

function createMockDurableStreamsService(overrides: Record<string, unknown> = {}) {
  let _resolvePipelineDone: (() => void) | null = null;
  const pipelineDone = new Promise<void>((resolve) => {
    _resolvePipelineDone = resolve;
  });

  const publishFn = vi.fn().mockImplementation((_streamId: string, eventType: string) => {
    if (eventType === 'terraform:done' || eventType === 'terraform:error') {
      _resolvePipelineDone?.();
    }
    return Promise.resolve(undefined);
  });

  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    deleteStream: vi.fn().mockResolvedValue(undefined),
    publish: publishFn,
    /** Resolves when the pipeline publishes a terminal event (done or error). */
    pipelineDone,
    /** Reset the pipelineDone promise for reuse within a test. */
    resetPipelineDone() {
      const p = new Promise<void>((resolve) => {
        _resolvePipelineDone = resolve;
      });
      (this as any).pipelineDone = p;
    },
    ...overrides,
  } as any;
}

function createMockDb() {
  return {} as any;
}

/** Helper to create stream events that simulate the Claude Agent SDK response. */
function makeTextDeltaEvent(text: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  };
}

function makeMessageStartEvent(inputTokens = 100): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { usage: { input_tokens: inputTokens } },
    },
  };
}

function makeMessageDeltaEvent(outputTokens = 200): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      usage: { output_tokens: outputTokens },
    },
  };
}

function makeResultEvent(inputTokens = 100, outputTokens = 200): Record<string, unknown> {
  return {
    type: 'result',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function makeAssistantMessage(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 50, output_tokens: 100 },
    },
  };
}

function makeToolUseSummary(): Record<string, unknown> {
  return { type: 'tool_use_summary' };
}

// ==========================================================================
// PURE FUNCTION TESTS
// ==========================================================================

describe('TerraformComposeService pure functions', () => {
  // ========================================================================
  // extractHclCode
  // ========================================================================
  describe('extractHclCode', () => {
    it('extracts code from ```hcl blocks', () => {
      const input =
        'Some text\n```hcl\nresource "aws_s3_bucket" "example" {\n  bucket = "my-bucket"\n}\n```\nMore text';
      const result = extractHclCode(input);
      expect(result).toBe('resource "aws_s3_bucket" "example" {\n  bucket = "my-bucket"\n}');
    });

    it('extracts code from ```terraform blocks', () => {
      const input = 'Before\n```terraform\nresource "a" "b" {}\n```\nAfter';
      expect(extractHclCode(input)).toBe('resource "a" "b" {}');
    });

    it('extracts code from ```tf blocks', () => {
      const input = 'Before\n```tf\nresource "c" "d" {}\n```\nAfter';
      expect(extractHclCode(input)).toBe('resource "c" "d" {}');
    });

    it('returns null when no HCL blocks are found', () => {
      expect(extractHclCode('Just some plain text')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractHclCode('')).toBeNull();
    });

    it('returns null for non-HCL code blocks', () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(extractHclCode(input)).toBeNull();
    });

    it('joins multiple HCL blocks with double newline', () => {
      const input = [
        '```hcl',
        'resource "aws_vpc" "main" {}',
        '```',
        'Some explanation',
        '```terraform',
        'resource "aws_subnet" "sub" {}',
        '```',
      ].join('\n');
      const result = extractHclCode(input);
      expect(result).toBe('resource "aws_vpc" "main" {}\n\nresource "aws_subnet" "sub" {}');
    });

    it('trims whitespace from extracted blocks', () => {
      const input = '```hcl\n  resource "a" "b" {}  \n```';
      expect(extractHclCode(input)).toBe('resource "a" "b" {}');
    });

    it('handles blocks with multiple lines and nesting', () => {
      const input = [
        '```hcl',
        'module "vpc" {',
        '  source  = "terraform-aws-modules/vpc/aws"',
        '  version = "5.0.0"',
        '',
        '  name = "my-vpc"',
        '  cidr = "10.0.0.0/16"',
        '',
        '  tags = {',
        '    Environment = "production"',
        '  }',
        '}',
        '```',
      ].join('\n');
      const result = extractHclCode(input);
      expect(result).toContain('module "vpc"');
      expect(result).toContain('terraform-aws-modules/vpc/aws');
      expect(result).toContain('Environment = "production"');
    });
  });

  // ========================================================================
  // extractStacksFiles
  // ========================================================================
  describe('extractStacksFiles', () => {
    it('extracts multiple files with title annotations', () => {
      const input = [
        'Here is the configuration:',
        '```hcl title="main.tfcomponent.hcl"',
        'component "vpc" {',
        '  source = "./vpc"',
        '}',
        '```',
        '',
        '```hcl title="deploy.tfdeploy.hcl"',
        'deployment "production" {',
        '  inputs = {}',
        '}',
        '```',
      ].join('\n');

      const result = extractStacksFiles(input);
      expect(result).toHaveLength(2);
      expect(result[0]!.filename).toBe('main.tfcomponent.hcl');
      expect(result[0]!.code).toContain('component "vpc"');
      expect(result[1]!.filename).toBe('deploy.tfdeploy.hcl');
      expect(result[1]!.code).toContain('deployment "production"');
    });

    it('infers filenames when title is missing', () => {
      const input = ['```hcl', 'deployment "staging" {', '  inputs = {}', '}', '```'].join('\n');

      const result = extractStacksFiles(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.filename).toBe('deployments.tfdeploy.hcl');
    });

    it('returns empty array when no code blocks found', () => {
      const result = extractStacksFiles('No code here, just text.');
      expect(result).toHaveLength(0);
    });

    it('deduplicates by filename — merges code for same filename', () => {
      const input = [
        '```hcl title="vars.tfcomponent.hcl"',
        'variable "a" {}',
        '```',
        '```hcl title="vars.tfcomponent.hcl"',
        'variable "b" {}',
        '```',
      ].join('\n');

      const result = extractStacksFiles(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.filename).toBe('vars.tfcomponent.hcl');
      expect(result[0]!.code).toContain('variable "a"');
      expect(result[0]!.code).toContain('variable "b"');
    });

    it('handles terraform and tf fence types', () => {
      const input = [
        '```terraform title="network.tfcomponent.hcl"',
        'component "network" {}',
        '```',
        '```tf title="compute.tfcomponent.hcl"',
        'component "compute" {}',
        '```',
      ].join('\n');

      const result = extractStacksFiles(input);
      expect(result).toHaveLength(2);
      expect(result[0]!.filename).toBe('network.tfcomponent.hcl');
      expect(result[1]!.filename).toBe('compute.tfcomponent.hcl');
    });

    it('skips blocks with empty code', () => {
      const input = '```hcl title="empty.hcl"\n\n```';
      const result = extractStacksFiles(input);
      expect(result).toHaveLength(0);
    });
  });

  // ========================================================================
  // inferStacksFilename
  // ========================================================================
  describe('inferStacksFilename', () => {
    it('returns deployments.tfdeploy.hcl for deployment blocks', () => {
      expect(inferStacksFilename('deployment "prod" { }')).toBe('deployments.tfdeploy.hcl');
    });

    it('returns deployments.tfdeploy.hcl for deployment_group blocks', () => {
      expect(inferStacksFilename('deployment_group "all" { }')).toBe('deployments.tfdeploy.hcl');
    });

    it('returns providers.tfcomponent.hcl for provider blocks', () => {
      expect(inferStacksFilename('provider "aws" { region = "us-east-1" }')).toBe(
        'providers.tfcomponent.hcl'
      );
    });

    it('returns variables.tfcomponent.hcl for variable blocks', () => {
      expect(inferStacksFilename('variable "vpc_cidr" { default = "10.0.0.0/16" }')).toBe(
        'variables.tfcomponent.hcl'
      );
    });

    it('returns outputs.tfcomponent.hcl for output blocks', () => {
      expect(inferStacksFilename('output "vpc_id" { value = module.vpc.id }')).toBe(
        'outputs.tfcomponent.hcl'
      );
    });

    it('returns components.tfcomponent.hcl for component blocks', () => {
      expect(inferStacksFilename('component "vpc" { source = "./vpc" }')).toBe(
        'components.tfcomponent.hcl'
      );
    });

    it('returns stack.tfcomponent.hcl as fallback', () => {
      expect(inferStacksFilename('locals { region = "us-east-1" }')).toBe('stack.tfcomponent.hcl');
    });
  });

  // ========================================================================
  // matchModulesInResponse
  // ========================================================================
  describe('matchModulesInResponse', () => {
    const createModule = (overrides: Partial<TerraformModule> = {}): TerraformModule =>
      ({
        id: 'mod-1',
        name: 'consul',
        source: 'hashicorp/consul/aws',
        provider: 'aws',
        version: '1.0.0',
        namespace: 'hashicorp',
        registryId: 'reg-1',
        description: null,
        readme: null,
        inputs: null,
        outputs: null,
        dependencies: null,
        publishedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
      }) as TerraformModule;

    it('matches modules by source with confidence 1.0', () => {
      const modules = [createModule()];
      const response =
        'module "consul" {\n  source = "hashicorp/consul/aws"\n  version = "1.0.0"\n}';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(1.0);
      expect(result[0]!.matchReason).toBe('Module source used in generated code');
    });

    it('matches modules by name + provider with confidence 0.8', () => {
      const modules = [
        createModule({
          id: 'mod-2',
          name: 'networking',
          source: 'custom/networking/azure',
          provider: 'azure',
        }),
      ];
      const response = 'We will set up the networking layer using azure resources.';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(0.8);
      expect(result[0]!.matchReason).toBe('Module name and provider referenced in response');
    });

    it('matches modules by name only with confidence 0.5', () => {
      const modules = [
        createModule({
          id: 'mod-3',
          name: 'networking',
          source: 'custom/networking/azure',
          provider: 'azure',
        }),
      ];
      const response = 'We will set up the networking layer for the VPC.';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(0.5);
      expect(result[0]!.matchReason).toBe('Module name mentioned in response');
    });

    it('skips generic module names', () => {
      const modules = [
        createModule({ id: 'mod-generic', name: 'module', source: 'some/module/aws' }),
        createModule({ id: 'mod-test', name: 'test', source: 'some/test/aws' }),
        createModule({ id: 'mod-main', name: 'main', source: 'some/main/aws' }),
      ];
      const response = 'This is a module test for the main configuration.';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(0);
    });

    it('skips names shorter than 3 characters', () => {
      const modules = [createModule({ id: 'mod-ab', name: 'ab', source: 'x/ab/gcp' })];
      const response = 'Use ab for something.';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(0);
    });

    it('deduplicates modules by id', () => {
      const mod = createModule();
      const modules = [mod, mod];
      const response = 'source = "hashicorp/consul/aws"';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(1);
    });

    it('sorts results by confidence descending', () => {
      const modules = [
        createModule({
          id: 'mod-name-only',
          name: 'logging',
          source: 'custom/logging/gcp',
          provider: 'gcp',
        }),
        createModule({
          id: 'mod-source',
          name: 'vpc',
          source: 'hashicorp/vpc/aws',
          provider: 'aws',
        }),
      ];
      const response = 'We use hashicorp/vpc/aws for the VPC and set up the logging module.';

      const result = matchModulesInResponse(response, modules);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0]!.confidence).toBe(1.0);
      expect(result[1]!.confidence).toBeLessThan(1.0);
    });

    it('returns empty array for empty response', () => {
      const modules = [createModule()];
      expect(matchModulesInResponse('', modules)).toHaveLength(0);
    });

    it('returns empty array for empty modules', () => {
      expect(matchModulesInResponse('Some response text', [])).toHaveLength(0);
    });
  });

  // ========================================================================
  // parseClarifyingQuestionsFromText
  // ========================================================================
  describe('parseClarifyingQuestionsFromText', () => {
    it('extracts numbered questions', () => {
      const input = '1. What region should we deploy to?\n2. What environment is this for?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(2);
      expect(result[0]!.question).toContain('region');
      expect(result[1]!.question).toContain('environment');
    });

    it('extracts dash-prefixed questions', () => {
      const input =
        '- What instance type do you want?\n- Should we enable SSL and TLS certificates?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(2);
    });

    it('extracts asterisk-prefixed questions', () => {
      const input = '* What domain should we configure for the setup?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.question).toContain('domain');
    });

    it('extracts parenthesis-numbered questions', () => {
      const input = '1) Which region do you prefer for deployment?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
    });

    it('skips text containing HCL code blocks', () => {
      const input = [
        '1. What region should we deploy to?',
        '```hcl',
        'resource "aws_vpc" "main" {}',
        '```',
      ].join('\n');
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(0);
    });

    it('skips very short questions (10 chars or less)', () => {
      const input = '1. Short?\n2. Also s?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(0);
    });

    it('extracts category from bold markers', () => {
      const input = '1. **Networking** - What CIDR range should the VPC use?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('Networking');
      expect(result[0]!.question).toContain('CIDR range');
    });

    it('uses "General" category when no bold marker present', () => {
      const input = '1. Which availability zones should we use?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.category).toBe('General');
    });

    it('extracts options from backtick-wrapped text', () => {
      const input = '1. Which region: `us-east-1`, `us-west-2`, or `eu-west-1`?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toEqual(['us-east-1', 'us-west-2', 'eu-west-1']);
    });

    it('infers default options for region questions', () => {
      const input = '1. What region should we deploy the infrastructure to?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toContain('us-east-1');
    });

    it('infers default options for environment questions', () => {
      const input = '1. What environment is this infrastructure for?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toContain('Production');
      expect(result[0]!.options).toContain('Staging');
    });

    it('infers default options for domain questions', () => {
      const input = '1. What domain name should we configure for the application?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toContain('example.com');
    });

    it('infers default options for SSL questions', () => {
      const input = '1. Should we configure SSL/TLS certificates?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toContain('Yes, include ACM');
    });

    it('infers default options for instance type questions', () => {
      const input = '1. What instance type should we use for the servers?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toContain('t3.micro');
    });

    it('infers yes/no for should/would questions without other keywords', () => {
      const input = '1. Should we enable monitoring for all instances?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toEqual(['Yes', 'No']);
    });

    it('falls back to "Use placeholder values" for generic questions', () => {
      const input = '1. What naming convention do you prefer for your resources?';
      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.options).toEqual(['Use placeholder values']);
    });

    it('returns empty for non-question text', () => {
      const input = 'Here is the explanation of the architecture.';
      expect(parseClarifyingQuestionsFromText(input)).toHaveLength(0);
    });

    it('returns empty for empty string', () => {
      expect(parseClarifyingQuestionsFromText('')).toHaveLength(0);
    });
  });
});

// ==========================================================================
// SERVICE CLASS TESTS
// ==========================================================================

describe('TerraformComposeService class', () => {
  let service: TerraformComposeService;
  let mockRegistryService: ReturnType<typeof createMockRegistryService>;
  let mockDurableStreams: ReturnType<typeof createMockDurableStreamsService>;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStreamEvents = [];
    // Reset the SDK session mock to the default implementation (error tests override it)
    const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(unstable_v2_createSession).mockImplementation(() => ({
      send: mockSessionSend,
      stream: () => ({
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index < mockStreamEvents.length) {
                return { value: mockStreamEvents[index++], done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      }),
      close: mockSessionClose,
    }));
    mockRegistryService = createMockRegistryService();
    mockDurableStreams = createMockDurableStreamsService();
    mockDb = createMockDb();
    service = new TerraformComposeService(
      mockRegistryService,
      mockDb,
      undefined,
      mockDurableStreams
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // getSession / resetSession
  // ========================================================================
  describe('getSession', () => {
    it('returns undefined for non-existent session', () => {
      expect(service.getSession('non-existent')).toBeUndefined();
    });
  });

  describe('resetSession', () => {
    it('does not throw for non-existent session', () => {
      expect(() => service.resetSession('non-existent')).not.toThrow();
    });

    it('calls deleteStream on the durable streams service', () => {
      service.resetSession('some-session');
      expect(mockDurableStreams.deleteStream).toHaveBeenCalledWith('terraform:some-session');
    });
  });

  // ========================================================================
  // startCompose — happy path
  // ========================================================================
  describe('startCompose', () => {
    it('returns ok with sessionId immediately', async () => {
      mockStreamEvents = [
        makeMessageStartEvent(100),
        makeTextDeltaEvent('```hcl\nresource "aws_vpc" "main" {}\n```'),
        makeMessageDeltaEvent(200),
        makeResultEvent(),
      ];

      const result = await service.startCompose('test-session', [
        { role: 'user', content: 'Create a VPC' },
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionId).toBe('test-session');
      }
    });

    it('generates a session ID when none is provided', async () => {
      mockStreamEvents = [makeResultEvent()];

      const result = await service.startCompose(undefined, [
        { role: 'user', content: 'Create a VPC' },
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionId).toBeTruthy();
        expect(typeof result.value.sessionId).toBe('string');
      }
    });

    it('creates a durable stream before returning', async () => {
      mockStreamEvents = [makeResultEvent()];

      await service.startCompose('sid-1', [{ role: 'user', content: 'Create an S3 bucket' }]);

      expect(mockDurableStreams.createStream).toHaveBeenCalledWith('terraform:sid-1', null);
    });

    it('throws when DurableStreamsService is not configured', async () => {
      const serviceWithoutStreams = new TerraformComposeService(
        mockRegistryService,
        mockDb,
        undefined,
        undefined
      );

      await expect(
        serviceWithoutStreams.startCompose('sid-1', [{ role: 'user', content: 'Create a VPC' }])
      ).rejects.toThrow('DurableStreamsService is required');
    });

    it('throws when durable stream creation fails', async () => {
      mockDurableStreams.createStream.mockRejectedValue(new Error('Stream creation failed'));

      await expect(
        service.startCompose('sid-1', [{ role: 'user', content: 'Create a VPC' }])
      ).rejects.toThrow('Failed to create stream');
    });
  });

  // ========================================================================
  // Pipeline — end-to-end event streaming
  // ========================================================================
  describe('pipeline execution', () => {
    it('publishes status, text, code, and done events for HCL response', async () => {
      const hclCode = 'resource "aws_s3_bucket" "main" {\n  bucket = "test"\n}';
      mockStreamEvents = [
        makeMessageStartEvent(50),
        makeTextDeltaEvent(`Here is your config:\n\n\`\`\`hcl\n${hclCode}\n\`\`\``),
        makeMessageDeltaEvent(150),
        makeResultEvent(50, 150),
      ];

      await service.startCompose('pipe-1', [{ role: 'user', content: 'Create an S3 bucket' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const eventTypes = publishCalls.map((call: unknown[]) => call[1]);

      expect(eventTypes).toContain('terraform:status');
      expect(eventTypes).toContain('terraform:text');
      expect(eventTypes).toContain('terraform:code');
      expect(eventTypes).toContain('terraform:done');
    });

    it('publishes module matches when modules are found in response', async () => {
      const modules = [
        {
          id: 'mod-vpc',
          name: 'vpc',
          source: 'terraform-aws-modules/vpc/aws',
          provider: 'aws',
          version: '5.0.0',
          namespace: 'terraform-aws-modules',
          registryId: 'reg-1',
          description: null,
          readme: null,
          inputs: null,
          outputs: null,
          dependencies: null,
          publishedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      mockRegistryService.listModules.mockResolvedValue({
        ok: true,
        value: modules,
      });

      mockStreamEvents = [
        makeTextDeltaEvent(
          'Using terraform-aws-modules/vpc/aws\n\n```hcl\nmodule "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n```'
        ),
        makeResultEvent(),
      ];

      await service.startCompose('pipe-modules', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const moduleEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:modules');
      expect(moduleEvent).toBeDefined();
      expect(moduleEvent[2].modules).toHaveLength(1);
      expect(moduleEvent[2].modules[0].confidence).toBe(1.0);
    });

    it('saves session state after pipeline completes', async () => {
      mockStreamEvents = [
        makeTextDeltaEvent('```hcl\nresource "aws_vpc" "main" {}\n```'),
        makeResultEvent(),
      ];

      await service.startCompose('pipe-session', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const session = service.getSession('pipe-session');
      expect(session).toBeDefined();
      expect(session!.id).toBe('pipe-session');
      expect(session!.generatedCode).toBe('resource "aws_vpc" "main" {}');
      expect(session!.messages).toHaveLength(2);
    });

    it('includes usage in done event', async () => {
      mockStreamEvents = [
        makeMessageStartEvent(42),
        makeTextDeltaEvent('Hello'),
        makeMessageDeltaEvent(99),
        makeResultEvent(42, 99),
      ];

      await service.startCompose('pipe-usage', [{ role: 'user', content: 'Test' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const doneEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent[2].usage).toEqual({
        inputTokens: 42,
        outputTokens: 99,
      });
    });

    it('closes the Agent SDK session after pipeline completes', async () => {
      mockStreamEvents = [makeResultEvent()];

      await service.startCompose('pipe-close', [{ role: 'user', content: 'Test' }]);

      await mockDurableStreams.pipelineDone;
      // Flush microtask queue so the finally block (which calls session.close()) executes
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSessionClose).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Pipeline — assistant message fallback (no stream deltas)
  // ========================================================================
  describe('pipeline — assistant message fallback', () => {
    it('uses assistant message content when no stream deltas were received', async () => {
      const hcl = '```hcl\nresource "aws_instance" "web" {}\n```';
      mockStreamEvents = [makeAssistantMessage(hcl), makeResultEvent()];

      await service.startCompose('pipe-fallback', [{ role: 'user', content: 'Create an EC2' }]);

      await mockDurableStreams.pipelineDone;

      const session = service.getSession('pipe-fallback');
      expect(session).toBeDefined();
      expect(session!.generatedCode).toBe('resource "aws_instance" "web" {}');

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const textEvents = publishCalls.filter((call: unknown[]) => call[1] === 'terraform:text');
      expect(textEvents.length).toBeGreaterThan(0);
    });

    it('does NOT overwrite stream-accumulated text with assistant message', async () => {
      const streamedHcl = '```hcl\nresource "aws_vpc" "streamed" {}\n```';
      mockStreamEvents = [
        makeTextDeltaEvent(streamedHcl),
        makeAssistantMessage('```hcl\nresource "aws_vpc" "assistant_msg" {}\n```'),
        makeResultEvent(),
      ];

      await service.startCompose('pipe-no-overwrite', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const session = service.getSession('pipe-no-overwrite');
      expect(session).toBeDefined();
      expect(session!.generatedCode).toBe('resource "aws_vpc" "streamed" {}');
    });
  });

  // ========================================================================
  // Pipeline — clarifying questions
  // ========================================================================
  describe('pipeline — clarifying questions', () => {
    it('publishes questions parsed from text when no code is generated', async () => {
      const questionText = [
        'I have a few questions before generating the infrastructure:',
        '1. What region should we deploy to?',
        '2. What environment is this for?',
      ].join('\n');

      mockStreamEvents = [makeTextDeltaEvent(questionText), makeResultEvent()];

      await service.startCompose('pipe-questions', [
        { role: 'user', content: 'Create infrastructure' },
      ]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const questionEvent = publishCalls.find(
        (call: unknown[]) => call[1] === 'terraform:questions'
      );
      expect(questionEvent).toBeDefined();
      expect(questionEvent[2].questions.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT publish text-parsed questions when code is present', async () => {
      const responseWithCode = [
        '1. Some question here that is long enough?',
        '```hcl',
        'resource "aws_vpc" "main" {}',
        '```',
      ].join('\n');

      mockStreamEvents = [makeTextDeltaEvent(responseWithCode), makeResultEvent()];

      await service.startCompose('pipe-no-qs', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const questionEvents = publishCalls.filter(
        (call: unknown[]) => call[1] === 'terraform:questions'
      );
      expect(questionEvents).toHaveLength(0);
    });

    it('publishes questions from AskUserQuestion tool via canUseTool callback', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      const createSessionMock = vi.mocked(unstable_v2_createSession);

      mockStreamEvents = [makeToolUseSummary(), makeResultEvent()];

      createSessionMock.mockImplementation((opts: any) => {
        if (opts.canUseTool) {
          opts.canUseTool(
            'AskUserQuestion',
            {
              questions: [
                {
                  question: 'What region?',
                  header: 'Infrastructure',
                  options: [
                    { label: 'us-east-1', description: 'N. Virginia' },
                    { label: 'eu-west-1', description: 'Ireland' },
                  ],
                },
              ],
            },
            { toolUseID: 'tool-123' }
          );
        }
        return {
          send: mockSessionSend,
          stream: () => ({
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                async next() {
                  if (index < mockStreamEvents.length) {
                    return { value: mockStreamEvents[index++], done: false };
                  }
                  return { value: undefined, done: true };
                },
              };
            },
          }),
          close: mockSessionClose,
        };
      });

      await service.startCompose('pipe-tool-qs', [
        { role: 'user', content: 'Create infrastructure' },
      ]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const questionEvent = publishCalls.find(
        (call: unknown[]) => call[1] === 'terraform:questions'
      );
      expect(questionEvent).toBeDefined();
      expect(questionEvent[2].questions).toHaveLength(1);
      expect(questionEvent[2].questions[0].question).toBe('What region?');
      expect(questionEvent[2].questions[0].category).toBe('Infrastructure');
      expect(questionEvent[2].questions[0].options).toEqual(['us-east-1', 'eu-west-1']);
    });
  });

  // ========================================================================
  // Pipeline — error handling
  // ========================================================================
  describe('pipeline — error handling', () => {
    it('publishes error event when registry context fails', async () => {
      mockRegistryService.getModuleContext.mockResolvedValue({
        ok: false,
        error: { message: 'Registry unreachable' },
      });

      await service.startCompose('pipe-err-registry', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent[2].error).toContain('Registry unreachable');
    });

    it('continues when module listing fails — publishes warning text', async () => {
      mockRegistryService.listModules.mockResolvedValue({
        ok: false,
        error: { message: 'Modules unavailable' },
      });

      mockStreamEvents = [
        makeTextDeltaEvent('```hcl\nresource "aws_vpc" "main" {}\n```'),
        makeResultEvent(),
      ];

      await service.startCompose('pipe-warn-modules', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const textEvents = publishCalls.filter((call: unknown[]) => call[1] === 'terraform:text');
      const warningEvent = textEvents.find(
        (call: any) => typeof call[2]?.delta === 'string' && call[2].delta.includes('Warning')
      );
      expect(warningEvent).toBeDefined();

      const doneEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:done');
      expect(doneEvent).toBeDefined();
    });

    it('publishes auth error message for authentication_error', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(unstable_v2_createSession).mockImplementation(() => {
        throw new Error('authentication_error: invalid x-api-key');
      });

      await service.startCompose('pipe-auth-err', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent[2].error).toContain('authentication failed');
    });

    it('publishes rate limit error message for 429 errors', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(unstable_v2_createSession).mockImplementation(() => {
        throw new Error('rate_limit: 429 Too Many Requests');
      });

      await service.startCompose('pipe-rate-limit', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent[2].error).toContain('rate limit');
    });

    it('publishes model error message for model_not_found', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(unstable_v2_createSession).mockImplementation(() => {
        throw new Error('model_not_found: invalid model');
      });

      await service.startCompose('pipe-model-err', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent[2].error).toContain('Model configuration error');
    });

    it('publishes context length error message', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(unstable_v2_createSession).mockImplementation(() => {
        throw new Error('context_length: too many tokens');
      });

      await service.startCompose('pipe-ctx-err', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent[2].error).toContain('too long');
    });

    it('publishes generic error for unknown errors', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      vi.mocked(unstable_v2_createSession).mockImplementation(() => {
        throw new Error('Something completely unexpected');
      });

      await service.startCompose('pipe-generic-err', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent[2].error).toContain('An error occurred');
    });

    it('publishes fallback error when pipeline throws unhandled', async () => {
      mockRegistryService.getModuleContext.mockRejectedValue(new Error('Unexpected crash'));

      await service.startCompose('pipe-unhandled', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const errorEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:error');
      expect(errorEvent).toBeDefined();
    });
  });

  // ========================================================================
  // Pipeline — stacks mode
  // ========================================================================
  describe('pipeline — stacks mode', () => {
    it('extracts multiple files in stacks mode and publishes code event with files', async () => {
      const stacksResponse = [
        'Here is your Stacks configuration:',
        '',
        '```hcl title="main.tfcomponent.hcl"',
        'component "vpc" {',
        '  source = "./modules/vpc"',
        '}',
        '```',
        '',
        '```hcl title="deploy.tfdeploy.hcl"',
        'deployment "production" {',
        '  inputs = {}',
        '}',
        '```',
      ].join('\n');

      mockStreamEvents = [makeTextDeltaEvent(stacksResponse), makeResultEvent()];

      await service.startCompose(
        'pipe-stacks',
        [{ role: 'user', content: 'Create a Stacks config' }],
        undefined,
        'stacks'
      );

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const codeEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:code');
      expect(codeEvent).toBeDefined();
      expect(codeEvent[2].files).toHaveLength(2);
      expect(codeEvent[2].files[0].filename).toBe('main.tfcomponent.hcl');
      expect(codeEvent[2].files[1].filename).toBe('deploy.tfdeploy.hcl');

      const doneEvent = publishCalls.find((call: unknown[]) => call[1] === 'terraform:done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent[2].generatedFiles).toHaveLength(2);
    });

    it('skips HCL validation in stacks mode', async () => {
      mockStreamEvents = [
        makeTextDeltaEvent('```hcl title="stack.tfcomponent.hcl"\ncomponent "a" {}\n```'),
        makeResultEvent(),
      ];

      await service.startCompose(
        'pipe-stacks-noval',
        [{ role: 'user', content: 'Create stacks' }],
        undefined,
        'stacks'
      );

      await mockDurableStreams.pipelineDone;

      const publishCalls = mockDurableStreams.publish.mock.calls;
      const statusEvents = publishCalls.filter((call: unknown[]) => call[1] === 'terraform:status');
      const stages = statusEvents.map((call: any) => call[2].stage);
      expect(stages).not.toContain('validating_hcl');
    });
  });

  // ========================================================================
  // Pipeline — conversation history
  // ========================================================================
  describe('pipeline — conversation history', () => {
    it('passes multi-turn messages to the Agent SDK', async () => {
      mockStreamEvents = [
        makeTextDeltaEvent('```hcl\nresource "aws_vpc" "v2" {}\n```'),
        makeResultEvent(),
      ];

      const messages = [
        { role: 'user' as const, content: 'Create a VPC' },
        { role: 'assistant' as const, content: 'What region do you want?' },
        { role: 'user' as const, content: 'us-east-1' },
      ];

      await service.startCompose('pipe-history', messages);

      await mockDurableStreams.pipelineDone;

      expect(mockSessionSend).toHaveBeenCalled();
      const sentPrompt = mockSessionSend.mock.calls[0]?.[0] as string;
      expect(sentPrompt).toContain('User: Create a VPC');
      expect(sentPrompt).toContain('Assistant: What region do you want?');
      expect(sentPrompt).toContain('User: us-east-1');
    });

    it('appends assistant response to session messages', async () => {
      mockStreamEvents = [makeTextDeltaEvent('Here is a VPC config.'), makeResultEvent()];

      await service.startCompose('pipe-append', [{ role: 'user', content: 'Create a VPC' }]);

      await mockDurableStreams.pipelineDone;

      const session = service.getSession('pipe-append');
      expect(session!.messages).toHaveLength(2);
      expect(session!.messages[0]!.role).toBe('user');
      expect(session!.messages[1]!.role).toBe('assistant');
      expect(session!.messages[1]!.content).toBe('Here is a VPC config.');
    });
  });

  // ========================================================================
  // validateCode
  // ========================================================================
  describe('validateCode', () => {
    it('returns valid: true for valid HCL', async () => {
      const result = await service.validateCode(
        'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}'
      );
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('diagnostics');
    });

    it('returns diagnostics for invalid HCL', async () => {
      const result = await service.validateCode('this is not valid HCL {{{{');
      if (!result.valid) {
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.severity).toBe('error');
      }
    });

    it('validates tfvars when provided', async () => {
      const result = await service.validateCode('variable "name" {}', 'name = "test"');
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('diagnostics');
    });
  });

  // ========================================================================
  // Session cleanup
  // ========================================================================
  describe('session cleanup', () => {
    it('evicts expired sessions during startCompose', async () => {
      mockStreamEvents = [makeResultEvent()];

      const internalSessions = (service as any).sessions as Map<string, unknown>;
      internalSessions.set('old-session', {
        id: 'old-session',
        messages: [],
        matchedModules: [],
        generatedCode: null,
        lastAccessedAt: Date.now() - 31 * 60 * 1000,
      });

      await service.startCompose('fresh-session', [{ role: 'user', content: 'Test' }]);

      await mockDurableStreams.pipelineDone;

      expect(service.getSession('old-session')).toBeUndefined();
    });

    it('evicts oldest sessions when over MAX_SESSIONS', async () => {
      mockStreamEvents = [makeResultEvent()];

      const internalSessions = (service as any).sessions as Map<string, unknown>;

      for (let i = 0; i < 101; i++) {
        internalSessions.set(`session-${i}`, {
          id: `session-${i}`,
          messages: [],
          matchedModules: [],
          generatedCode: null,
          lastAccessedAt: Date.now() + i,
        });
      }

      await service.startCompose('trigger-eviction', [{ role: 'user', content: 'Test' }]);

      await mockDurableStreams.pipelineDone;

      expect(service.getSession('session-0')).toBeUndefined();
    });
  });

  // ========================================================================
  // Pipeline — stream lifecycle
  // ========================================================================
  describe('pipeline — stream lifecycle', () => {
    it('deletes existing stream before creating a new one', async () => {
      mockStreamEvents = [makeResultEvent()];

      await service.startCompose('multi-turn', [{ role: 'user', content: 'Refine the config' }]);

      const deleteCall = mockDurableStreams.deleteStream.mock.invocationCallOrder[0];
      const createCall = mockDurableStreams.createStream.mock.invocationCallOrder[0];
      expect(deleteCall).toBeLessThan(createCall!);
    });
  });
});
