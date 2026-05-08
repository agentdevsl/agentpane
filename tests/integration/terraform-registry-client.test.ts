/**
 * Integration tests for `registry-client.ts` — HCP Terraform Registry HTTP client.
 *
 * Mocks global `fetch` to drive the JSONAPI v2 list endpoint, the Registry v1
 * detail endpoint, retry/back-off behaviour, and error paths. No live
 * network calls.
 *
 * IT-IDs: IT-1950 to IT-1969
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getModuleDetail,
  listRegistryModules,
  type RegistryConfig,
  syncAllModules,
} from '../../src/lib/terraform/registry-client';

const config: RegistryConfig = {
  baseUrl: 'https://app.terraform.io',
  orgName: 'test-org',
  token: 'fake-token',
};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function errorResponse(
  status: number,
  body = 'something failed',
  headers: Record<string, string> = {}
) {
  return new Response(body, { status, headers });
}

describe('registry-client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        data: [],
        meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 0 } },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  // ───────────────────────────────────────────────────────────────────
  // listRegistryModules
  // ───────────────────────────────────────────────────────────────────

  describe('listRegistryModules (IT-1950)', () => {
    it('IT-1950a: fetches first page when total-pages is 1', async () => {
      const modules = [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'vpc',
            namespace: 'test-org',
            provider: 'aws',
            status: 'published',
            'version-statuses': [{ version: '1.0.0', status: 'ok' }],
          },
        },
      ];
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          data: modules,
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
        })
      );

      const result = await listRegistryModules(config);
      expect(result).toHaveLength(1);
      expect(result[0]!.attributes.name).toBe('vpc');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = (fetchSpy.mock.calls[0]![0] as string) ?? '';
      expect(calledUrl).toContain('/api/v2/organizations/test-org/registry-modules');
      expect(calledUrl).toContain('page[number]=1');
      expect(calledUrl).toContain('page[size]=100');
    });

    it('IT-1950b: paginates through all pages when total-pages > 1', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                id: 'a',
                type: 'registry-modules',
                attributes: { name: 'a', namespace: 'ns', provider: 'aws', status: 'published' },
              },
            ],
            meta: { pagination: { 'current-page': 1, 'total-pages': 2, 'total-count': 2 } },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                id: 'b',
                type: 'registry-modules',
                attributes: { name: 'b', namespace: 'ns', provider: 'aws', status: 'published' },
              },
            ],
            meta: { pagination: { 'current-page': 2, 'total-pages': 2, 'total-count': 2 } },
          })
        );

      const result = await listRegistryModules(config);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.attributes.name)).toEqual(['a', 'b']);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('IT-1950c: handles missing meta.pagination by treating it as a single page', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [] })); // no meta
      const result = await listRegistryModules(config);
      expect(result).toEqual([]);
    });

    it('IT-1950d: passes Bearer token in Authorization header', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await listRegistryModules(config);
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer fake-token');
      expect(headers['Content-Type']).toBe('application/vnd.api+json');
    });

    it('IT-1950e: raises an error when API returns a non-OK non-429 response', async () => {
      fetchSpy.mockResolvedValueOnce(errorResponse(500, 'Internal server error'));
      await expect(listRegistryModules(config)).rejects.toThrow(/HCP Terraform API error \(500\)/);
    });

    it('IT-1950f: truncates very large error bodies in the thrown message', async () => {
      const longBody = 'x'.repeat(500);
      fetchSpy.mockResolvedValueOnce(errorResponse(503, longBody));
      await expect(listRegistryModules(config)).rejects.toThrow(/\.\.\.$/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // 429 retry behaviour
  // ───────────────────────────────────────────────────────────────────

  describe('Rate-limit retries (IT-1955)', () => {
    it('IT-1955a: retries on 429 and succeeds on second attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(errorResponse(429, '', { 'retry-after': '0' }))
        .mockResolvedValueOnce(
          jsonResponse({
            data: [],
            meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 0 } },
          })
        );

      const result = await listRegistryModules(config);
      expect(result).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('IT-1955b: throws after MAX_RETRIES exhaustion (4 attempts total)', async () => {
      // 0 + 3 retries = 4 calls before throw
      fetchSpy.mockResolvedValue(errorResponse(429, '', { 'retry-after': '0' }));
      await expect(listRegistryModules(config)).rejects.toThrow(
        /rate limit exceeded after 3 retries/
      );
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('IT-1955c: uses exponential backoff when Retry-After header is missing', async () => {
      fetchSpy.mockResolvedValueOnce(errorResponse(429)).mockResolvedValueOnce(
        jsonResponse({
          data: [],
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 0 } },
        })
      );

      const start = Date.now();
      await listRegistryModules(config);
      const elapsed = Date.now() - start;
      // First retry uses 1000 * 2^0 = 1000ms
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // getModuleDetail
  // ───────────────────────────────────────────────────────────────────

  describe('getModuleDetail (IT-1960)', () => {
    it('IT-1960a: maps the v1 detail response into the expected shape', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          id: 'mod-1',
          description: 'AWS VPC module',
          source: 'github.com/test-org/vpc',
          published_at: '2026-01-01T00:00:00Z',
          root: {
            inputs: [
              {
                name: 'cidr',
                type: 'string',
                required: true,
                description: 'cidr block',
                default: '10.0.0.0/16',
              },
            ],
            outputs: [{ name: 'vpc_id', description: 'the id' }],
            provider_dependencies: [
              { namespace: 'hashicorp', name: 'aws', source: 'hashicorp/aws', version: '5.0.0' },
            ],
            readme: '# Hello',
          },
        })
      );

      const detail = await getModuleDetail(config, 'test-org', 'vpc', 'aws', '1.0.0');
      expect(detail.source).toBe('github.com/test-org/vpc');
      expect(detail.description).toBe('AWS VPC module');
      expect(detail.publishedAt).toBe('2026-01-01T00:00:00Z');
      expect(detail.readme).toBe('# Hello');
      expect(detail.inputs).toHaveLength(1);
      expect(detail.inputs[0]).toMatchObject({ name: 'cidr', required: true });
      expect(detail.outputs).toEqual([{ name: 'vpc_id', description: 'the id' }]);
      expect(detail.dependencies).toEqual(['hashicorp/aws']);
    });

    it('IT-1960b: returns sensible defaults when root is missing', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'mod-1' }));
      const detail = await getModuleDetail(config, 'ns', 'name', 'aws', '1.0.0');
      expect(detail.inputs).toEqual([]);
      expect(detail.outputs).toEqual([]);
      expect(detail.dependencies).toEqual([]);
      expect(detail.source).toBe('');
      expect(detail.description).toBeNull();
      expect(detail.readme).toBeNull();
      expect(detail.publishedAt).toBeNull();
    });

    it('IT-1960c: uses application/json content type for v1 endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'mod-1' }));
      await getModuleDetail(config, 'ns', 'name', 'aws', '1.0.0');
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('IT-1960d: encodes namespace/name/provider/version in the URL path', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'mod-1' }));
      await getModuleDetail(config, 'my org', 'my name', 'aws', '1.0.0+build');
      const url = fetchSpy.mock.calls[0]![0] as string;
      expect(url).toContain('my%20org');
      expect(url).toContain('my%20name');
      expect(url).toContain('1.0.0%2Bbuild');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // syncAllModules
  // ───────────────────────────────────────────────────────────────────

  describe('syncAllModules (IT-1965)', () => {
    it('IT-1965a: returns empty array when no raw modules', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          data: [],
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 0 } },
        })
      );
      const modules = await syncAllModules(config);
      expect(modules).toEqual([]);
    });

    it('IT-1965b: syncs all listed modules, calling detail endpoint per module', async () => {
      const rawModules = [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'vpc',
            namespace: 'test-org',
            provider: 'aws',
            status: 'published',
            'version-statuses': [{ version: '1.0.0', status: 'ok' }],
          },
        },
        {
          id: 'mod-2',
          type: 'registry-modules',
          attributes: {
            name: 'rds',
            namespace: 'test-org',
            provider: 'aws',
            status: 'published',
            'version-statuses': [{ version: '2.0.0', status: 'ok' }],
          },
        },
      ];

      // 1 call for list, 2 for detail
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            data: rawModules,
            meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 2 } },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'mod-1',
            description: 'VPC module',
            root: { inputs: [], outputs: [], provider_dependencies: [] },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'mod-2',
            description: 'RDS module',
            root: { inputs: [], outputs: [], provider_dependencies: [] },
          })
        );

      const modules = await syncAllModules(config);
      expect(modules).toHaveLength(2);
      const names = modules.map((m) => m.name).sort();
      expect(names).toEqual(['rds', 'vpc']);

      // Source uses the private-registry app.terraform.io format
      expect(modules[0]!.source).toBe('app.terraform.io/test-org/vpc/aws');
      expect(modules[0]!.description).toBe('VPC module');
    });

    it('IT-1965c: omits modules that have no version-statuses with version', async () => {
      const rawModules = [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'noversion',
            namespace: 'test-org',
            provider: 'aws',
            status: 'pending',
            'version-statuses': [],
          },
        },
      ];

      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          data: rawModules,
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
        })
      );

      const modules = await syncAllModules(config);
      expect(modules).toEqual([]);
    });

    it('IT-1965d: tolerates detail-fetch failures (logs and continues)', async () => {
      const rawModules = [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'vpc',
            namespace: 'test-org',
            provider: 'aws',
            status: 'published',
            'version-statuses': [{ version: '1.0.0', status: 'ok' }],
          },
        },
      ];

      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            data: rawModules,
            meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
          })
        )
        .mockResolvedValueOnce(errorResponse(500, 'detail fetch broken'));

      const modules = await syncAllModules(config);
      // Module is still emitted with empty inputs/outputs/dependencies fallback
      expect(modules).toHaveLength(1);
      expect(modules[0]!.name).toBe('vpc');
      expect(modules[0]!.inputs).toEqual([]);
      expect(modules[0]!.outputs).toEqual([]);
      expect(modules[0]!.dependencies).toEqual([]);
    });

    it('IT-1965e: prefers a version with status="ok" over the first available version', async () => {
      const rawModules = [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'multi',
            namespace: 'test-org',
            provider: 'aws',
            status: 'published',
            'version-statuses': [
              { version: '0.1.0', status: 'pending' },
              { version: '1.0.0', status: 'ok' },
            ],
          },
        },
      ];

      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            data: rawModules,
            meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
          })
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'mod-1', root: {} }));

      const modules = await syncAllModules(config);
      expect(modules).toHaveLength(1);
      expect(modules[0]!.version).toBe('1.0.0');
    });

    it('IT-1965f: falls back to first version when none have status="ok"', async () => {
      const rawModules = [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'pending',
            namespace: 'test-org',
            provider: 'aws',
            status: 'pending',
            'version-statuses': [{ version: '0.1.0', status: 'pending' }],
          },
        },
      ];

      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            data: rawModules,
            meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
          })
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'mod-1', root: {} }));

      const modules = await syncAllModules(config);
      expect(modules).toHaveLength(1);
      expect(modules[0]!.version).toBe('0.1.0');
    });
  });
});
