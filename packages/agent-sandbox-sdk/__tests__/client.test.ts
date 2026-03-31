import { beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted so these are available inside the vi.mock factory (which is hoisted)
const { mockCustomObjectsApi, mockVersionApi, mockApiExtApi, mockCoreApi, mockAppsApi } =
  vi.hoisted(() => ({
    mockCustomObjectsApi: {
      createNamespacedCustomObject: vi.fn(),
      getNamespacedCustomObject: vi.fn(),
      listNamespacedCustomObject: vi.fn(),
      listClusterCustomObject: vi.fn(),
      replaceNamespacedCustomObject: vi.fn(),
      patchNamespacedCustomObject: vi.fn(),
      deleteNamespacedCustomObject: vi.fn(),
    },
    mockVersionApi: {
      getCode: vi.fn(),
    },
    mockApiExtApi: {
      readCustomResourceDefinition: vi.fn(),
    },
    mockCoreApi: {
      readNamespace: vi.fn(),
    },
    mockAppsApi: {
      listNamespacedDeployment: vi.fn(),
    },
  }));

vi.mock('@kubernetes/client-node', () => {
  const apiMap: Record<string, any> = {
    CustomObjectsApi: mockCustomObjectsApi,
    VersionApi: mockVersionApi,
    ApiextensionsV1Api: mockApiExtApi,
    CoreV1Api: mockCoreApi,
    AppsV1Api: mockAppsApi,
  };

  class MockKubeConfig {
    loadFromCluster = vi.fn();
    getCurrentContext = vi.fn().mockReturnValue('test');
    getCurrentCluster = vi.fn();
    getContexts = vi.fn().mockReturnValue([]);
    makeApiClient(cls: any) {
      return apiMap[cls.name] ?? {};
    }
  }

  class CustomObjectsApi {}
  class VersionApi {}
  class ApiextensionsV1Api {}
  class CoreV1Api {}
  class AppsV1Api {}
  class Exec {}
  class Watch {}
  class V1Status {}

  return {
    KubeConfig: MockKubeConfig,
    CustomObjectsApi,
    VersionApi,
    ApiextensionsV1Api,
    CoreV1Api,
    AppsV1Api,
    Exec,
    Watch,
    V1Status,
  };
});

import { KubeConfig } from '@kubernetes/client-node';
import { AgentSandboxClient } from '../src/client.js';

describe('AgentSandboxClient', () => {
  let client: AgentSandboxClient;

  beforeEach(() => {
    vi.clearAllMocks();
    const kc = new KubeConfig();
    client = new AgentSandboxClient({
      kubeConfig: kc,
      namespace: 'test-ns',
    });
  });

  describe('construction', () => {
    it('uses provided kubeConfig and namespace', () => {
      expect(client.namespace).toBe('test-ns');
      expect(client.kubeConfig).toBeDefined();
    });

    it('defaults namespace to agentpane-sandboxes', () => {
      const kc = new KubeConfig();
      const defaultClient = new AgentSandboxClient({ kubeConfig: kc });
      expect(defaultClient.namespace).toBe('agentpane-sandboxes');
    });
  });

  describe('Sandbox CRUD', () => {
    it('createSandbox calls CustomObjectsApi with correct group/plural', async () => {
      const sandbox = {
        apiVersion: 'agents.x-k8s.io/v1alpha1',
        kind: 'Sandbox',
        metadata: { name: 'test' },
        spec: {},
      };
      mockCustomObjectsApi.createNamespacedCustomObject.mockResolvedValue(sandbox);

      const result = await client.createSandbox(sandbox as any);
      expect(result).toEqual(sandbox);
      expect(mockCustomObjectsApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'agents.x-k8s.io',
          version: 'v1alpha1',
          namespace: 'test-ns',
          plural: 'sandboxes',
        })
      );
    });

    it('createSandbox allows namespace override', async () => {
      mockCustomObjectsApi.createNamespacedCustomObject.mockResolvedValue({});

      await client.createSandbox({} as any, 'custom-ns');
      expect(mockCustomObjectsApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'custom-ns' })
      );
    });

    it('getSandbox calls get with correct params', async () => {
      const sandbox = { metadata: { name: 'my-sb' }, spec: {} };
      mockCustomObjectsApi.getNamespacedCustomObject.mockResolvedValue(sandbox);

      const result = await client.getSandbox('my-sb');
      expect(result).toEqual(sandbox);
      expect(mockCustomObjectsApi.getNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-sb',
          namespace: 'test-ns',
          plural: 'sandboxes',
        })
      );
    });

    it('getSandbox allows namespace override', async () => {
      mockCustomObjectsApi.getNamespacedCustomObject.mockResolvedValue({});

      await client.getSandbox('test', 'other-ns');
      expect(mockCustomObjectsApi.getNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'other-ns' })
      );
    });

    it('listSandboxes passes labelSelector', async () => {
      mockCustomObjectsApi.listNamespacedCustomObject.mockResolvedValue({
        items: [],
      });

      await client.listSandboxes({ labelSelector: 'app=test' });
      expect(mockCustomObjectsApi.listNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          labelSelector: 'app=test',
          namespace: 'test-ns',
        })
      );
    });

    it('listSandboxes allows namespace override', async () => {
      mockCustomObjectsApi.listNamespacedCustomObject.mockResolvedValue({
        items: [],
      });

      await client.listSandboxes({ namespace: 'custom-ns' });
      expect(mockCustomObjectsApi.listNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'custom-ns' })
      );
    });

    it('deleteSandbox calls delete with correct params', async () => {
      mockCustomObjectsApi.deleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteSandbox('test');
      expect(mockCustomObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test',
          namespace: 'test-ns',
        })
      );
    });

    it('deleteSandbox allows namespace override', async () => {
      mockCustomObjectsApi.deleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteSandbox('test', 'other-ns');
      expect(mockCustomObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'other-ns' })
      );
    });

    it('sandboxExists returns true when resource exists', async () => {
      mockCustomObjectsApi.getNamespacedCustomObject.mockResolvedValue({});
      expect(await client.sandboxExists('test')).toBe(true);
    });

    it('sandboxExists returns false on 404', async () => {
      mockCustomObjectsApi.getNamespacedCustomObject.mockRejectedValue({
        statusCode: 404,
      });
      expect(await client.sandboxExists('missing')).toBe(false);
    });
  });

  describe('Template CRUD', () => {
    it('createTemplate uses extensions group and sandboxtemplates plural', async () => {
      const template = {
        apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
        kind: 'SandboxTemplate',
        metadata: { name: 'base' },
        spec: { podTemplate: { spec: { containers: [] }, metadata: {} } },
      };
      mockCustomObjectsApi.createNamespacedCustomObject.mockResolvedValue(template);

      await client.createTemplate(template as any);
      expect(mockCustomObjectsApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'extensions.agents.x-k8s.io',
          plural: 'sandboxtemplates',
        })
      );
    });

    it('getTemplate retrieves by name', async () => {
      mockCustomObjectsApi.getNamespacedCustomObject.mockResolvedValue({
        metadata: { name: 'tpl' },
      });

      const result = await client.getTemplate('tpl');
      expect(result).toEqual({ metadata: { name: 'tpl' } });
    });

    it('listTemplates uses default namespace', async () => {
      mockCustomObjectsApi.listNamespacedCustomObject.mockResolvedValue({
        items: [],
      });

      await client.listTemplates();
      expect(mockCustomObjectsApi.listNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          plural: 'sandboxtemplates',
        })
      );
    });

    it('deleteTemplate calls delete', async () => {
      mockCustomObjectsApi.deleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteTemplate('tpl');
      expect(mockCustomObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tpl',
          plural: 'sandboxtemplates',
        })
      );
    });
  });

  describe('Claim CRUD', () => {
    it('createClaim uses extensions group and sandboxclaims plural', async () => {
      const claim = {
        apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
        kind: 'SandboxClaim',
        metadata: { name: 'claim-1' },
        spec: { sandboxTemplateRef: { name: 'base' } },
      };
      mockCustomObjectsApi.createNamespacedCustomObject.mockResolvedValue(claim);

      await client.createClaim(claim as any);
      expect(mockCustomObjectsApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'extensions.agents.x-k8s.io',
          plural: 'sandboxclaims',
        })
      );
    });

    it('getClaim retrieves by name', async () => {
      mockCustomObjectsApi.getNamespacedCustomObject.mockResolvedValue({
        metadata: { name: 'claim-1' },
      });

      const result = await client.getClaim('claim-1');
      expect(result).toEqual({ metadata: { name: 'claim-1' } });
    });

    it('listClaims uses default namespace', async () => {
      mockCustomObjectsApi.listNamespacedCustomObject.mockResolvedValue({
        items: [],
      });

      await client.listClaims();
      expect(mockCustomObjectsApi.listNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          plural: 'sandboxclaims',
        })
      );
    });

    it('deleteClaim calls delete', async () => {
      mockCustomObjectsApi.deleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteClaim('claim-1');
      expect(mockCustomObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'claim-1',
          plural: 'sandboxclaims',
        })
      );
    });
  });

  describe('WarmPool CRUD', () => {
    it('createWarmPool uses extensions group and sandboxwarmpools plural', async () => {
      const pool = {
        apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
        kind: 'SandboxWarmPool',
        metadata: { name: 'pool-1' },
        spec: { replicas: 3, sandboxTemplateRef: { name: 'base' } },
      };
      mockCustomObjectsApi.createNamespacedCustomObject.mockResolvedValue(pool);

      await client.createWarmPool(pool as any);
      expect(mockCustomObjectsApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'extensions.agents.x-k8s.io',
          plural: 'sandboxwarmpools',
        })
      );
    });

    it('getWarmPool retrieves by name', async () => {
      mockCustomObjectsApi.getNamespacedCustomObject.mockResolvedValue({
        metadata: { name: 'pool-1' },
      });

      const result = await client.getWarmPool('pool-1');
      expect(result).toEqual({ metadata: { name: 'pool-1' } });
    });

    it('listWarmPools uses default namespace', async () => {
      mockCustomObjectsApi.listNamespacedCustomObject.mockResolvedValue({
        items: [],
      });

      await client.listWarmPools();
      expect(mockCustomObjectsApi.listNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          plural: 'sandboxwarmpools',
        })
      );
    });

    it('deleteWarmPool calls delete', async () => {
      mockCustomObjectsApi.deleteNamespacedCustomObject.mockResolvedValue({});

      await client.deleteWarmPool('pool-1');
      expect(mockCustomObjectsApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'pool-1',
          plural: 'sandboxwarmpools',
        })
      );
    });
  });

  describe('Lifecycle operations', () => {
    it('pause patches sandbox with replicas 0', async () => {
      mockCustomObjectsApi.patchNamespacedCustomObject.mockResolvedValue({
        spec: { replicas: 0 },
      });

      await client.pause('my-sandbox', 'maintenance');
      expect(mockCustomObjectsApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-sandbox',
          namespace: 'test-ns',
          plural: 'sandboxes',
          body: expect.objectContaining({
            spec: { replicas: 0 },
          }),
        })
      );
    });

    it('pause includes reason annotation when provided', async () => {
      mockCustomObjectsApi.patchNamespacedCustomObject.mockResolvedValue({});

      await client.pause('test', 'maintenance');
      const callArgs = mockCustomObjectsApi.patchNamespacedCustomObject.mock.calls[0][0];
      expect(callArgs.body.metadata.annotations).toHaveProperty(
        'agents.x-k8s.io/pause-reason',
        'maintenance'
      );
    });

    it('resume patches sandbox with replicas 1', async () => {
      mockCustomObjectsApi.patchNamespacedCustomObject.mockResolvedValue({
        spec: { replicas: 1 },
      });

      await client.resume('my-sandbox');
      expect(mockCustomObjectsApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-sandbox',
          body: expect.objectContaining({
            spec: { replicas: 1 },
          }),
        })
      );
    });

    it('resume clears pause reason annotation', async () => {
      mockCustomObjectsApi.patchNamespacedCustomObject.mockResolvedValue({});

      await client.resume('test');
      const callArgs = mockCustomObjectsApi.patchNamespacedCustomObject.mock.calls[0][0];
      expect(callArgs.body.metadata.annotations).toHaveProperty('agents.x-k8s.io/pause-reason', '');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when CRD and namespace exist', async () => {
      mockVersionApi.getCode.mockResolvedValue({ gitVersion: 'v1.30.0' });
      mockApiExtApi.readCustomResourceDefinition.mockResolvedValue({});
      mockCoreApi.readNamespace.mockResolvedValue({});
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({
        items: [
          {
            metadata: {
              labels: { 'app.kubernetes.io/version': '0.1.0' },
            },
          },
        ],
      });

      const health = await client.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.crdRegistered).toBe(true);
      expect(health.namespaceExists).toBe(true);
      expect(health.controllerInstalled).toBe(true);
      expect(health.controllerVersion).toBe('0.1.0');
      expect(health.clusterVersion).toBe('v1.30.0');
      expect(health.namespace).toBe('test-ns');
    });

    it('returns unhealthy when cluster unreachable', async () => {
      mockVersionApi.getCode.mockRejectedValue(new Error('connection refused'));

      const health = await client.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.controllerInstalled).toBe(false);
      expect(health.crdRegistered).toBe(false);
      expect(health.namespaceExists).toBe(false);
    });

    it('returns unhealthy when CRD not registered', async () => {
      mockVersionApi.getCode.mockResolvedValue({ gitVersion: 'v1.30.0' });
      mockApiExtApi.readCustomResourceDefinition.mockRejectedValue({
        statusCode: 404,
      });
      mockCoreApi.readNamespace.mockResolvedValue({});

      const health = await client.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.crdRegistered).toBe(false);
      expect(health.namespaceExists).toBe(true);
    });

    it('returns unhealthy when namespace does not exist', async () => {
      mockVersionApi.getCode.mockResolvedValue({ gitVersion: 'v1.30.0' });
      mockApiExtApi.readCustomResourceDefinition.mockResolvedValue({});
      mockCoreApi.readNamespace.mockRejectedValue({ statusCode: 404 });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });

      const health = await client.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.crdRegistered).toBe(true);
      expect(health.namespaceExists).toBe(false);
    });

    it('controller not installed when no matching deployments', async () => {
      mockVersionApi.getCode.mockResolvedValue({ gitVersion: 'v1.30.0' });
      mockApiExtApi.readCustomResourceDefinition.mockResolvedValue({});
      mockCoreApi.readNamespace.mockResolvedValue({});
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });

      const health = await client.healthCheck();

      expect(health.controllerInstalled).toBe(false);
      expect(health.controllerVersion).toBeUndefined();
    });

    it('skips controller check when CRD not registered', async () => {
      mockVersionApi.getCode.mockResolvedValue({ gitVersion: 'v1.30.0' });
      mockApiExtApi.readCustomResourceDefinition.mockRejectedValue({
        statusCode: 404,
      });
      mockCoreApi.readNamespace.mockResolvedValue({});

      const health = await client.healthCheck();

      expect(mockAppsApi.listNamespacedDeployment).not.toHaveBeenCalled();
      expect(health.controllerInstalled).toBe(false);
    });

    it('handles controller check failure gracefully', async () => {
      mockVersionApi.getCode.mockResolvedValue({ gitVersion: 'v1.30.0' });
      mockApiExtApi.readCustomResourceDefinition.mockResolvedValue({});
      mockCoreApi.readNamespace.mockResolvedValue({});
      mockAppsApi.listNamespacedDeployment.mockRejectedValue(new Error('forbidden'));

      const health = await client.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.controllerInstalled).toBe(false);
    });
  });
});
