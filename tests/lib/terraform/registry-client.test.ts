import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryConfig } from '../../../src/lib/terraform/registry-client';
import {
  getModuleDetail,
  listRegistryModules,
  syncAllModules,
} from '../../../src/lib/terraform/registry-client';

const mockConfig: RegistryConfig = {
  baseUrl: 'https://app.terraform.io',
  orgName: 'test-org',
  token: 'test-token-123',
};

// Helper to create a mock Response
function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('listRegistryModules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches all modules from a single page', async () => {
    const modules = [
      {
        id: 'mod-1',
        type: 'registry-modules',
        attributes: {
          name: 'vpc',
          namespace: 'test-org',
          provider: 'aws',
          status: 'setup_complete',
          'version-statuses': [{ version: '1.0.0', status: 'ok' }],
        },
      },
    ];

    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        data: modules,
        meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRegistryModules(mockConfig);

    expect(result).toHaveLength(1);
    expect(result[0].attributes.name).toBe('vpc');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify auth header
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe('Bearer test-token-123');
  });

  it('paginates through multiple pages', async () => {
    const page1Modules = [
      {
        id: 'mod-1',
        type: 'registry-modules',
        attributes: { name: 'vpc', namespace: 'test-org', provider: 'aws', status: 'ok' },
      },
    ];
    const page2Modules = [
      {
        id: 'mod-2',
        type: 'registry-modules',
        attributes: { name: 'ecs', namespace: 'test-org', provider: 'aws', status: 'ok' },
      },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          data: page1Modules,
          meta: { pagination: { 'current-page': 1, 'total-pages': 2, 'total-count': 2 } },
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          data: page2Modules,
          meta: { pagination: { 'current-page': 2, 'total-pages': 2, 'total-count': 2 } },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRegistryModules(mockConfig);

    expect(result).toHaveLength(2);
    expect(result[0].attributes.name).toBe('vpc');
    expect(result[1].attributes.name).toBe('ecs');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no modules exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({
          data: [],
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 0 } },
        })
      )
    );

    const result = await listRegistryModules(mockConfig);
    expect(result).toEqual([]);
  });

  it('throws on non-OK HTTP responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ errors: [{ detail: 'Unauthorized' }] }, 401))
    );

    await expect(listRegistryModules(mockConfig)).rejects.toThrow('HCP Terraform API error (401)');
  });

  it('retries on 429 and succeeds', async () => {
    const modules = [
      {
        id: 'mod-1',
        type: 'registry-modules',
        attributes: { name: 'vpc', namespace: 'test-org', provider: 'aws', status: 'ok' },
      },
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(
        mockResponse({
          data: modules,
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRegistryModules(mockConfig);
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({}, 429, { 'retry-after': '0' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listRegistryModules(mockConfig)).rejects.toThrow('rate limit exceeded');
    // MAX_RETRIES = 3, initial attempt + 3 retries = 4 calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('getModuleDetail', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed module detail with inputs and outputs', async () => {
    const detailResponse = {
      id: 'test-org/vpc/aws/1.0.0',
      description: 'VPC module',
      source: 'https://github.com/test-org/terraform-aws-vpc',
      published_at: '2025-01-01T00:00:00Z',
      root: {
        inputs: [
          { name: 'cidr_block', type: 'string', description: 'VPC CIDR', required: true },
          {
            name: 'enable_dns',
            type: 'bool',
            description: 'Enable DNS',
            default: 'true',
            required: false,
          },
        ],
        outputs: [{ name: 'vpc_id', description: 'VPC ID' }],
        provider_dependencies: [
          { name: 'aws', namespace: 'hashicorp', source: 'hashicorp/aws', version: '~> 5.0' },
        ],
        readme: '# VPC Module',
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(detailResponse)));

    const result = await getModuleDetail(mockConfig, 'test-org', 'vpc', 'aws', '1.0.0');

    expect(result.source).toBe('https://github.com/test-org/terraform-aws-vpc');
    expect(result.description).toBe('VPC module');
    expect(result.readme).toBe('# VPC Module');
    expect(result.publishedAt).toBe('2025-01-01T00:00:00Z');

    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0]).toMatchObject({
      name: 'cidr_block',
      type: 'string',
      required: true,
    });

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ name: 'vpc_id', description: 'VPC ID' });

    expect(result.dependencies).toEqual(['hashicorp/aws']);
  });

  it('handles module with no root section', async () => {
    const detailResponse = {
      id: 'test-org/simple/aws/1.0.0',
      source: 'git::https://github.com/test-org/simple',
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(detailResponse)));

    const result = await getModuleDetail(mockConfig, 'test-org', 'simple', 'aws', '1.0.0');

    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(result.dependencies).toEqual([]);
    expect(result.readme).toBeNull();
    expect(result.description).toBeNull();
  });

  it('constructs the correct V1 API URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    await getModuleDetail(mockConfig, 'my-org', 'my-module', 'aws', '2.0.0');

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      'https://app.terraform.io/api/registry/v1/modules/my-org/my-module/aws/2.0.0'
    );
    // V1 API uses application/json content type
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });
});

