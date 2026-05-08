/**
 * Integration coverage for the small lib/api utility modules:
 * - cursor.ts (encode/decode round-trip + base64url variants)
 * - pagination.ts (validateCursor, paginate, decodeRequestCursor)
 * - middleware.ts (withErrorHandling unhandled error wrap)
 * - dev-auth.ts (isDevAuthAllowed / isStrictDevEnv env handling)
 * - validation.ts (parseBody / parseQuery Result envelopes)
 *
 * These modules have unit-project tests but are at 0% in the integration
 * project coverage report. Re-running them here brings the integration
 * combined coverage up.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../src/lib/api/cursor';
import { isDevAuthAllowed, isStrictDevEnv } from '../../src/lib/api/dev-auth';
import { withErrorHandling } from '../../src/lib/api/middleware';
import { decodeRequestCursor, paginate, validateCursor } from '../../src/lib/api/pagination';
import { parseBody, parseQuery } from '../../src/lib/api/validation';

describe('lib/api/cursor', () => {
  it('encodes and decodes a payload symmetrically', () => {
    const cursor = encodeCursor({
      id: 'abc',
      sortValue: 42,
      sortField: 'createdAt',
      order: 'desc',
    });
    const decoded = decodeCursor(cursor);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.id).toBe('abc');
      expect(decoded.value.sortValue).toBe(42);
      expect(decoded.value.sortField).toBe('createdAt');
      expect(decoded.value.order).toBe('desc');
    }
  });

  it('handles base64url alphabet (-, _) and missing padding', () => {
    const cursor = encodeCursor({
      id: 'with/special?+/=',
      sortValue: 'string-value',
      sortField: 'updatedAt',
      order: 'asc',
    });
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(cursor).not.toContain('=');
    const decoded = decodeCursor(cursor);
    expect(decoded.ok).toBe(true);
  });

  it('returns INVALID_CURSOR for malformed base64', () => {
    const result = decodeCursor('not-base64!!!');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_CURSOR');
    }
  });

  it('returns INVALID_CURSOR when JSON shape mismatches schema', () => {
    const fake = Buffer.from(JSON.stringify({ id: 'a' }), 'utf-8').toString('base64');
    const result = decodeCursor(fake);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVALID_CURSOR');
    }
  });

  it('encodes null sortValue', () => {
    const cursor = encodeCursor({ id: 'x', sortValue: null, sortField: 'name', order: 'asc' });
    const decoded = decodeCursor(cursor);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.sortValue).toBeNull();
  });
});

describe('lib/api/pagination', () => {
  it('validateCursor rejects mismatched sortField', () => {
    const cursor = encodeCursor({ id: 'a', sortValue: 1, sortField: 'createdAt', order: 'asc' });
    const result = validateCursor(cursor, { sortField: 'updatedAt', order: 'asc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('INVALID_CURSOR');
  });

  it('validateCursor rejects mismatched order', () => {
    const cursor = encodeCursor({ id: 'a', sortValue: 1, sortField: 'createdAt', order: 'asc' });
    const result = validateCursor(cursor, { sortField: 'createdAt', order: 'desc' });
    expect(result.ok).toBe(false);
  });

  it('validateCursor accepts matching cursor', () => {
    const cursor = encodeCursor({ id: 'a', sortValue: 1, sortField: 'createdAt', order: 'asc' });
    const result = validateCursor(cursor, { sortField: 'createdAt', order: 'asc' });
    expect(result.ok).toBe(true);
  });

  it('paginate with hasMore=false sets nextCursor to null', () => {
    const items = [{ id: '1', createdAt: 'a' }];
    const result = paginate(items, { limit: 10, sortField: 'createdAt', order: 'asc' });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
  });

  it('paginate with hasMore=true slices off overflow row and emits cursor', () => {
    const items = [
      { id: '1', createdAt: 'a' },
      { id: '2', createdAt: 'b' },
      { id: '3', createdAt: 'c' },
    ];
    const result = paginate(items, { limit: 2, sortField: 'createdAt', order: 'asc' });
    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it('paginate carries totalCount when provided', () => {
    const items = [{ id: '1', createdAt: 'a' }];
    const result = paginate(items, {
      limit: 10,
      sortField: 'createdAt',
      order: 'asc',
      totalCount: 7,
    });
    expect(result.totalCount).toBe(7);
  });

  it('decodeRequestCursor returns null for first-page (undefined cursor)', () => {
    const result = decodeRequestCursor(undefined, { sortField: 'createdAt', order: 'asc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('decodeRequestCursor surfaces INVALID_CURSOR for tampered cursor', () => {
    const result = decodeRequestCursor('not-real', { sortField: 'createdAt', order: 'asc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('INVALID_CURSOR');
  });

  it('decodeRequestCursor returns the payload when the cursor matches', () => {
    const cursor = encodeCursor({ id: 'a', sortValue: 1, sortField: 'createdAt', order: 'asc' });
    const result = decodeRequestCursor(cursor, { sortField: 'createdAt', order: 'asc' });
    expect(result.ok).toBe(true);
    if (result.ok && result.value) expect(result.value.id).toBe('a');
  });
});

describe('lib/api/middleware withErrorHandling', () => {
  it('forwards a successful Response from the handler', async () => {
    const handler = withErrorHandling(async () => new Response('ok', { status: 200 }));
    const response = await handler({ request: new Request('http://test/'), params: {} });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('catches thrown errors and returns 500 API_UNHANDLED_ERROR', async () => {
    const handler = withErrorHandling(async () => {
      throw new Error('boom');
    });
    const response = await handler({ request: new Request('http://test/'), params: {} });
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      ok: false;
      error: { code: string; details: { error: string } };
    };
    expect(body.error.code).toBe('API_UNHANDLED_ERROR');
    expect(body.error.details.error).toContain('boom');
  });

  it('threads params + requestId into the context object', async () => {
    let observed: { requestId: string; params: Record<string, string | undefined> } | null = null;
    const handler = withErrorHandling(async ({ context }) => {
      observed = { requestId: context.requestId, params: context.params ?? {} };
      return new Response('seen', { status: 200 });
    });
    await handler({
      request: new Request('http://test/foo'),
      params: { id: 'cs-1' },
    });
    expect(observed!.requestId).toBeTruthy();
    expect(observed!.params).toEqual({ id: 'cs-1' });
  });
});

describe('lib/api/dev-auth', () => {
  it('isDevAuthAllowed returns false when SKIP_AUTH unset', () => {
    expect(isDevAuthAllowed({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('isDevAuthAllowed returns true when SKIP_AUTH=true and not production', () => {
    expect(
      isDevAuthAllowed({ SKIP_AUTH: 'true', NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(isDevAuthAllowed({ SKIP_AUTH: 'true', NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(
      true
    );
  });

  it('isDevAuthAllowed always returns false when NODE_ENV=production', () => {
    expect(
      isDevAuthAllowed({ SKIP_AUTH: 'true', NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('isDevAuthAllowed only opts in for SKIP_AUTH="true" exactly', () => {
    expect(isDevAuthAllowed({ SKIP_AUTH: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isDevAuthAllowed({ SKIP_AUTH: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('isStrictDevEnv only true when NODE_ENV is exactly "development"', () => {
    expect(isStrictDevEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isStrictDevEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isStrictDevEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isStrictDevEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('lib/api/validation', () => {
  const schema = z.object({ name: z.string(), age: z.number() });

  it('parseBody returns ok with parsed value when JSON matches schema', async () => {
    const req = new Request('http://test/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', age: 30 }),
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseBody(req, schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Alice');
      expect(result.value.age).toBe(30);
    }
  });

  it('parseBody returns VALIDATION_ERROR when schema fails', async () => {
    const req = new Request('http://test/', {
      method: 'POST',
      body: JSON.stringify({ name: 123 }),
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('parseBody returns VALIDATION_ERROR when JSON is invalid', async () => {
    const req = new Request('http://test/', {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('parseQuery reads URLSearchParams as a flat object and validates', () => {
    const params = new URLSearchParams('limit=5&offset=10');
    const querySchema = z.object({ limit: z.string(), offset: z.string() });
    const result = parseQuery(params, querySchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe('5');
      expect(result.value.offset).toBe('10');
    }
  });

  it('parseQuery returns VALIDATION_ERROR when schema fails', () => {
    const params = new URLSearchParams();
    const required = z.object({ id: z.string() });
    const result = parseQuery(params, required);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
