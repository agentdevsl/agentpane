/**
 * Integration tests for Terraform parsing functions.
 *
 * Covers:
 * - parse-hcl-dependencies.ts: module dependency graph extraction
 * - parse-hcl-variables.ts: variable block parsing + smart widgets
 * - parse-stacks-dependencies.ts: Terraform Stacks component graph
 *
 * IT-IDs: IT-1842 through IT-1879
 */
import { describe, expect, it } from 'vitest';
import { parseHclDependencies } from '../../src/lib/terraform/parse-hcl-dependencies';
import {
  inferSmartWidget,
  normalizeVariableType,
  parseHclVariables,
} from '../../src/lib/terraform/parse-hcl-variables';
import { parseStacksDependencies } from '../../src/lib/terraform/parse-stacks-dependencies';
import type { ModuleMatch } from '../../src/lib/terraform/types';

// ── HCL Dependency Parsing ──────────────────────────────────────────────────

describe('parseHclDependencies', () => {
  it('IT-1842: returns empty graph for empty input', () => {
    const result = parseHclDependencies('', []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('IT-1843: returns empty graph when no module blocks found', () => {
    const code = `
resource "aws_instance" "web" {
  ami           = "ami-12345"
  instance_type = "t3.micro"
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('IT-1844: extracts single module as a node', () => {
    const code = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
  cidr = "10.0.0.0/16"
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('vpc');
    expect(result.nodes[0].source).toBe('terraform-aws-modules/vpc/aws');
    expect(result.nodes[0].provider).toBe('aws');
    expect(result.edges).toEqual([]);
  });

  it('IT-1845: extracts explicit depends_on edges', () => {
    const code = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

module "eks" {
  source = "terraform-aws-modules/eks/aws"
  depends_on = [module.vpc]
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: 'vpc',
      target: 'eks',
      type: 'explicit',
    });
  });

  it('IT-1846: extracts implicit module reference edges', () => {
    const code = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

module "eks" {
  source = "terraform-aws-modules/eks/aws"
  vpc_id = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
}`;
    const result = parseHclDependencies(code, []);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: 'vpc',
      target: 'eks',
      type: 'implicit',
    });
    expect(result.edges[0].label).toContain('vpc_id');
    expect(result.edges[0].label).toContain('private_subnets');
  });

  it('IT-1847: deduplicates edges (explicit + implicit to same target)', () => {
    const code = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

module "eks" {
  source = "terraform-aws-modules/eks/aws"
  vpc_id = module.vpc.vpc_id
  depends_on = [module.vpc]
}`;
    const result = parseHclDependencies(code, []);
    // explicit is added first, implicit same edge is skipped
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe('explicit');
  });

  it('IT-1848: handles nested braces in module blocks', () => {
    const code = `
module "lambda" {
  source = "terraform-aws-modules/lambda/aws"
  environment {
    variables = {
      KEY = "value"
    }
  }
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('lambda');
  });

  it('IT-1849: infers azure provider from source', () => {
    const code = `
module "rg" {
  source = "Azure/resource-group/azurerm"
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes[0].provider).toBe('azure');
  });

  it('IT-1850: infers gcp provider from source', () => {
    const code = `
module "gke" {
  source = "terraform-google-modules/kubernetes-engine/google"
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes[0].provider).toBe('gcp');
  });

  it('IT-1851: uses provider from matched module when available', () => {
    const code = `
module "custom" {
  source = "my-org/custom/module"
}`;
    const matchedModules: ModuleMatch[] = [
      {
        moduleId: 'mod-1',
        name: 'custom',
        provider: 'AWS',
        version: '1.0.0',
        source: 'my-org/custom/module',
        confidence: 0.9,
        matchReason: 'exact',
      },
    ];
    const result = parseHclDependencies(code, matchedModules);
    expect(result.nodes[0].provider).toBe('aws');
    expect(result.nodes[0].confidence).toBe(0.9);
  });

  it('IT-1852: returns unknown provider for unrecognized source', () => {
    const code = `
module "custom" {
  source = "my-org/custom/module"
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes[0].provider).toBe('unknown');
  });

  it('IT-1853: labels nodes with title-cased names', () => {
    const code = `
module "my_vpc_module" {
  source = "terraform-aws-modules/vpc/aws"
}`;
    const result = parseHclDependencies(code, []);
    expect(result.nodes[0].label).toBe('My Vpc Module');
  });

  it('IT-1854: multiple depends_on references', () => {
    const code = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

module "rds" {
  source = "terraform-aws-modules/rds/aws"
}

module "app" {
  source = "terraform-aws-modules/ecs/aws"
  depends_on = [module.vpc, module.rds]
}`;
    const result = parseHclDependencies(code, []);
    expect(result.edges).toHaveLength(2);
    const edgeSources = result.edges.map((e) => e.source).sort();
    expect(edgeSources).toEqual(['rds', 'vpc']);
  });
});

// ── HCL Variable Parsing ────────────────────────────────────────────────────

describe('parseHclVariables', () => {
  it('IT-1855: returns empty array for empty input', () => {
    const result = parseHclVariables('');
    expect(result).toEqual([]);
  });

  it('IT-1856: parses a simple string variable', () => {
    const code = `
variable "name" {
  type        = string
  description = "The name"
}`;
    const result = parseHclVariables(code);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'name',
      type: 'string',
      normalizedType: 'string',
      description: 'The name',
      default: null,
      sensitive: false,
      required: true,
    });
  });

  it('IT-1857: parses a variable with default value', () => {
    const code = `
variable "region" {
  type    = string
  default = "us-east-1"
}`;
    const result = parseHclVariables(code);
    expect(result[0].default).toBe('us-east-1');
    expect(result[0].required).toBe(false);
  });

  it('IT-1858: parses bool variable with default true', () => {
    const code = `
variable "enabled" {
  type    = bool
  default = true
}`;
    const result = parseHclVariables(code);
    expect(result[0]).toMatchObject({
      normalizedType: 'bool',
      default: 'true',
      required: false,
    });
  });

  it('IT-1859: parses sensitive variable', () => {
    const code = `
variable "db_password" {
  type      = string
  sensitive = true
}`;
    const result = parseHclVariables(code);
    expect(result[0].sensitive).toBe(true);
  });

  it('IT-1860: parses number variable', () => {
    const code = `
variable "instance_count" {
  type    = number
  default = 3
}`;
    const result = parseHclVariables(code);
    expect(result[0]).toMatchObject({
      normalizedType: 'number',
      default: '3',
    });
  });

  it('IT-1861: parses complex type: list(string)', () => {
    const code = `
variable "azs" {
  type = list(string)
}`;
    const result = parseHclVariables(code);
    expect(result[0]).toMatchObject({
      type: 'list(string)',
      normalizedType: 'list',
      required: true,
    });
  });

  it('IT-1862: parses complex type: map(string)', () => {
    const code = `
variable "tags" {
  type    = map(string)
  default = {}
}`;
    const result = parseHclVariables(code);
    expect(result[0]).toMatchObject({
      type: 'map(string)',
      normalizedType: 'map',
      required: false,
    });
  });

  it('IT-1863: parses object type', () => {
    const code = `
variable "config" {
  type = object({
    name = string
    port = number
  })
}`;
    const result = parseHclVariables(code);
    expect(result[0].normalizedType).toBe('object');
  });

  it('IT-1864: parses multiple variables', () => {
    const code = `
variable "name" {
  type = string
}

variable "count" {
  type    = number
  default = 1
}

variable "enabled" {
  type    = bool
  default = false
}`;
    const result = parseHclVariables(code);
    expect(result).toHaveLength(3);
    expect(result.map((v) => v.name)).toEqual(['name', 'count', 'enabled']);
  });

  it('IT-1865: handles nested braces in variable blocks', () => {
    const code = `
variable "complex_default" {
  type = map(object({
    port = number
    tags = map(string)
  }))
  default = {
    web = {
      port = 80
      tags = {
        env = "prod"
      }
    }
  }
}`;
    const result = parseHclVariables(code);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('complex_default');
    expect(result[0].required).toBe(false);
  });
});