describe('syncAllModules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs modules with detail fetch', async () => {
    const listResponse = {
      data: [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'vpc',
            namespace: 'test-org',
            provider: 'aws',
            status: 'ok',
            'version-statuses': [{ version: '1.2.0', status: 'ok' }],
          },
        },
      ],
      meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
    };

    const detailResponse = {
      id: 'test-org/vpc/aws/1.2.0',
      description: 'VPC module',
      source: 'https://github.com/test-org/vpc',
      published_at: '2025-06-01T00:00:00Z',
      root: {
        inputs: [{ name: 'cidr', type: 'string', required: true }],
        outputs: [{ name: 'vpc_id' }],
        provider_dependencies: [],
        readme: '# VPC',
      },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(listResponse))
      .mockResolvedValueOnce(mockResponse(detailResponse));
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncAllModules(mockConfig);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vpc');
    expect(result[0].version).toBe('1.2.0');
    expect(result[0].source).toBe('app.terraform.io/test-org/vpc/aws');
    expect(result[0].description).toBe('VPC module');
    expect(result[0].inputs).toHaveLength(1);
    expect(result[0].outputs).toHaveLength(1);
  });

  it('skips modules with no version', async () => {
    const listResponse = {
      data: [
        {
          id: 'mod-no-ver',
          type: 'registry-modules',
          attributes: {
            name: 'empty',
            namespace: 'test-org',
            provider: 'aws',
            status: 'pending',
            'version-statuses': [],
          },
        },
      ],
      meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(listResponse)));

    const result = await syncAllModules(mockConfig);
    expect(result).toHaveLength(0);
  });

  it('falls back to basic info when detail fetch fails', async () => {
    const listResponse = {
      data: [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'network',
            namespace: 'test-org',
            provider: 'azurerm',
            status: 'ok',
            'version-statuses': [{ version: '3.0.0', status: 'ok' }],
          },
        },
      ],
      meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(listResponse))
      .mockResolvedValueOnce(mockResponse({ errors: ['Forbidden'] }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncAllModules(mockConfig);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('network');
    expect(result[0].version).toBe('3.0.0');
    expect(result[0].source).toBe('app.terraform.io/test-org/network/azurerm');
    // Fallback: no detail data
    expect(result[0].description).toBeNull();
    expect(result[0].inputs).toEqual([]);
    expect(result[0].outputs).toEqual([]);
    expect(result[0].dependencies).toEqual([]);
  });

  it('handles multiple modules in batches', async () => {
    const modules = Array.from({ length: 5 }, (_, i) => ({
      id: `mod-${i}`,
      type: 'registry-modules',
      attributes: {
        name: `module-${i}`,
        namespace: 'test-org',
        provider: 'aws',
        status: 'ok',
        'version-statuses': [{ version: '1.0.0', status: 'ok' }],
      },
    }));

    const listResponse = {
      data: modules,
      meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 5 } },
    };

    const fetchMock = vi
      .fn()
      // First call: list
      .mockResolvedValueOnce(mockResponse(listResponse))
      // Remaining calls: detail for each module
      .mockResolvedValue(
        mockResponse({
          id: 'x',
          source: 'src',
          root: { inputs: [], outputs: [], provider_dependencies: [] },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncAllModules(mockConfig);

    expect(result).toHaveLength(5);
    // 1 list call + 5 detail calls = 6 total
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('returns empty array when no modules in registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({
          data: [],
          meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 0 } },
        })
      )
    );

    const result = await syncAllModules(mockConfig);
    expect(result).toEqual([]);
  });

  it('picks the first "ok" version from version-statuses', async () => {
    const listResponse = {
      data: [
        {
          id: 'mod-1',
          type: 'registry-modules',
          attributes: {
            name: 'vpc',
            namespace: 'test-org',
            provider: 'aws',
            status: 'ok',
            'version-statuses': [
              { version: '2.0.0', status: 'pending' },
              { version: '1.5.0', status: 'ok' },
              { version: '1.0.0', status: 'ok' },
            ],
          },
        },
      ],
      meta: { pagination: { 'current-page': 1, 'total-pages': 1, 'total-count': 1 } },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(listResponse))
      .mockResolvedValueOnce(mockResponse({ id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await syncAllModules(mockConfig);
    expect(result[0].version).toBe('1.5.0');
  });
});
