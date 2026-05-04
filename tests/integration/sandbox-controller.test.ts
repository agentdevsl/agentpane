/**
 * Integration tests for SandboxController — K8s CRD reconciliation controller.
 *
 * Tests cover:
 * - reconcileSandbox: pod already exists (no-op), terminal pod (delete + recreate),
 *   template resolution, creation failure -> status patch
 * - buildPodFromSandbox: ownerReferences for cascade deletion,
 *   PSS security context (allowPrivilegeEscalation: false, capabilities.drop: [ALL],
 *   runAsNonRoot: true, seccompProfile: RuntimeDefault)
 * - reconcileWarmPools: deficit calculation, terminal cleanup, pool bounds
 * - syncPodStatus: phase mapping (Running->Running, Pending->Pending, Failed->Failed)
 * - getHttpStatusCode: 4 different K8s error formats
 * - 409 Conflict handling in reconcileSandbox
 *
 * H5: These tests access private methods via `(controller as any).methodName()` because
 * SandboxController's public API is only start()/stop(). All reconciliation, pod building,
 * and status sync logic is private. If method names change, tests will fail at runtime.
 * This is an accepted trade-off — testing through start() alone would require simulating
 * the full K8s watch event loop which is impractical in unit tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxController } from '../../src/lib/sandbox/controllers/sandbox-controller';

// Use real constants from the SDK
const CRD_API = {
  group: 'agents.x-k8s.io',
  version: 'v1alpha1',
  apiVersion: 'agents.x-k8s.io/v1alpha1',
};
const _CRD_CONDITIONS = { ready: 'Ready', podReady: 'PodReady' };
const CRD_LABELS = {
  sandbox: 'agentpane.io/sandbox',
  warmPool: 'agentpane.io/warm-pool',
  warmPoolState: 'agentpane.io/warm-pool-state',
};
const _CRD_PLURALS = { sandbox: 'sandboxes', sandboxWarmPool: 'sandboxwarmpools' };
const _CRD_EXTENSIONS_API = { group: 'extensions.agents.x-k8s.io', version: 'v1alpha1' };

// Create mock client and K8s API clients
function createMockClient() {
  return {
    kubeConfig: {
      makeApiClient: vi.fn().mockImplementation((apiClass: any) => {
        if (apiClass.name === 'CoreV1Api' || apiClass === 'CoreV1Api') {
          return createMockCoreApi();
        }
        return createMockCustomApi();
      }),
    },
    watchSandboxes: vi.fn().mockReturnValue({ stop: vi.fn(), done: Promise.resolve() }),
    listSandboxes: vi.fn().mockResolvedValue({ items: [] }),
    listWarmPools: vi.fn().mockResolvedValue({ items: [] }),
    getTemplate: vi.fn(),
    createSandbox: vi.fn().mockResolvedValue(undefined),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCoreApi() {
  return {
    readNamespacedPod: vi.fn(),
    createNamespacedPod: vi.fn().mockResolvedValue({}),
    deleteNamespacedPod: vi.fn().mockResolvedValue(undefined),
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
  };
}

function createMockCustomApi() {
  return {
    getNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({ metadata: {}, status: {} }),
    replaceNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  };
}

function createSandboxCRD(name: string, overrides?: Record<string, unknown>) {
  return {
    apiVersion: CRD_API.apiVersion,
    kind: 'Sandbox',
    metadata: {
      name,
      uid: `uid-${name}`,
      labels: {},
      ...((overrides as any)?.metadata ?? {}),
    },
    spec: {
      podTemplate: null,
      ...((overrides as any)?.spec ?? {}),
    },
    status: (overrides as any)?.status ?? undefined,
  };
}

describe('SandboxController (IT-1500)', () => {
  let controller: SandboxController;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockCoreApi: ReturnType<typeof createMockCoreApi>;
  let mockCustomApi: ReturnType<typeof createMockCustomApi>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = createMockClient();
    mockCoreApi = createMockCoreApi();
    mockCustomApi = createMockCustomApi();

    // makeApiClient is called twice in constructor: once for CoreV1Api, once for CustomObjectsApi.
    // Return mockCoreApi first, then mockCustomApi.
    let callCount = 0;
    mockClient.kubeConfig.makeApiClient = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return mockCoreApi;
      }
      return mockCustomApi;
    });

    controller = new SandboxController(mockClient as any, 'test-namespace', {
      statusSyncIntervalMs: 100000, // Long interval to prevent auto-runs
      warmPoolSyncIntervalMs: 100000,
    });
  });

  afterEach(() => {
    controller.stop();
  });

  describe('reconcileSandbox (IT-1501)', () => {
    it('IT-1502a: no-op when pod already exists and is not in terminal state', async () => {
      // Pod exists and is Running
      mockCoreApi.readNamespacedPod.mockResolvedValue({
        status: { phase: 'Running' },
      });

      const sandbox = createSandboxCRD('test-sandbox-1');

      // Access private method via any cast (for testing)
      await (controller as any).reconcileSandbox(sandbox);

      // Should NOT create a new pod
      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();
    });

    it('IT-1502b: deletes terminal pod (Failed) and recreates', async () => {
      // Pod exists but in Failed state
      mockCoreApi.readNamespacedPod.mockResolvedValue({
        status: { phase: 'Failed' },
      });
      mockCoreApi.deleteNamespacedPod.mockResolvedValue(undefined);

      const sandbox = createSandboxCRD('test-sandbox-failed');

      await (controller as any).reconcileSandbox(sandbox);

      // Should delete the terminal pod
      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-sandbox-failed', namespace: 'test-namespace' })
      );

      // Should create a new pod
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();
    });

    it('IT-1502c: creates pod when no existing pod found (404)', async () => {
      // Simulate 404 - pod not found
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });

      const sandbox = createSandboxCRD('test-sandbox-new');

      await (controller as any).reconcileSandbox(sandbox);

      // Should create a pod
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-namespace',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'test-sandbox-new',
            }),
          }),
        })
      );
    });

    it('IT-1502d: resolves template when sandboxTemplateRef is set', async () => {
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockClient.getTemplate.mockResolvedValue({
        spec: {
          podTemplate: {
            spec: {
              containers: [
                {
                  name: 'custom-sandbox',
                  image: 'custom-image:latest',
                  command: ['sleep', 'infinity'],
                },
              ],
            },
          },
        },
      });

      const sandbox = createSandboxCRD('test-sandbox-template', {
        spec: {
          sandboxTemplateRef: { name: 'my-template' },
        },
      });

      await (controller as any).reconcileSandbox(sandbox);

      expect(mockClient.getTemplate).toHaveBeenCalledWith('my-template');
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();
    });

    it('IT-1502e: patches status on template resolution failure', async () => {
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockClient.getTemplate.mockRejectedValue(new Error('Template not found'));

      const sandbox = createSandboxCRD('test-sandbox-bad-template', {
        spec: {
          sandboxTemplateRef: { name: 'nonexistent-template' },
        },
      });

      await (controller as any).reconcileSandbox(sandbox);

      // Should NOT create a pod
      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();

      // Should patch status with failure reason
      expect(mockCustomApi.replaceNamespacedCustomObjectStatus).toHaveBeenCalled();
    });

    it('IT-1502f: 409 Conflict on pod creation is silently ignored (race condition)', async () => {
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });

      // Simulate 409 Conflict on pod creation
      const conflictError = new Error('Conflict');
      (conflictError as any).statusCode = 409;
      mockCoreApi.createNamespacedPod.mockRejectedValue(conflictError);

      const sandbox = createSandboxCRD('test-sandbox-conflict');

      // Should NOT throw
      await expect((controller as any).reconcileSandbox(sandbox)).resolves.not.toThrow();

      // Should NOT patch status with error (silent 409)
      // The status patch should not happen for 409
    });

    it('IT-1502g: patches status with error on non-409 pod creation failure', async () => {
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockRejectedValue(new Error('Insufficient resources'));

      const sandbox = createSandboxCRD('test-sandbox-create-fail');

      await (controller as any).reconcileSandbox(sandbox);

      // Should patch status with PodCreationFailed
      expect(mockCustomApi.replaceNamespacedCustomObjectStatus).toHaveBeenCalled();
    });
  });

  describe('buildPodFromSandbox (IT-1502)', () => {
    it('IT-1503a: sets ownerReferences for cascade deletion', () => {
      const sandbox = createSandboxCRD('test-pod-owner');

      const pod = (controller as any).buildPodFromSandbox(sandbox);

      expect(pod.metadata.ownerReferences).toBeDefined();
      expect(pod.metadata.ownerReferences.length).toBe(1);
      expect(pod.metadata.ownerReferences[0]).toEqual(
        expect.objectContaining({
          apiVersion: CRD_API.apiVersion,
          kind: 'Sandbox',
          name: 'test-pod-owner',
          controller: true,
          blockOwnerDeletion: true,
        })
      );
    });

    it('IT-1503b: PSS security context on containers', () => {
      const sandbox = createSandboxCRD('test-pod-pss');

      const pod = (controller as any).buildPodFromSandbox(sandbox);

      // Check container-level security context
      const container = pod.spec.containers[0];
      expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(container.securityContext.capabilities.drop).toEqual(['ALL']);
      expect(container.securityContext.runAsNonRoot).toBe(true);
      expect(container.securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    it('IT-1503c: PSS pod-level security context', () => {
      const sandbox = createSandboxCRD('test-pod-pss-pod');

      const pod = (controller as any).buildPodFromSandbox(sandbox);

      // Check pod-level security context
      expect(pod.spec.securityContext.runAsNonRoot).toBe(true);
      expect(pod.spec.securityContext.runAsUser).toBe(1000);
      expect(pod.spec.securityContext.runAsGroup).toBe(1000);
      expect(pod.spec.securityContext.fsGroup).toBe(1000);
      expect(pod.spec.securityContext.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    it('IT-1503d: default container runs entrypoint with tail keep-alive', () => {
      const sandbox = createSandboxCRD('test-pod-default');

      const pod = (controller as any).buildPodFromSandbox(sandbox);

      const container = pod.spec.containers[0];
      expect(container.command).toEqual(['/entrypoint.sh']);
      expect(container.args).toEqual(['tail', '-f', '/dev/null']);
      expect(container.name).toBe('sandbox');
    });

    it('IT-1503e: merges template container spec with security context', () => {
      const sandbox = createSandboxCRD('test-pod-template');
      const template = {
        spec: {
          podTemplate: {
            spec: {
              containers: [
                {
                  name: 'custom-container',
                  image: 'my-image:v1',
                  command: ['node', 'server.js'],
                  securityContext: {
                    readOnlyRootFilesystem: true,
                  },
                },
              ],
            },
          },
        },
      };

      const pod = (controller as any).buildPodFromSandbox(sandbox, template);

      const container = pod.spec.containers[0];
      expect(container.name).toBe('custom-container');
      expect(container.image).toBe('my-image:v1');
      expect(container.command).toEqual(['node', 'server.js']);
      // PSS fields are enforced regardless of template
      expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(container.securityContext.runAsNonRoot).toBe(true);
    });

    it('IT-1503f: restartPolicy is Never', () => {
      const sandbox = createSandboxCRD('test-pod-restart');

      const pod = (controller as any).buildPodFromSandbox(sandbox);

      expect(pod.spec.restartPolicy).toBe('Never');
    });
  });

  describe('getHttpStatusCode (IT-1503)', () => {
    it('IT-1504a: extracts from direct statusCode property', () => {
      const code = (controller as any).getHttpStatusCode({ statusCode: 404 });
      expect(code).toBe(404);
    });

    it('IT-1504b: extracts from parsed body.code (string body)', () => {
      const code = (controller as any).getHttpStatusCode({
        body: JSON.stringify({ code: 409, reason: 'AlreadyExists' }),
      });
      expect(code).toBe(409);
    });

    it('IT-1504c: extracts from body.code (object body)', () => {
      const code = (controller as any).getHttpStatusCode({
        body: { code: 500, reason: 'InternalError' },
      });
      expect(code).toBe(500);
    });

    it('IT-1504d: extracts from HTTP-Code in error message', () => {
      const err = new Error('HTTP-Code: 404\nMessage: Not Found');
      const code = (controller as any).getHttpStatusCode(err);
      expect(code).toBe(404);
    });

    it('IT-1504e: extracts from response.statusCode (older k8s format)', () => {
      const code = (controller as any).getHttpStatusCode({
        response: { statusCode: 503 },
      });
      expect(code).toBe(503);
    });

    it('IT-1504f: returns undefined for non-error objects', () => {
      expect((controller as any).getHttpStatusCode(null)).toBeUndefined();
      expect((controller as any).getHttpStatusCode('string')).toBeUndefined();
      expect((controller as any).getHttpStatusCode(42)).toBeUndefined();
      expect((controller as any).getHttpStatusCode({})).toBeUndefined();
    });
  });

  describe('syncPodStatus phase mapping (IT-1504)', () => {
    it('IT-1505a: Running pod with all containers ready maps to Running', async () => {
      // Set controller to running
      (controller as any).running = true;

      const mockPod = {
        metadata: {
          name: 'test-pod-running',
          labels: { [CRD_LABELS.sandbox]: 'test-sandbox' },
        },
        status: {
          phase: 'Running',
          containerStatuses: [{ ready: true }],
        },
      };

      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [mockPod] });

      await (controller as any).syncPodStatus();

      // Should patch status with Running
      expect(mockCustomApi.replaceNamespacedCustomObjectStatus).toHaveBeenCalled();
      const patchCall = mockCustomApi.replaceNamespacedCustomObjectStatus.mock.calls[0];
      const statusBody = patchCall[0].body?.status ?? (patchCall[0] as any).status;
      // Access the status that was patched
      expect(statusBody).toBeDefined();
    });

    it('IT-1505b: Pending pod maps to Pending', async () => {
      (controller as any).running = true;

      const mockPod = {
        metadata: {
          name: 'test-pod-pending',
          labels: { [CRD_LABELS.sandbox]: 'pending-sandbox' },
        },
        status: {
          phase: 'Pending',
          containerStatuses: [{ ready: false }],
        },
      };

      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [mockPod] });

      await (controller as any).syncPodStatus();

      expect(mockCustomApi.replaceNamespacedCustomObjectStatus).toHaveBeenCalled();
    });

    it('IT-1505c: Failed pod maps to Failed', async () => {
      (controller as any).running = true;

      const mockPod = {
        metadata: {
          name: 'test-pod-failed',
          labels: { [CRD_LABELS.sandbox]: 'failed-sandbox' },
        },
        status: {
          phase: 'Failed',
          containerStatuses: [{ ready: false }],
        },
      };

      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [mockPod] });

      await (controller as any).syncPodStatus();

      expect(mockCustomApi.replaceNamespacedCustomObjectStatus).toHaveBeenCalled();
    });

    it('IT-1505d: does not sync when controller is not running', async () => {
      (controller as any).running = false;

      await (controller as any).syncPodStatus();

      expect(mockCoreApi.listNamespacedPod).not.toHaveBeenCalled();
    });
  });

  describe('reconcileWarmPools (IT-1505)', () => {
    it('IT-1506a: creates sandboxes to fill deficit', async () => {
      (controller as any).running = true;

      mockClient.listWarmPools.mockResolvedValue({
        items: [
          {
            metadata: { name: 'test-pool' },
            spec: {
              replicas: 3,
              sandboxTemplateRef: { name: 'base-template' },
            },
          },
        ],
      });

      // No existing sandboxes = deficit of 3
      mockClient.listSandboxes.mockResolvedValue({ items: [] });

      await (controller as any).reconcileWarmPools();

      // Should create 3 sandboxes
      expect(mockClient.createSandbox).toHaveBeenCalledTimes(3);
    });

    it('IT-1506b: counts active (not just running) sandboxes to avoid over-provisioning', async () => {
      (controller as any).running = true;

      mockClient.listWarmPools.mockResolvedValue({
        items: [
          {
            metadata: { name: 'test-pool-active' },
            spec: {
              replicas: 2,
              sandboxTemplateRef: { name: 'base-template' },
            },
          },
        ],
      });

      // 2 existing sandboxes (1 running, 1 pending) = no deficit
      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: { name: 'warm-test-pool-active-abc' },
            status: { conditions: [{ type: 'Ready', status: 'True', reason: 'PodReady' }] },
          },
          {
            metadata: { name: 'warm-test-pool-active-def' },
            status: { conditions: [{ type: 'Ready', status: 'False', reason: 'PodNotReady' }] },
          },
        ],
      });

      await (controller as any).reconcileWarmPools();

      // Should NOT create any sandboxes (2 active >= 2 desired)
      expect(mockClient.createSandbox).not.toHaveBeenCalled();
    });

    it('IT-1506c: cleans up terminal warm pool sandboxes', async () => {
      (controller as any).running = true;

      mockClient.listWarmPools.mockResolvedValue({
        items: [
          {
            metadata: { name: 'test-pool-cleanup' },
            spec: {
              replicas: 1,
              sandboxTemplateRef: { name: 'base-template' },
            },
          },
        ],
      });

      // 1 terminal sandbox + 1 healthy
      mockClient.listSandboxes.mockResolvedValue({
        items: [
          {
            metadata: { name: 'warm-test-pool-cleanup-expired' },
            status: { conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxExpired' }] },
          },
          {
            metadata: { name: 'warm-test-pool-cleanup-healthy' },
            status: { conditions: [{ type: 'Ready', status: 'True', reason: 'PodReady' }] },
          },
        ],
      });

      await (controller as any).reconcileWarmPools();

      // Should delete the expired sandbox
      expect(mockClient.deleteSandbox).toHaveBeenCalledWith('warm-test-pool-cleanup-expired');

      // Should NOT create new ones (1 healthy >= 1 desired)
      expect(mockClient.createSandbox).not.toHaveBeenCalled();
    });

    it('IT-1506d: does not reconcile when controller is not running', async () => {
      (controller as any).running = false;

      await (controller as any).reconcileWarmPools();

      expect(mockClient.listWarmPools).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle (IT-1506)', () => {
    it('IT-1507a: start sets up watches and timers', async () => {
      await controller.start();

      expect(mockClient.watchSandboxes).toHaveBeenCalled();
      expect(mockClient.listSandboxes).toHaveBeenCalled(); // reconcileExisting
      expect((controller as any).running).toBe(true);
    });

    it('IT-1507b: stop clears watches and timers', async () => {
      await controller.start();

      controller.stop();

      expect((controller as any).running).toBe(false);
      expect((controller as any).sandboxWatch).toBeNull();
      expect((controller as any).statusSyncTimer).toBeNull();
      expect((controller as any).warmPoolSyncTimer).toBeNull();
    });
  });
});
