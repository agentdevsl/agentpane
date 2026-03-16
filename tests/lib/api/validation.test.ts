import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBody, parseQuery } from '@/lib/api/validation';

describe('parseBody', () => {
  const schema = z.object({
    name: z.string().min(1),
    count: z.number().min(0),
  });

  function makeRequest(body: unknown): Request {
    return new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns ok result for valid input', async () => {
    const request = makeRequest({ name: 'test', count: 5 });
    const result = await parseBody(request, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test', count: 5 });
    }
  });

  it('returns error result for missing required fields', async () => {
    const request = makeRequest({ count: 5 });
    const result = await parseBody(request, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.status).toBe(400);
    }
  });

  it('returns error result for invalid field types', async () => {
    const request = makeRequest({ name: 'test', count: 'not-a-number' });
    const result = await parseBody(request, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns error result for constraint violations (min)', async () => {
    const request = makeRequest({ name: '', count: -1 });
    const result = await parseBody(request, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.details).toBeDefined();
    }
  });

  it('returns error when request body is not valid JSON', async () => {
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    });

    const result = await parseBody(request, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('preserves extra fields in the input when schema does not strip them', async () => {
    const looseSchema = z.object({ name: z.string() }).passthrough();
    const request = makeRequest({ name: 'test', extra: 'value' });
    const result = await parseBody(request, looseSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test', extra: 'value' });
    }
  });

  it('works with optional fields in schema', async () => {
    const optionalSchema = z.object({
      name: z.string(),
      description: z.string().optional(),
    });
    const request = makeRequest({ name: 'test' });
    const result = await parseBody(request, optionalSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: 'test' });
    }
  });
});

describe('parseQuery', () => {
  const schema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    search: z.string().optional(),
  });

  it('returns ok result for valid query parameters', () => {
    const params = new URLSearchParams({ page: '2', limit: '50' });
    const result = parseQuery(params, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.page).toBe(2);
      expect(result.value.limit).toBe(50);
    }
  });

  it('applies defaults when query parameters are missing', () => {
    const params = new URLSearchParams();
    const result = parseQuery(params, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.page).toBe(1);
      expect(result.value.limit).toBe(20);
    }
  });

  it('coerces string values to numbers when schema uses z.coerce', () => {
    const params = new URLSearchParams({ page: '3', limit: '10' });
    const result = parseQuery(params, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.page).toBe('number');
      expect(typeof result.value.limit).toBe('number');
    }
  });

  it('returns error when numeric constraints are violated', () => {
    const params = new URLSearchParams({ page: '0', limit: '200' });
    const result = parseQuery(params, schema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.status).toBe(400);
    }
  });

  it('passes through optional string parameters', () => {
    const params = new URLSearchParams({ search: 'hello' });
    const result = parseQuery(params, schema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.search).toBe('hello');
    }
  });

  it('returns error for invalid enum values', () => {
    const enumSchema = z.object({
      status: z.enum(['active', 'inactive']),
    });
    const params = new URLSearchParams({ status: 'unknown' });
    const result = parseQuery(params, enumSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
