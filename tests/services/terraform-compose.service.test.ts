import { describe, expect, it } from 'vitest';
import {
  extractHclCode,
  extractStacksFiles,
  matchModulesInResponse,
  parseClarifyingQuestionsFromText,
  TerraformComposeService,
} from '../../src/services/terraform-compose.service';

describe('TerraformComposeService pure functions', () => {
  describe('extractHclCode', () => {
    it('extracts code from ```hcl blocks', () => {
      const input =
        'Some text\n```hcl\nresource "aws_s3_bucket" "example" {\n  bucket = "my-bucket"\n}\n```\nMore text';
      const result = extractHclCode(input);
      expect(result).toBe('resource "aws_s3_bucket" "example" {\n  bucket = "my-bucket"\n}');
    });

    it('extracts code from ```terraform and ```tf blocks', () => {
      const terraformInput = 'Before\n```terraform\nresource "a" "b" {}\n```\nAfter';
      expect(extractHclCode(terraformInput)).toBe('resource "a" "b" {}');

      const tfInput = 'Before\n```tf\nresource "c" "d" {}\n```\nAfter';
      expect(extractHclCode(tfInput)).toBe('resource "c" "d" {}');
    });

    it('returns null when no HCL blocks are found', () => {
      const input = 'Just some plain text without any code blocks';
      expect(extractHclCode(input)).toBeNull();
    });
  });

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
  });

  describe('matchModulesInResponse', () => {
    it('matches modules by source with confidence 1.0', () => {
      const modules = [
        {
          id: 'mod-1',
          name: 'consul',
          source: 'hashicorp/consul/aws',
          provider: 'aws',
          version: '1.0.0',
        } as any,
      ];
      const response =
        'module "consul" {\n  source = "hashicorp/consul/aws"\n  version = "1.0.0"\n}';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(1.0);
      expect(result[0]!.moduleId).toBe('mod-1');
    });

    it('matches modules by name with lower confidence', () => {
      const modules = [
        {
          id: 'mod-2',
          name: 'networking',
          source: 'custom/networking/azure',
          provider: 'azure',
          version: '2.0.0',
        } as any,
      ];
      const response = 'We will set up the networking layer for the VPC.';

      const result = matchModulesInResponse(response, modules);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence).toBe(0.5);
      expect(result[0]!.moduleId).toBe('mod-2');
    });
  });

  describe('parseClarifyingQuestionsFromText', () => {
    it('extracts numbered questions from text', () => {
      const input = '1. What region should we deploy to?\n2. What environment is this for?';

      const result = parseClarifyingQuestionsFromText(input);
      expect(result).toHaveLength(2);
      expect(result[0]!.question).toContain('What region should we deploy to?');
      expect(result[1]!.question).toContain('What environment is this for?');
    });
  });

  describe('TerraformComposeService class', () => {
    it('getSession returns undefined for non-existent session and after resetSession', () => {
      const mockRegistryService = {} as any;
      const mockDb = {} as any;
      const service = new TerraformComposeService(mockRegistryService, mockDb);

      expect(service.getSession('non-existent')).toBeUndefined();

      // resetSession on non-existent should not throw
      service.resetSession('non-existent');
      expect(service.getSession('non-existent')).toBeUndefined();
    });
  });
});