// ── normalizeVariableType ───────────────────────────────────────────────────

describe('normalizeVariableType', () => {
  it('IT-1866: normalizes basic types', () => {
    expect(normalizeVariableType('string')).toBe('string');
    expect(normalizeVariableType('number')).toBe('number');
    expect(normalizeVariableType('bool')).toBe('bool');
  });

  it('IT-1867: normalizes collection types', () => {
    expect(normalizeVariableType('list(string)')).toBe('list');
    expect(normalizeVariableType('set(string)')).toBe('list');
    expect(normalizeVariableType('map(string)')).toBe('map');
    expect(normalizeVariableType('object({name=string})')).toBe('object');
    expect(normalizeVariableType('tuple([string, number])')).toBe('list');
  });

  it('IT-1868: returns unknown for unrecognized types', () => {
    expect(normalizeVariableType('any')).toBe('unknown');
    expect(normalizeVariableType('custom_type')).toBe('unknown');
  });
});

// ── inferSmartWidget ────────────────────────────────────────────────────────

describe('inferSmartWidget', () => {
  it('IT-1869: returns switch for bool variables', () => {
    const widget = inferSmartWidget({
      name: 'enabled',
      type: 'bool',
      normalizedType: 'bool',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget).toEqual({ kind: 'switch' });
  });

  it('IT-1870: returns select with regions for region variable', () => {
    const widget = inferSmartWidget({
      name: 'aws_region',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget?.kind).toBe('select');
    expect(widget?.options).toContain('us-east-1');
  });

  it('IT-1871: returns select with environments for environment variable', () => {
    const widget = inferSmartWidget({
      name: 'environment',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget?.kind).toBe('select');
    expect(widget?.options).toContain('production');
    expect(widget?.options).toContain('staging');
  });

  it('IT-1872: returns select for instance_type variable', () => {
    const widget = inferSmartWidget({
      name: 'instance_type',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget?.kind).toBe('select');
    expect(widget?.options).toContain('t3.micro');
  });

  it('IT-1873: returns text widget for CIDR variable', () => {
    const widget = inferSmartWidget({
      name: 'vpc_cidr',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget?.kind).toBe('text');
    expect(widget?.placeholder).toBe('10.0.0.0/16');
  });

  it('IT-1874: returns null for generic string variable', () => {
    const widget = inferSmartWidget({
      name: 'project_name',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget).toBeNull();
  });

  it('IT-1875: recognizes _env suffix for environment', () => {
    const widget = inferSmartWidget({
      name: 'deploy_env',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget?.kind).toBe('select');
    expect(widget?.options).toContain('production');
  });

  it('IT-1876: recognizes subnet in variable name', () => {
    const widget = inferSmartWidget({
      name: 'private_subnet',
      type: 'string',
      normalizedType: 'string',
      description: null,
      default: null,
      sensitive: false,
      required: true,
    });
    expect(widget?.kind).toBe('text');
    expect(widget?.placeholder).toBe('10.0.0.0/16');
  });
});

// ── Terraform Stacks Dependency Parsing ─────────────────────────────────────

describe('parseStacksDependencies', () => {
  it('IT-1877: returns empty graph for empty files', () => {
    const result = parseStacksDependencies([], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('IT-1878: extracts components from stacks files', () => {
    const files = [
      {
        filename: 'main.tfstack.hcl',
        code: `
component "network" {
  source = "./modules/network"
}

component "compute" {
  source = "./modules/compute"
  vpc_id = component.network.vpc_id
}`,
      },
    ];
    const result = parseStacksDependencies(files, []);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['compute', 'network']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: 'network',
      target: 'compute',
      type: 'implicit',
    });
    expect(result.edges[0].label).toBe('vpc_id');
  });

  it('IT-1879: handles multiple files concatenated', () => {
    const files = [
      {
        filename: 'network.tfstack.hcl',
        code: `
component "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}`,
      },
      {
        filename: 'compute.tfstack.hcl',
        code: `
component "eks" {
  source = "terraform-aws-modules/eks/aws"
  vpc_id = component.vpc.vpc_id
}`,
      },
    ];
    const result = parseStacksDependencies(files, []);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source).toBe('vpc');
    expect(result.edges[0].target).toBe('eks');
  });

  it('IT-1880: infers provider from matched modules', () => {
    const files = [
      {
        filename: 'main.tfstack.hcl',
        code: `
component "db" {
  source = "my-org/database/custom"
}`,
      },
    ];
    const matchedModules: ModuleMatch[] = [
      {
        moduleId: 'mod-1',
        name: 'database',
        provider: 'Azure',
        version: '2.0.0',
        source: 'my-org/database/custom',
        confidence: 0.95,
        matchReason: 'exact',
      },
    ];
    const result = parseStacksDependencies(files, matchedModules);
    expect(result.nodes[0].provider).toBe('azure');
    expect(result.nodes[0].confidence).toBe(0.95);
  });

  it('IT-1881: does not create self-referencing edges', () => {
    const files = [
      {
        filename: 'main.tfstack.hcl',
        code: `
component "app" {
  source = "./modules/app"
  name = component.app.default_name
}`,
      },
    ];
    const result = parseStacksDependencies(files, []);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });

  it('IT-1882: deduplicates edges from multiple references', () => {
    const files = [
      {
        filename: 'main.tfstack.hcl',
        code: `
component "network" {
  source = "./modules/network"
}

component "app" {
  source = "./modules/app"
  vpc_id = component.network.vpc_id
  subnet = component.network.subnet_ids
  sg_id  = component.network.security_group
}`,
      },
    ];
    const result = parseStacksDependencies(files, []);
    // Only one edge from network -> app, with all outputs in label
    expect(result.edges).toHaveLength(1);
    const label = result.edges[0].label ?? '';
    expect(label).toContain('vpc_id');
    expect(label).toContain('subnet_ids');
    expect(label).toContain('security_group');
  });

  it('IT-1883: handles nested braces in component blocks', () => {
    const files = [
      {
        filename: 'main.tfstack.hcl',
        code: `
component "lambda" {
  source = "terraform-aws-modules/lambda/aws"
  environment = {
    variables = {
      KEY = "value"
    }
  }
}`,
      },
    ];
    const result = parseStacksDependencies(files, []);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('lambda');
  });
});
