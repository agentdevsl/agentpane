/**
 * Integration tests for `generate-tfvars.ts`.
 *
 * Validates that the generator emits valid HCL `terraform.tfvars` content
 * for each variable type and respects the "skip empty/undefined" rule.
 *
 * IT-IDs: IT-1900 to IT-1909
 */
import { describe, expect, it } from 'vitest';
import { generateTfvars } from '../../src/lib/terraform/generate-tfvars';
import type { ParsedHclVariable } from '../../src/lib/terraform/parse-hcl-variables';

function v(overrides: Partial<ParsedHclVariable>): ParsedHclVariable {
  return {
    name: overrides.name ?? 'name',
    type: overrides.type ?? 'string',
    normalizedType: overrides.normalizedType ?? 'string',
    description: overrides.description ?? null,
    default: overrides.default ?? null,
    sensitive: overrides.sensitive ?? false,
    required: overrides.required ?? true,
  };
}

describe('generateTfvars', () => {
  it('IT-1900: returns empty string for no variables and no values', () => {
    const result = generateTfvars([], {});
    expect(result).toBe('');
  });

  it('IT-1901: skips variables with no value supplied', () => {
    const variables = [v({ name: 'region' })];
    expect(generateTfvars(variables, {})).toBe('');
  });

  it('IT-1902: skips variables whose value is the empty string', () => {
    const variables = [v({ name: 'region' })];
    expect(generateTfvars(variables, { region: '' })).toBe('');
  });

  it('IT-1903: emits a quoted string value for string type', () => {
    const variables = [v({ name: 'region', normalizedType: 'string' })];
    expect(generateTfvars(variables, { region: 'us-east-1' })).toContain('region = "us-east-1"');
  });

  it('IT-1904: keeps an already-quoted string verbatim', () => {
    const variables = [v({ name: 'name', normalizedType: 'string' })];
    expect(generateTfvars(variables, { name: '"already-quoted"' })).toContain(
      'name = "already-quoted"'
    );
  });

  it('IT-1905: emits a number value unquoted for number type', () => {
    const variables = [v({ name: 'count', normalizedType: 'number' })];
    expect(generateTfvars(variables, { count: '3' })).toContain('count = 3');
  });

  it('IT-1906: emits a bool value unquoted for bool type', () => {
    const variables = [v({ name: 'enabled', normalizedType: 'bool' })];
    expect(generateTfvars(variables, { enabled: 'true' })).toContain('enabled = true');
  });

  it('IT-1907: emits list/map/object values unquoted (assumes valid HCL fragment)', () => {
    const variables = [
      v({ name: 'azs', normalizedType: 'list' }),
      v({ name: 'tags', normalizedType: 'map' }),
      v({ name: 'config', normalizedType: 'object' }),
    ];
    const out = generateTfvars(variables, {
      azs: '["us-east-1a", "us-east-1b"]',
      tags: '{ env = "prod" }',
      config: '{ name = "x", port = 80 }',
    });
    expect(out).toContain('azs = ["us-east-1a", "us-east-1b"]');
    expect(out).toContain('tags = { env = "prod" }');
    expect(out).toContain('config = { name = "x", port = 80 }');
  });

  it('IT-1908: prepends a comment line for variables with description', () => {
    const variables = [
      v({ name: 'region', normalizedType: 'string', description: 'AWS region for resources' }),
    ];
    const out = generateTfvars(variables, { region: 'us-east-1' });
    expect(out).toContain('# AWS region for resources');
    // Comment must precede the assignment
    const commentIdx = out.indexOf('# AWS region');
    const assignIdx = out.indexOf('region =');
    expect(commentIdx).toBeLessThan(assignIdx);
  });

  it('IT-1909: omits comment when description is null', () => {
    const variables = [v({ name: 'region', normalizedType: 'string', description: null })];
    const out = generateTfvars(variables, { region: 'us-east-1' });
    expect(out).not.toContain('#');
  });

  it('IT-1910: trims trailing newlines from final output', () => {
    const variables = [v({ name: 'a', normalizedType: 'string' })];
    const out = generateTfvars(variables, { a: 'x' });
    expect(out.endsWith('\n')).toBe(false);
  });
});
