import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionError, NomadApiError, NotFoundError } from '../src/errors.js';
import { NomadHttpClient } from '../src/http.js';

describe('NomadHttpClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Constructor
  // ----------------------------------------------------------------
  describe('constructor', () => {
    it('uses default address, namespace when no options provided', () => {
      const client = new NomadHttpClient();
      // Verify defaults through getters
      expect(client.configuredNamespace).toBe('default');
      expect(client.configuredToken).toBeUndefined();
      expect(client.wsBaseUrl).toBe('ws://127.0.0.1:4646');
    });

    it('sets baseUrl, token, namespace, region from options', () => {
      const client = new NomadHttpClient({
        address: 'https://nomad.example.com:4646',
        token: 'secret-token',
        namespace: 'engineering',
        region: 'us-east-1',
      });
      expect(client.configuredNamespace).toBe('engineering');
      expect(client.configuredToken).toBe('secret-token');
      expect(client.wsBaseUrl).toBe('wss://nomad.example.com:4646');
    });

    it('strips trailing slash from address', () => {
      const client = new NomadHttpClient({ address: 'http://nomad.local:4646/' });
      // wsBaseUrl derives from baseUrl, so trailing slash should be gone
      expect(client.wsBaseUrl).toBe('ws://nomad.local:4646');
    });
  });

  // ----------------------------------------------------------------
  // wsBaseUrl getter
  // ----------------------------------------------------------------
  describe('wsBaseUrl', () => {
    it('converts http to ws', () => {
      const client = new NomadHttpClient({ address: 'http://localhost:4646' });
      expect(client.wsBaseUrl).toBe('ws://localhost:4646');
    });

    it('converts https to wss', () => {
      const client = new NomadHttpClient({ address: 'https://nomad.prod:4646' });
      expect(client.wsBaseUrl).toBe('wss://nomad.prod:4646');
    });
  });

  // ----------------------------------------------------------------
  // configuredNamespace getter
  // ----------------------------------------------------------------
  describe('configuredNamespace', () => {
    it('returns configured namespace', () => {
      const client = new NomadHttpClient({ namespace: 'dev' });
      expect(client.configuredNamespace).toBe('dev');
    });

    it('returns default when not configured', () => {
      const client = new NomadHttpClient();
      expect(client.configuredNamespace).toBe('default');
    });
  });

  // ----------------------------------------------------------------
  // configuredToken getter
  // ----------------------------------------------------------------
  describe('configuredToken', () => {
    it('returns undefined when no token set', () => {
      const client = new NomadHttpClient();
      expect(client.configuredToken).toBeUndefined();
    });

    it('returns the configured token', () => {
      const client = new NomadHttpClient({ token: 'my-token' });
      expect(client.configuredToken).toBe('my-token');
    });
  });

  // ----------------------------------------------------------------
  // request()
  // ----------------------------------------------------------------
  describe('request()', () => {
    it('returns parsed JSON on successful response', async () => {
      const payload = { ID: 'job-1', Name: 'test' };
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new NomadHttpClient();
      const result = await client.request('GET', '/v1/jobs');
      expect(result).toEqual(payload);
    });

    it('sets X-Nomad-Token header when token is configured', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const client = new NomadHttpClient({ token: 'acl-token-123' });
      await client.request('GET', '/v1/jobs');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Nomad-Token']).toBe('acl-token-123');
    });

    it('does not set X-Nomad-Token when no token is configured', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const client = new NomadHttpClient();
      await client.request('GET', '/v1/jobs');

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Nomad-Token']).toBeUndefined();
    });

    it('includes namespace and region query params', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const client = new NomadHttpClient({
        namespace: 'production',
        region: 'us-west-2',
      });
      await client.request('GET', '/v1/jobs');

      const [url] = mockFetch.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('namespace')).toBe('production');
      expect(parsedUrl.searchParams.get('region')).toBe('us-west-2');
    });

    it('includes namespace but not region when region is not set', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const client = new NomadHttpClient({ namespace: 'staging' });
      await client.request('GET', '/v1/jobs');

      const [url] = mockFetch.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('namespace')).toBe('staging');
      expect(parsedUrl.searchParams.has('region')).toBe(false);
    });

    it('throws NotFoundError on 404 response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('not found', { status: 404, statusText: 'Not Found' })
      );

      const client = new NomadHttpClient();
      await expect(client.request('GET', '/v1/job/missing')).rejects.toThrow(NotFoundError);
    });

    it('throws NomadApiError on non-ok response (not 404)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('forbidden', { status: 403, statusText: 'Forbidden' })
      );

      const client = new NomadHttpClient();
      await expect(client.request('GET', '/v1/jobs')).rejects.toThrow(NomadApiError);
      try {
        await client.request('GET', '/v1/jobs');
      } catch (_e) {
        // Need a fresh mock for the second call
      }
    });

    it('throws NomadApiError with correct statusCode on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('server error', { status: 500, statusText: 'Internal Server Error' })
      );

      const client = new NomadHttpClient();
      try {
        await client.request('GET', '/v1/jobs');
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(NomadApiError);
        expect((e as NomadApiError).statusCode).toBe(500);
      }
    });

    it('throws NomadApiError with response preview when JSON is unparseable', async () => {
      mockFetch.mockResolvedValueOnce(new Response('this is not json {{{{', { status: 200 }));

      const client = new NomadHttpClient();
      try {
        await client.request('GET', '/v1/jobs');
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(NomadApiError);
        expect((e as NomadApiError).message).toContain('Failed to parse JSON');
        expect((e as NomadApiError).message).toContain('this is not json');
      }
    });

    it('returns null for empty response body', async () => {
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const client = new NomadHttpClient();
      const result = await client.request('GET', '/v1/jobs');
      expect(result).toBeNull();
    });

    it('throws ConnectionError on network error', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const client = new NomadHttpClient();
      await expect(client.request('GET', '/v1/jobs')).rejects.toThrow(ConnectionError);
    });

    it('throws NomadApiError with 408 on timeout (AbortError)', async () => {
      // Simulate AbortError
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      mockFetch.mockRejectedValueOnce(abortError);

      const client = new NomadHttpClient();
      try {
        await client.request('GET', '/v1/jobs', { timeout: 100 });
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(NomadApiError);
        expect((e as NomadApiError).statusCode).toBe(408);
        expect((e as NomadApiError).message).toContain('timed out');
      }
    });

    it('passes body as JSON string for POST requests', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ EvalID: 'eval-1' }), { status: 200 })
      );

      const client = new NomadHttpClient();
      await client.request('POST', '/v1/jobs', { body: { Job: { ID: 'test' } } });

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.method).toBe('POST');
      expect(JSON.parse(fetchInit.body)).toEqual({ Job: { ID: 'test' } });
    });

    it('includes extra query parameters', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const client = new NomadHttpClient();
      await client.request('GET', '/v1/jobs', { query: { prefix: 'agentpane-' } });

      const [url] = mockFetch.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('prefix')).toBe('agentpane-');
    });
  });

  // ----------------------------------------------------------------
  // blockingQuery()
  // ----------------------------------------------------------------
  describe('blockingQuery()', () => {
    it('returns data and parsed X-Nomad-Index header', async () => {
      const payload = [{ ID: 'alloc-1' }];
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'X-Nomad-Index': '42' },
        })
      );

      const client = new NomadHttpClient();
      const result = await client.blockingQuery('/v1/job/test/allocations', 10);

      expect(result.data).toEqual(payload);
      expect(result.index).toBe(42);
    });

    it('includes index and wait query params', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'X-Nomad-Index': '0' },
        })
      );

      const client = new NomadHttpClient();
      await client.blockingQuery('/v1/job/test/allocations', 5, '10s');

      const [url] = mockFetch.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('index')).toBe('5');
      expect(parsedUrl.searchParams.get('wait')).toBe('10s');
    });

    it('uses default wait timeout when not specified', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'X-Nomad-Index': '0' },
        })
      );

      const client = new NomadHttpClient();
      await client.blockingQuery('/v1/job/test/allocations', 0);

      const [url] = mockFetch.mock.calls[0];
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get('wait')).toBe('30s');
    });

    it('throws NomadApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('internal error', { status: 500, statusText: 'Internal Server Error' })
      );

      const client = new NomadHttpClient();
      try {
        await client.blockingQuery('/v1/job/test/allocations', 0);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(NomadApiError);
        expect((e as NomadApiError).statusCode).toBe(500);
        expect((e as NomadApiError).message).toContain('Blocking query failed');
      }
    });

    it('throws ConnectionError on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network unavailable'));

      const client = new NomadHttpClient();
      await expect(client.blockingQuery('/v1/job/test/allocations', 0)).rejects.toThrow(
        ConnectionError
      );
    });

    it('defaults X-Nomad-Index to index + 1 when header is missing', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const client = new NomadHttpClient();
      const result = await client.blockingQuery('/v1/job/test/allocations', 0);
      expect(result.index).toBe(1);
    });

    it('sets X-Nomad-Token header when token is configured', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'X-Nomad-Index': '1' },
        })
      );

      const client = new NomadHttpClient({ token: 'blocking-token' });
      await client.blockingQuery('/v1/job/test/allocations', 0);

      const [, fetchInit] = mockFetch.mock.calls[0];
      expect(fetchInit.headers['X-Nomad-Token']).toBe('blocking-token');
    });

    it('throws NomadApiError when blocking query response is not valid JSON', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('not json {{{', {
          status: 200,
          headers: { 'X-Nomad-Index': '5' },
        })
      );

      const client = new NomadHttpClient();
      await expect(client.blockingQuery('/v1/job/test', 0)).rejects.toThrow(/Failed to parse/);
    });
  });
});
