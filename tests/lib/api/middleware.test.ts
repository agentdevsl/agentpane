import { describe, expect, it } from 'vitest';
import type { ApiContext, ApiHandler } from '@/lib/api/middleware';
import { withErrorHandling } from '@/lib/api/middleware';

describe('withErrorHandling', () => {
  function makeRequest(url = 'http://localhost/test', method = 'GET'): Request {
    return new Request(url, { method });
  }

  describe('context generation', () => {
    it('generates a requestId as a valid UUID', async () => {
      let capturedContext: ApiContext | undefined;

      const handler: ApiHandler = async ({ context }) => {
        capturedContext = context;
        return Response.json({ ok: true });
      };

      const wrapped = withErrorHandling(handler);
      await wrapped({ request: makeRequest(), params: {} });

      expect(capturedContext).toBeDefined();
      expect(capturedContext!.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('sets startedAt to a recent timestamp', async () => {
      let capturedContext: ApiContext | undefined;
      const before = Date.now();

      const handler: ApiHandler = async ({ context }) => {
        capturedContext = context;
        return Response.json({ ok: true });
      };

      const wrapped = withErrorHandling(handler);
      await wrapped({ request: makeRequest(), params: {} });

      const after = Date.now();
      expect(capturedContext!.startedAt).toBeGreaterThanOrEqual(before);
      expect(capturedContext!.startedAt).toBeLessThanOrEqual(after);
    });

    it('passes route params to the context', async () => {
      let capturedContext: ApiContext | undefined;

      const handler: ApiHandler = async ({ context }) => {
        capturedContext = context;
        return Response.json({ ok: true });
      };

      const wrapped = withErrorHandling(handler);
      await wrapped({
        request: makeRequest(),
        params: { id: 'abc123', action: 'start' },
      });

      expect(capturedContext!.params).toEqual({ id: 'abc123', action: 'start' });
    });
  });

  describe('success passthrough', () => {
    it('returns the handler response unchanged on success', async () => {
      const handler: ApiHandler = async () => {
        return Response.json({ data: 'hello' }, { status: 200 });
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ data: 'hello' });
    });

    it('preserves custom status codes from handler', async () => {
      const handler: ApiHandler = async () => {
        return Response.json({ created: true }, { status: 201 });
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });

      expect(response.status).toBe(201);
    });

    it('passes the original request to the handler', async () => {
      let capturedUrl: string | undefined;

      const handler: ApiHandler = async ({ request }) => {
        capturedUrl = request.url;
        return Response.json({ ok: true });
      };

      const wrapped = withErrorHandling(handler);
      await wrapped({
        request: makeRequest('http://localhost/api/codespaces'),
        params: {},
      });

      expect(capturedUrl).toBe('http://localhost/api/codespaces');
    });
  });

  describe('error catching', () => {
    it('returns 500 status for unhandled errors', async () => {
      const handler: ApiHandler = async () => {
        throw new Error('Something went wrong');
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });

      expect(response.status).toBe(500);
    });

    it('returns a failure response body with API_UNHANDLED_ERROR code', async () => {
      const handler: ApiHandler = async () => {
        throw new Error('Database connection failed');
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });
      const body = await response.json();

      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('API_UNHANDLED_ERROR');
      expect(body.error.message).toBe('Unhandled API error');
    });

    it('includes the error string in details', async () => {
      const handler: ApiHandler = async () => {
        throw new Error('Specific failure reason');
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });
      const body = await response.json();

      expect(body.error.details.error).toContain('Specific failure reason');
    });

    it('handles non-Error thrown values (string)', async () => {
      const handler: ApiHandler = async () => {
        throw 'a string error';
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error.details.error).toContain('a string error');
    });

    it('handles non-Error thrown values (number)', async () => {
      const handler: ApiHandler = async () => {
        throw 42;
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error.details.error).toBe('42');
    });

    it('handles null/undefined thrown values', async () => {
      const handler: ApiHandler = async () => {
        throw null;
      };

      const wrapped = withErrorHandling(handler);
      const response = await wrapped({ request: makeRequest(), params: {} });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
    });
  });

  describe('unique requestId per call', () => {
    it('generates different requestIds for consecutive calls', async () => {
      const ids: string[] = [];

      const handler: ApiHandler = async ({ context }) => {
        ids.push(context.requestId);
        return Response.json({ ok: true });
      };

      const wrapped = withErrorHandling(handler);
      await wrapped({ request: makeRequest(), params: {} });
      await wrapped({ request: makeRequest(), params: {} });
      await wrapped({ request: makeRequest(), params: {} });

      expect(new Set(ids).size).toBe(3);
    });
  });
});
