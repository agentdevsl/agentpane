import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import {
  extractHclCode,
  extractStacksFiles,
  inferStacksFilename,
  matchModulesInResponse,
  parseClarifyingQuestionsFromText,
  TerraformComposeService,
} from '../../src/services/terraform-compose.service';
import { TerraformRegistryService } from '../../src/services/terraform-registry.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------------------------------------------------------------------------
// Mock external I/O boundaries
// ---------------------------------------------------------------------------

// Mock the Claude Agent SDK — never make real API calls in integration tests
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
}));

// Mock the file system read for SKILL.md
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue('# Stacks Skill Reference\nMock content'),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDurableStreamsService(overrides: Record<string, unknown> = {}) {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    deleteStream: vi.fn().mockResolvedValue(true),
    publish: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function insertTestRegistry(db: ReturnType<typeof getTestDb>) {
  const registryId = createId();
  return db
    .insert(terraformRegistries)
    .values({
      id: registryId,
      name: 'Test Registry',
      orgName: 'test-org',
      tokenSettingKey: `terraform.registry.${registryId}.apiToken`,
      status: 'active',
      moduleCount: 0,
    })
    .returning()
    .then(([r]) => r!);
}

async function insertTestModules(db: ReturnType<typeof getTestDb>, registryId: string, count = 3) {
  const modules = [];
  const providers = ['aws', 'azure', 'google'];
  for (let i = 0; i < count; i++) {
    const [mod] = await db
      .insert(terraformModules)
      .values({
        id: createId(),
        registryId,
        name: `module-${i}`,
        namespace: 'test-org',
        provider: providers[i % providers.length]!,
        version: '1.0.0',
        source: `test-org/module-${i}/${providers[i % providers.length]!}`,
        description: `Test module ${i}`,
        inputs: [{ name: 'region', type: 'string', required: true, description: 'AWS region' }],
        outputs: [{ name: 'id', description: 'Resource ID' }],
      })
      .returning();
    modules.push(mod!);
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerraformComposeService (IT-400 to IT-413)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    try {
      execRawSql(TERRAFORM_MIGRATION_SQL);
    } catch {
      // Tables may already exist
    }
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
  });

  afterEach(async () => {
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await clearTestDatabase();
  });

  // -------------------------------------------------------------------------
  // Pure function tests: extractHclCode
  // -------------------------------------------------------------------------

  describe('extractHclCode (IT-400)', () => {
    it('IT-400a: extracts HCL from ```hcl fenced block', () => {
      const text =
        'Some text\n```hcl\nresource "aws_s3_bucket" "main" {\n  bucket = "my-bucket"\n}\n```\nMore text';
      const result = extractHclCode(text);
      expect(result).toContain('resource "aws_s3_bucket" "main"');
      expect(result).toContain('bucket = "my-bucket"');
    });

    it('IT-400b: extracts HCL from ```terraform fenced block', () => {
      const text = '```terraform\nprovider "aws" {\n  region = "us-east-1"\n}\n```';
      const result = extractHclCode(text);
      expect(result).toContain('provider "aws"');
    });

    it('IT-400c: extracts HCL from ```tf fenced block', () => {
      const text = '```tf\nvariable "name" {\n  type = string\n}\n```';
      const result = extractHclCode(text);
      expect(result).toContain('variable "name"');
    });

    it('IT-400d: joins multiple HCL blocks with double newline', () => {
      const text = '```hcl\nresource "a" {}\n```\nText\n```hcl\nresource "b" {}\n```';
      const result = extractHclCode(text);
      expect(result).toContain('resource "a" {}');
      expect(result).toContain('resource "b" {}');
    });

    it('IT-400e: returns null when no HCL blocks present', () => {
      const text = 'Just plain text with no code blocks';
      expect(extractHclCode(text)).toBeNull();
    });

    it('IT-400f: ignores non-HCL code blocks', () => {
      const text = '```json\n{"key": "value"}\n```\n```python\nprint("hi")\n```';
      expect(extractHclCode(text)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Pure function tests: extractStacksFiles
  // -------------------------------------------------------------------------

  describe('extractStacksFiles (IT-401)', () => {
    it('IT-401a: extracts file with title annotation', () => {
      const text = '```hcl title="main.tfcomponent.hcl"\ncomponent "vpc" {}\n```';
      const files = extractStacksFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0]!.filename).toBe('main.tfcomponent.hcl');
      expect(files[0]!.code).toContain('component "vpc"');
    });

    it('IT-401b: infers filename from content when title is missing', () => {
      const text = '```hcl\ndeployment "prod" {\n  target = "us-east-1"\n}\n```';
      const files = extractStacksFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0]!.filename).toBe('deployments.tfdeploy.hcl');
    });

    it('IT-401c: deduplicates files with same filename', () => {
      const text =
        '```hcl title="vars.tfcomponent.hcl"\nvariable "a" {}\n```\n' +
        '```hcl title="vars.tfcomponent.hcl"\nvariable "b" {}\n```';
      const files = extractStacksFiles(text);
      expect(files).toHaveLength(1);
      expect(files[0]!.code).toContain('variable "a"');
      expect(files[0]!.code).toContain('variable "b"');
    });

    it('IT-401d: returns empty array when no code blocks', () => {
      expect(extractStacksFiles('No code here')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pure function tests: inferStacksFilename
  // -------------------------------------------------------------------------

  describe('inferStacksFilename (IT-402)', () => {
    it('IT-402a: infers deployment file', () => {
      expect(inferStacksFilename('deployment "prod" {')).toBe('deployments.tfdeploy.hcl');
    });

    it('IT-402b: infers deployment_group file', () => {
      expect(inferStacksFilename('deployment_group "all" {')).toBe('deployments.tfdeploy.hcl');
    });

    it('IT-402c: infers provider file', () => {
      expect(inferStacksFilename('provider "aws" {')).toBe('providers.tfcomponent.hcl');
    });

    it('IT-402d: infers variable file', () => {
      expect(inferStacksFilename('variable "region" {')).toBe('variables.tfcomponent.hcl');
    });

    it('IT-402e: infers output file', () => {
      expect(inferStacksFilename('output "vpc_id" {')).toBe('outputs.tfcomponent.hcl');
    });

    it('IT-402f: infers component file', () => {
      expect(inferStacksFilename('component "network" {')).toBe('components.tfcomponent.hcl');
    });

    it('IT-402g: defaults to stack.tfcomponent.hcl', () => {
      expect(inferStacksFilename('resource "aws_instance" "web" {')).toBe('stack.tfcomponent.hcl');
    });
  });

  // -------------------------------------------------------------------------
  // Pure function tests: matchModulesInResponse
  // -------------------------------------------------------------------------

  describe('matchModulesInResponse (IT-403)', () => {
    const testModules = [
      {
        id: 'mod-1',
        registryId: 'reg-1',
        name: 'vpc',
        namespace: 'hashicorp',
        provider: 'aws',
        version: '5.0.0',
        source: 'hashicorp/vpc/aws',
        description: 'VPC module',
        inputs: null,
        outputs: null,
        dependencies: null,
        readme: null,
        publishedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'mod-2',
        registryId: 'reg-1',
        name: 'security-group',
        namespace: 'hashicorp',
        provider: 'aws',
        version: '3.0.0',
        source: 'hashicorp/security-group/aws',
        description: 'SG module',
        inputs: null,
        outputs: null,
        dependencies: null,
        readme: null,
        publishedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    it('IT-403a: matches by source with confidence 1.0', () => {
      const response = 'module "vpc" {\n  source = "hashicorp/vpc/aws"\n}';
      const matches = matchModulesInResponse(response, testModules);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      const vpcMatch = matches.find((m) => m.moduleId === 'mod-1');
      expect(vpcMatch).toBeDefined();
      expect(vpcMatch!.confidence).toBe(1.0);
    });

    it('IT-403b: matches by name + provider with confidence 0.8', () => {
      const response = 'We will use the vpc module from the aws provider.';
      const matches = matchModulesInResponse(response, testModules);
      const vpcMatch = matches.find((m) => m.moduleId === 'mod-1');
      expect(vpcMatch).toBeDefined();
      expect(vpcMatch!.confidence).toBe(0.8);
    });

    it('IT-403c: matches by name only with confidence 0.5', () => {
      const response = 'Use the security-group module for firewall rules.';
      const matches = matchModulesInResponse(response, testModules);
      const sgMatch = matches.find((m) => m.moduleId === 'mod-2');
      expect(sgMatch).toBeDefined();
      expect(sgMatch!.confidence).toBe(0.5);
    });

    it('IT-403d: does not match generic module names', () => {
      const genericModules = [
        {
          ...testModules[0]!,
          id: 'mod-generic',
          name: 'module',
          source: 'org/module/aws',
        },
      ];
      const response = 'This module is great';
      const matches = matchModulesInResponse(response, genericModules);
      // 'module' is in GENERIC_MODULE_NAMES so should not match by name alone
      const genericMatch = matches.find((m) => m.moduleId === 'mod-generic');
      expect(genericMatch).toBeUndefined();
    });

    it('IT-403e: sorts by confidence descending', () => {
      const response = 'source = "hashicorp/vpc/aws"\nAlso mentions security-group';
      const matches = matchModulesInResponse(response, testModules);
      if (matches.length >= 2) {
        expect(matches[0]!.confidence).toBeGreaterThanOrEqual(matches[1]!.confidence);
      }
    });

    it('IT-403f: returns empty array for no matches', () => {
      const response = 'Nothing related to any modules';
      const matches = matchModulesInResponse(response, testModules);
      expect(matches).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pure function tests: parseClarifyingQuestionsFromText
  // -------------------------------------------------------------------------

  describe('parseClarifyingQuestionsFromText (IT-404)', () => {
    it('IT-404a: parses numbered questions', () => {
      const text =
        '1. What region should the resources be deployed to?\n2. What environment is this for?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(2);
      expect(questions[0]!.question).toContain('region');
      expect(questions[1]!.question).toContain('environment');
    });

    it('IT-404b: parses bullet questions', () => {
      const text = '- Should SSL certificates be included?\n- What domain should be used?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(2);
    });

    it('IT-404c: extracts category from bold markers', () => {
      const text = '1. **Networking** - What CIDR block should be used for the VPC?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.category).toBe('Networking');
    });

    it('IT-404d: infers default options for region questions', () => {
      const text = '1. What region should the resources be deployed to?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('us-east-1');
    });

    it('IT-404e: extracts backtick options', () => {
      const text = '1. Should we use `t3.micro` or `t3.small` for the instance?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('t3.micro');
      expect(questions[0]!.options).toContain('t3.small');
    });

    it('IT-404f: skips text with HCL code blocks', () => {
      const text = '```hcl\nresource "aws_s3_bucket" "main" {}\n```\n1. What region?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(0);
    });

    it('IT-404g: ignores questions shorter than 10 chars', () => {
      const text = '1. Short?\n2. What is the desired CIDR block for the VPC?';
      const questions = parseClarifyingQuestionsFromText(text);
      expect(questions).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Service integration tests: session management
  // -------------------------------------------------------------------------

  describe('Session management (IT-405)', () => {
    it('IT-405a: getSession returns undefined for nonexistent session', () => {
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(registryService, db as any);
      expect(service.getSession('nonexistent')).toBeUndefined();
    });

    it('IT-405b: resetSession removes session and calls deleteStream', () => {
      const mockStreams = createMockDurableStreamsService();
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      // Manually set a session to test reset
      (service as any).sessions.set('test-session', {
        id: 'test-session',
        messages: [],
        matchedModules: [],
        generatedCode: null,
        lastAccessedAt: Date.now(),
      });

      expect(service.getSession('test-session')).toBeDefined();

      service.resetSession('test-session');

      expect(service.getSession('test-session')).toBeUndefined();
      expect(mockStreams.deleteStream).toHaveBeenCalledWith('terraform:test-session');
    });
  });

  // -------------------------------------------------------------------------
  // Service integration tests: session cleanup
  // -------------------------------------------------------------------------

  describe('Session cleanup (IT-406)', () => {
    it('IT-406a: cleanupSessions removes expired sessions', () => {
      const mockStreams = createMockDurableStreamsService();
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      const sessionsMap = (service as any).sessions as Map<string, any>;

      // Add an expired session (lastAccessedAt > 30 minutes ago)
      sessionsMap.set('expired-1', {
        id: 'expired-1',
        messages: [],
        matchedModules: [],
        generatedCode: null,
        lastAccessedAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago
      });

      // Add a fresh session
      sessionsMap.set('fresh-1', {
        id: 'fresh-1',
        messages: [],
        matchedModules: [],
        generatedCode: null,
        lastAccessedAt: Date.now(),
      });

      // Trigger cleanup via private method
      (service as any).cleanupSessions();

      expect(sessionsMap.has('expired-1')).toBe(false);
      expect(sessionsMap.has('fresh-1')).toBe(true);
      expect(mockStreams.deleteStream).toHaveBeenCalledWith('terraform:expired-1');
    });

    it('IT-406b: cleanupSessions evicts oldest when over MAX_SESSIONS', () => {
      const mockStreams = createMockDurableStreamsService();
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      const sessionsMap = (service as any).sessions as Map<string, any>;

      // Add 101 sessions (MAX_SESSIONS is 100)
      for (let i = 0; i < 101; i++) {
        sessionsMap.set(`session-${i}`, {
          id: `session-${i}`,
          messages: [],
          matchedModules: [],
          generatedCode: null,
          lastAccessedAt: Date.now() + i, // incrementing timestamps
        });
      }

      expect(sessionsMap.size).toBe(101);

      (service as any).cleanupSessions();

      expect(sessionsMap.size).toBe(100);
      // session-0 was the oldest and should be evicted
      expect(sessionsMap.has('session-0')).toBe(false);
      // session-100 should still exist (newest)
      expect(sessionsMap.has('session-100')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Service integration tests: startCompose validation
  // -------------------------------------------------------------------------

  describe('startCompose validation (IT-407)', () => {
    it('IT-407a: throws STREAMS_REQUIRED when no DurableStreamsService', async () => {
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(registryService, db as any);

      await expect(
        service.startCompose(undefined, [{ role: 'user', content: 'Create a VPC' }])
      ).rejects.toMatchObject({ code: 'STREAMS_REQUIRED' });
    });

    it('IT-407b: returns session ID immediately when DurableStreamsService is configured', async () => {
      const mockStreams = createMockDurableStreamsService();
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      const result = await service.startCompose(undefined, [
        { role: 'user', content: 'Create a VPC' },
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionId).toBeTruthy();
        expect(typeof result.value.sessionId).toBe('string');
      }
    });

    it('IT-407c: uses provided sessionId when given', async () => {
      const mockStreams = createMockDurableStreamsService();
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      const customId = 'my-custom-session-id';
      const result = await service.startCompose(customId, [
        { role: 'user', content: 'Create a VPC' },
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionId).toBe(customId);
      }
    });

    it('IT-407d: creates and recreates stream on each compose call', async () => {
      const mockStreams = createMockDurableStreamsService();
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      await service.startCompose('sess-1', [{ role: 'user', content: 'Create a VPC' }]);

      // deleteStream called for cleanup, then createStream called
      expect(mockStreams.deleteStream).toHaveBeenCalledWith('terraform:sess-1');
      expect(mockStreams.createStream).toHaveBeenCalledWith('terraform:sess-1', null);
    });

    it('IT-407e: throws STREAM_CREATE_FAILED when createStream fails', async () => {
      const mockStreams = createMockDurableStreamsService({
        createStream: vi.fn().mockRejectedValue(new Error('Caddy offline')),
      });
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(
        registryService,
        db as any,
        undefined,
        mockStreams as any
      );

      await expect(
        service.startCompose(undefined, [{ role: 'user', content: 'Create a VPC' }])
      ).rejects.toMatchObject({ code: 'STREAM_CREATE_FAILED' });
    });
  });

  // -------------------------------------------------------------------------
  // Service integration tests: validateCode
  // -------------------------------------------------------------------------

  describe('validateCode (IT-408)', () => {
    it('IT-408a: returns valid=true for valid HCL', async () => {
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(registryService, db as any);

      const result = await service.validateCode(
        'variable "name" {\n  type = string\n  default = "test"\n}'
      );

      expect(result.valid).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    it('IT-408b: returns diagnostics for invalid HCL', async () => {
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(registryService, db as any);

      const result = await service.validateCode('this is { not valid hcl }{{{');

      expect(result.valid).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0]!.severity).toBe('error');
    });

    it('IT-408c: validates both main code and tfvars', async () => {
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(registryService, db as any);

      const validCode = 'variable "name" {\n  type = string\n}';
      const validTfvars = 'name = "production"';

      const result = await service.validateCode(validCode, validTfvars);
      expect(result.valid).toBe(true);
    });

    it('IT-408d: reports tfvars errors separately', async () => {
      const registryService = new TerraformRegistryService(db as any);
      const service = new TerraformComposeService(registryService, db as any);

      const validCode = 'variable "name" {\n  type = string\n}';
      const invalidTfvars = '{{not valid tfvars}}';

      const result = await service.validateCode(validCode, invalidTfvars);
      expect(result.valid).toBe(false);
      const tfvarsDiag = result.diagnostics.find((d) => d.summary.includes('terraform.tfvars'));
      expect(tfvarsDiag).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Integration with registry service via DB
  // -------------------------------------------------------------------------

  describe('Registry integration for module context (IT-409)', () => {
    it('IT-409a: getModuleContext returns formatted text for modules in DB', async () => {
      const registry = await insertTestRegistry(db);
      await insertTestModules(db, registry.id, 2);

      const registryService = new TerraformRegistryService(db as any);
      const result = await registryService.getModuleContext(registry.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('Available Terraform Modules');
        expect(result.value).toContain('module-0');
        expect(result.value).toContain('module-1');
        expect(result.value).toContain('region');
      }
    });

    it('IT-409b: getModuleContext returns placeholder when no modules', async () => {
      const registryService = new TerraformRegistryService(db as any);
      const result = await registryService.getModuleContext('nonexistent-registry');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('No Terraform modules available');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Default options inference
  // -------------------------------------------------------------------------

  describe('Default option inference (IT-410)', () => {
    it('IT-410a: infers region options', () => {
      const questions = parseClarifyingQuestionsFromText(
        '1. What region should we deploy the infrastructure to?'
      );
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('us-east-1');
      expect(questions[0]!.options).toContain('us-west-2');
    });

    it('IT-410b: infers environment options', () => {
      const questions = parseClarifyingQuestionsFromText(
        '1. What environment is this deployment targeting?'
      );
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('Production');
      expect(questions[0]!.options).toContain('Staging');
    });

    it('IT-410c: infers SSL options', () => {
      const questions = parseClarifyingQuestionsFromText(
        '1. Should we include SSL certificate provisioning via ACM?'
      );
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('Yes, include ACM');
    });

    it('IT-410d: infers instance type options', () => {
      const questions = parseClarifyingQuestionsFromText(
        '1. What instance type and sizing should be used?'
      );
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('t3.micro');
      expect(questions[0]!.options).toContain('t3.small');
    });

    it('IT-410e: defaults to yes/no for should-style questions', () => {
      const questions = parseClarifyingQuestionsFromText(
        '1. What naming convention should the resources follow?'
      );
      expect(questions).toHaveLength(1);
      // "should" triggers the yes/no pattern
      expect(questions[0]!.options).toContain('Yes');
      expect(questions[0]!.options).toContain('No');
    });

    it('IT-410f: defaults to placeholder for truly unknown categories', () => {
      const questions = parseClarifyingQuestionsFromText(
        '1. What naming convention are you planning to adopt?'
      );
      expect(questions).toHaveLength(1);
      expect(questions[0]!.options).toContain('Use placeholder values');
    });
  });
});
