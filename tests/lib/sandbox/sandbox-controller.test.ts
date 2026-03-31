import {
  AlreadyExistsError,
  CRD_API,
  CRD_LABELS,
  CRD_PLURALS,
  NotFoundError,
  type Sandbox,
  type SandboxList,
  type SandboxTemplate,
  type SandboxWarmPool,
  type SandboxWarmPoolList,
  type WatchEvent,
  type WatchHandle,
} from '@agentpane/agent-sandbox-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the logger
vi.mock('@/lib/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Shared mock APIs - must be declared before vi.mock so they can be captured.
const mockCoreApi = {
  readNamespacedPod: vi.fn(),
  createNamespacedPod: vi.fn(),
  deleteNamespacedPod: vi.fn(),
  listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
};

const mockCustomApi = {
  getNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  replaceNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
};

// Named constructors so that `makeApiClient(CoreV1Api)` name-based dispatch works.
function CoreV1Api() {}
Object.defineProperty(CoreV1Api, 'name', { value: 'CoreV1Api' });
function CustomObjectsApi() {}
Object.defineProperty(CustomObjectsApi, 'name', { value: 'CustomObjectsApi' });

vi.mock('@kubernetes/client-node', () => ({
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSandbox(name: string, overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    apiVersion: CRD_API.apiVersion,
    kind: 'Sandbox',
    metadata: { name, uid: `uid-${name}`, namespace: 'test-ns' },
    spec: {},
    ...overrides,
  } as Sandbox;
}

function makeWarmPool(
  name: string,
  replicas: number,
  templateName: string,
  overrides: Partial<SandboxWarmPool> = {}
): SandboxWarmPool {
  return {
    apiVersion: CRD_API.apiVersion,
    kind: 'SandboxWarmPool',
    metadata: { name, namespace: 'test-ns' },
    spec: {
      replicas,
      sandboxTemplateRef: { name: templateName },
    },
    ...overrides,
  } as SandboxWarmPool;
}

function createMockClient() {
  return {
    kubeConfig: {
      makeApiClient: vi.fn((ApiClass: unknown) => {
        const name = typeof ApiClass === 'function' ? (ApiClass as { name: string }).name : '';
        if (name === 'CoreV1Api') return mockCoreApi;
        if (name === 'CustomObjectsApi') return mockCustomApi;
        return {};
      }),
    },
    watchSandboxes: vi.fn(() => ({ stop: vi.fn(), done: Promise.resolve() })),
    listSandboxes: vi.fn().mockResolvedValue({ items: [] } as SandboxList),
    listWarmPools: vi.fn().mockResolvedValue({ items: [] } as SandboxWarmPoolList),
    getTemplate: vi.fn(),
    createSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
  };
}

/** Small delay to let fire-and-forget promise chains (.catch()) settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 50));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SandboxController', () => {
  let SandboxController: typeof import('@/lib/sandbox/controllers/sandbox-controller').SandboxController;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset shared mocks
    mockCoreApi.readNamespacedPod.mockReset();
    mockCoreApi.createNamespacedPod.mockReset();
    mockCoreApi.deleteNamespacedPod.mockReset();
    mockCoreApi.listNamespacedPod.mockReset().mockResolvedValue({ items: [] });
    mockCustomApi.getNamespacedCustomObjectStatus.mockReset().mockResolvedValue({});
    mockCustomApi.replaceNamespacedCustomObjectStatus.mockReset().mockResolvedValue({});

    mockClient = createMockClient();

    const mod = await import('@/lib/sandbox/controllers/sandbox-controller');
    SandboxController = mod.SandboxController;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('Lifecycle', () => {
    it('starts the controller and sets up watches and timers', async () => {
      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockClient.watchSandboxes).toHaveBeenCalledTimes(1);
      expect(mockClient.listSandboxes).toHaveBeenCalledWith({ namespace: 'test-ns' });
      expect(mockClient.listWarmPools).toHaveBeenCalledWith('test-ns');

      ctrl.stop();
    });

    it('stops the controller and cleans up timers and watches', async () => {
      const mockWatch: WatchHandle = { stop: vi.fn(), done: Promise.resolve() };
      mockClient.watchSandboxes.mockReturnValue(mockWatch);

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();
      ctrl.stop();

      expect(mockWatch.stop).toHaveBeenCalledTimes(1);
    });

    it('stop is idempotent when no watch exists', () => {
      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      ctrl.stop();
    });

    it('periodic status sync fires after the configured interval', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const ctrl = new SandboxController(mockClient as any, 'test-ns', {
        statusSyncIntervalMs: 100,
        warmPoolSyncIntervalMs: 999999,
      });
      await ctrl.start();

      mockCoreApi.listNamespacedPod.mockClear();
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      await vi.advanceTimersByTimeAsync(150);

      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
      vi.useRealTimers();
    });

    it('periodic warm pool sync fires after the configured interval', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const ctrl = new SandboxController(mockClient as any, 'test-ns', {
        statusSyncIntervalMs: 999999,
        warmPoolSyncIntervalMs: 100,
      });
      await ctrl.start();

      mockClient.listWarmPools.mockClear();
      mockClient.listWarmPools.mockResolvedValue({ items: [] });

      await vi.advanceTimersByTimeAsync(150);

      expect(mockClient.listWarmPools).toHaveBeenCalled();

      ctrl.stop();
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // Watch event handling
  // =========================================================================

  describe('Watch event handling', () => {
    it('reconciles sandbox on ADDED event', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('my-sandbox') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });

    it('reconciles sandbox on MODIFIED event', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'MODIFIED', object: makeSandbox('mod-sandbox') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });

    it('ignores DELETED event (relies on ownerReferences)', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'DELETED', object: makeSandbox('del-sandbox') });
      await tick();

      expect(mockCoreApi.readNamespacedPod).not.toHaveBeenCalled();

      ctrl.stop();
    });

    it('handles ERROR event gracefully', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ERROR', object: makeSandbox('err-sandbox') });

      ctrl.stop();
    });

    it('handles BOOKMARK event as no-op', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'BOOKMARK', object: makeSandbox('bm-sandbox') });

      expect(mockCoreApi.readNamespacedPod).not.toHaveBeenCalled();

      ctrl.stop();
    });
  });

  // =========================================================================
  // Sandbox reconciliation
  // =========================================================================

  describe('Sandbox reconciliation', () => {
    it('skips sandbox with no metadata.name', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      const sandbox = makeSandbox('');
      sandbox.metadata = {} as any;
      capturedCallback!({ type: 'ADDED', object: sandbox });
      await tick();

      expect(mockCoreApi.readNamespacedPod).not.toHaveBeenCalled();

      ctrl.stop();
    });

    it('does nothing if pod already exists and is not terminal', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockResolvedValue({
        status: { phase: 'Running' },
      });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('running-pod') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();

      ctrl.stop();
    });

    it('recreates pod if it is in Failed state', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockResolvedValue({
        status: { phase: 'Failed' },
      });
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({});
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'MODIFIED', object: makeSandbox('failed-pod') });
      await tick();

      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith({
        name: 'failed-pod',
        namespace: 'test-ns',
      });
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });

    it('recreates pod if it is in Succeeded state', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockResolvedValue({
        status: { phase: 'Succeeded' },
      });
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({});
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'MODIFIED', object: makeSandbox('succeeded-pod') });
      await tick();

      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalled();
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });

    it('handles 409 Conflict on pod creation as no-op', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockRejectedValue(
        new AlreadyExistsError('Pod', 'conflict-pod')
      );

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('conflict-pod') });
      await tick();

      ctrl.stop();
    });

    it('patches sandbox status to Failed when pod creation fails', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockRejectedValue(new Error('Insufficient resources'));

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('fail-create') });
      await tick();

      expect(mockCustomApi.getNamespacedCustomObjectStatus).toHaveBeenCalled();

      ctrl.stop();
    });

    it('resolves template when sandbox has templateRef', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      const template: SandboxTemplate = {
        apiVersion: CRD_API.apiVersion,
        kind: 'SandboxTemplate',
        metadata: { name: 'my-template' },
        spec: {
          podTemplate: {
            spec: {
              containers: [
                { name: 'custom', image: 'custom-image:latest', command: ['sleep', 'infinity'] },
              ],
            },
          },
        },
      } as SandboxTemplate;

      mockClient.getTemplate.mockResolvedValue(template);
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const sandbox = makeSandbox('templated-sandbox', {
        spec: { sandboxTemplateRef: { name: 'my-template' } },
      } as any);

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: sandbox });
      await tick();

      expect(mockClient.getTemplate).toHaveBeenCalledWith('my-template');
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      const podBody = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(podBody.spec.containers[0].image).toBe('custom-image:latest');

      ctrl.stop();
    });

    it('patches sandbox status to Failed when template not found', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockClient.getTemplate.mockRejectedValue(new NotFoundError('SandboxTemplate', 'missing'));
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });

      const sandbox = makeSandbox('template-missing', {
        spec: { sandboxTemplateRef: { name: 'missing' } },
      } as any);

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: sandbox });
      await tick();

      expect(mockCustomApi.getNamespacedCustomObjectStatus).toHaveBeenCalled();
      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();

      ctrl.stop();
    });
  });

  // =========================================================================
  // Pod builder
  // =========================================================================

  describe('Pod builder', () => {
    it('builds pod with default container when no template', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('default-pod') });
      await tick();

      const podBody = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(podBody.metadata.name).toBe('default-pod');
      expect(podBody.metadata.ownerReferences).toHaveLength(1);
      expect(podBody.metadata.ownerReferences[0].kind).toBe('Sandbox');
      expect(podBody.spec.containers[0].name).toBe('sandbox');
      expect(podBody.spec.containers[0].image).toBe('srlynch1/agent-sandbox:latest');
      expect(podBody.spec.containers[0].command).toEqual(['tail', '-f', '/dev/null']);
      expect(podBody.spec.restartPolicy).toBe('Never');

      ctrl.stop();
    });

    it('ensures security context on all containers', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('sec-pod') });
      await tick();

      const podBody = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      const secCtx = podBody.spec.containers[0].securityContext;
      expect(secCtx.allowPrivilegeEscalation).toBe(false);
      expect(secCtx.runAsNonRoot).toBe(true);
      expect(secCtx.capabilities.drop).toEqual(['ALL']);

      ctrl.stop();
    });

    it('sets correct labels on the pod', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('label-pod') });
      await tick();

      const podBody = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(podBody.metadata.labels['app.kubernetes.io/managed-by']).toBe('agentpane-controller');
      expect(podBody.metadata.labels[CRD_LABELS.sandbox]).toBe('label-pod');

      ctrl.stop();
    });

    it('resolves runtimeClassName "none" as undefined', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const sandbox = makeSandbox('none-runtime', {
        spec: { runtimeClassName: 'none' },
      } as any);

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: sandbox });
      await tick();

      const podBody = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(podBody.spec.runtimeClassName).toBeUndefined();

      ctrl.stop();
    });

    it('sets pod-level security context for restricted PSS', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('pss-pod') });
      await tick();

      const podBody = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(podBody.spec.securityContext.runAsNonRoot).toBe(true);
      expect(podBody.spec.securityContext.runAsUser).toBe(1000);
      expect(podBody.spec.securityContext.seccompProfile.type).toBe('RuntimeDefault');

      ctrl.stop();
    });
  });

  // =========================================================================
  // Status sync
  // =========================================================================

  describe('Status sync', () => {
    it('syncs Running pod status to sandbox CRD', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const ctrl = new SandboxController(mockClient as any, 'test-ns', {
        statusSyncIntervalMs: 100,
        warmPoolSyncIntervalMs: 999999,
      });

      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pod-1', labels: { [CRD_LABELS.sandbox]: 'sandbox-1' } },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              containerStatuses: [{ ready: true }],
            },
          },
        ],
      });

      await ctrl.start();

      await vi.advanceTimersByTimeAsync(150);

      expect(mockCustomApi.getNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          group: CRD_API.group,
          version: CRD_API.version,
          plural: CRD_PLURALS.sandbox,
          name: 'sandbox-1',
        })
      );

      ctrl.stop();
      vi.useRealTimers();
    });

    it('skips pods without sandbox label', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const ctrl = new SandboxController(mockClient as any, 'test-ns', {
        statusSyncIntervalMs: 100,
        warmPoolSyncIntervalMs: 999999,
      });

      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            metadata: { name: 'orphan-pod', labels: {} },
            status: { phase: 'Running' },
          },
        ],
      });

      await ctrl.start();

      await vi.advanceTimersByTimeAsync(150);

      expect(mockCustomApi.getNamespacedCustomObjectStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'orphan-pod' })
      );

      ctrl.stop();
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // Warm pool reconciliation
  // =========================================================================

  describe('Warm pool reconciliation', () => {
    it('creates sandboxes to fill warm pool deficit', async () => {
      mockClient.listWarmPools.mockResolvedValue({
        items: [makeWarmPool('pool-1', 3, 'template-1')],
      });
      mockClient.listSandboxes.mockResolvedValue({ items: [] });
      mockClient.createSandbox.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockClient.createSandbox).toHaveBeenCalledTimes(3);

      ctrl.stop();
    });

    it('does not create sandboxes when pool is satisfied', async () => {
      const existingSandboxes = [
        makeSandbox('warm-pool-1-a', { status: { phase: 'Running' } } as any),
        makeSandbox('warm-pool-1-b', { status: { phase: 'Running' } } as any),
      ];

      mockClient.listWarmPools.mockResolvedValue({
        items: [makeWarmPool('pool-1', 2, 'template-1')],
      });
      mockClient.listSandboxes.mockResolvedValue({ items: existingSandboxes });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockClient.createSandbox).not.toHaveBeenCalled();

      ctrl.stop();
    });

    it('cleans up terminal warm pool sandboxes', async () => {
      const existingSandboxes = [makeSandbox('warm-fail', { status: { phase: 'Failed' } } as any)];

      mockClient.listWarmPools.mockResolvedValue({
        items: [makeWarmPool('pool-1', 1, 'template-1')],
      });
      mockClient.listSandboxes.mockResolvedValue({ items: existingSandboxes });
      mockClient.deleteSandbox.mockResolvedValue(undefined);
      mockClient.createSandbox.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockClient.deleteSandbox).toHaveBeenCalledWith('warm-fail');
      expect(mockClient.createSandbox).toHaveBeenCalledTimes(1);

      ctrl.stop();
    });

    it('handles AlreadyExistsError when creating warm sandbox', async () => {
      mockClient.listWarmPools.mockResolvedValue({
        items: [makeWarmPool('pool-1', 1, 'template-1')],
      });
      mockClient.listSandboxes.mockResolvedValue({ items: [] });
      mockClient.createSandbox.mockRejectedValue(new AlreadyExistsError('Sandbox', 'warm-pool-1'));

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      ctrl.stop();
    });

    it('skips warm pool with no sandboxTemplateRef', async () => {
      const pool = makeWarmPool('pool-no-tpl', 2, 'any-template');
      (pool.spec as any).sandboxTemplateRef = undefined;

      mockClient.listWarmPools.mockResolvedValue({ items: [pool] });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockClient.createSandbox).not.toHaveBeenCalled();

      ctrl.stop();
    });

    it('updates warm pool status with ready count', async () => {
      const existingSandboxes = [
        makeSandbox('warm-running', { status: { phase: 'Running' } } as any),
      ];

      mockClient.listWarmPools.mockResolvedValue({
        items: [makeWarmPool('pool-1', 1, 'template-1')],
      });
      mockClient.listSandboxes.mockResolvedValue({ items: existingSandboxes });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockCustomApi.getNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          plural: CRD_PLURALS.sandboxWarmPool,
          name: 'pool-1',
        })
      );

      ctrl.stop();
    });

    it('counts Pending sandboxes as active to avoid over-provisioning', async () => {
      const existingSandboxes = [
        makeSandbox('warm-pending-a', { status: { phase: 'Pending' } } as any),
        makeSandbox('warm-pending-b', { status: { phase: 'Pending' } } as any),
      ];

      mockClient.listWarmPools.mockResolvedValue({
        items: [makeWarmPool('pool-1', 2, 'template-1')],
      });
      mockClient.listSandboxes.mockResolvedValue({ items: existingSandboxes });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockClient.createSandbox).not.toHaveBeenCalled();

      ctrl.stop();
    });
  });

  // =========================================================================
  // Error detection helpers
  // =========================================================================

  describe('Error detection helpers', () => {
    it('detects NotFoundError instance as 404', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue(new NotFoundError('Pod', 'test'));
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('nf-pod') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });

    it('detects 404 from body.code in JSON string', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({
        body: JSON.stringify({ kind: 'Status', code: 404, reason: 'NotFound' }),
      });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('json-404') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });

    it('handles unexpected errors when checking pod existence', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 500 });

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('err-pod') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();

      ctrl.stop();
    });

    it('detects 404 from response.statusCode format', async () => {
      let capturedCallback: ((event: WatchEvent<Sandbox>) => void) | null = null;
      mockClient.watchSandboxes.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return { stop: vi.fn(), done: Promise.resolve() };
      });

      mockCoreApi.readNamespacedPod.mockRejectedValue({
        response: { statusCode: 404 },
      });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      capturedCallback!({ type: 'ADDED', object: makeSandbox('resp-404') });
      await tick();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalled();

      ctrl.stop();
    });
  });

  // =========================================================================
  // Existing sandbox reconciliation on startup
  // =========================================================================

  describe('Existing sandbox reconciliation', () => {
    it('reconciles all existing sandboxes on start', async () => {
      mockClient.listSandboxes.mockResolvedValue({
        items: [makeSandbox('existing-1'), makeSandbox('existing-2')],
      });
      mockCoreApi.readNamespacedPod.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespacedPod.mockResolvedValue({});

      const ctrl = new SandboxController(mockClient as any, 'test-ns');
      await ctrl.start();

      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledTimes(2);

      ctrl.stop();
    });
  });
});
