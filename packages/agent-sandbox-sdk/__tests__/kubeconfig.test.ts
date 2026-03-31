import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KubeConfigError } from '../src/errors.js';

// Mock dependencies
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

const mockLoadFromFile = vi.fn();
const mockLoadFromCluster = vi.fn();
const mockGetContexts = vi.fn().mockReturnValue([]);
const mockSetCurrentContext = vi.fn();
const mockGetCurrentContext = vi.fn();
const mockGetCurrentCluster = vi.fn();
const mockGetContextObject = vi.fn();
const mockGetCluster = vi.fn();
const mockClusters: Array<{ server: string; skipTLSVerify?: boolean }> = [];

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class MockKubeConfig {
    loadFromFile = mockLoadFromFile;
    loadFromCluster = mockLoadFromCluster;
    getContexts = mockGetContexts;
    setCurrentContext = mockSetCurrentContext;
    getCurrentContext = mockGetCurrentContext;
    getCurrentCluster = mockGetCurrentCluster;
    getContextObject = mockGetContextObject;
    getCluster = mockGetCluster;
    clusters = mockClusters;
  },
}));

import { existsSync } from 'node:fs';
import { KubeConfig } from '@kubernetes/client-node';
import { getClusterInfo, loadKubeConfig, resolveContext } from '../src/kubeconfig.js';

const mockExistsSync = vi.mocked(existsSync);

describe('loadKubeConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockClusters.length = 0;
    process.env = { ...originalEnv };
    delete process.env.K8S_KUBECONFIG;
    delete process.env.KUBECONFIG;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Tier 1: Explicit path', () => {
    it('loads from explicit path', () => {
      mockExistsSync.mockReturnValue(true);

      loadKubeConfig({ kubeconfigPath: '/custom/kubeconfig' });

      expect(mockLoadFromFile).toHaveBeenCalledWith('/custom/kubeconfig');
    });

    it('throws when explicit path does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      expect(() => loadKubeConfig({ kubeconfigPath: '/missing/config' })).toThrow(KubeConfigError);
      expect(() => loadKubeConfig({ kubeconfigPath: '/missing/config' })).toThrow(/not found/);
    });

    it('throws KubeConfigError when explicit file is invalid', () => {
      mockExistsSync.mockReturnValue(true);
      mockLoadFromFile.mockImplementation(() => {
        throw new Error('invalid YAML');
      });

      expect(() => loadKubeConfig({ kubeconfigPath: '/bad/config' })).toThrow(KubeConfigError);
      expect(() => loadKubeConfig({ kubeconfigPath: '/bad/config' })).toThrow(/Invalid kubeconfig/);
    });
  });

  describe('Tier 2: K8S_KUBECONFIG env var', () => {
    it('loads from K8S_KUBECONFIG env var', () => {
      process.env.K8S_KUBECONFIG = '/env/kubeconfig';
      mockExistsSync.mockReturnValue(true);

      loadKubeConfig();

      expect(mockLoadFromFile).toHaveBeenCalledWith('/env/kubeconfig');
    });

    it('throws when K8S_KUBECONFIG path does not exist', () => {
      process.env.K8S_KUBECONFIG = '/missing/env/config';
      mockExistsSync.mockReturnValue(false);

      expect(() => loadKubeConfig()).toThrow(KubeConfigError);
    });

    it('throws KubeConfigError when K8S_KUBECONFIG file is invalid', () => {
      process.env.K8S_KUBECONFIG = '/bad/env/config';
      mockExistsSync.mockReturnValue(true);
      mockLoadFromFile.mockImplementation(() => {
        throw new Error('parse error');
      });

      expect(() => loadKubeConfig()).toThrow(/Invalid kubeconfig/);
    });
  });

  describe('Tier 3: KUBECONFIG env var', () => {
    it('loads from first existing KUBECONFIG path', () => {
      process.env.KUBECONFIG = '/path1:/path2';
      mockExistsSync.mockImplementation((p: any) => p === '/path2');

      loadKubeConfig();

      expect(mockLoadFromFile).toHaveBeenCalledWith('/path2');
    });

    it('skips KUBECONFIG when no paths exist', () => {
      process.env.KUBECONFIG = '/nonexistent1:/nonexistent2';
      mockExistsSync.mockReturnValue(false);
      mockLoadFromCluster.mockImplementation(() => {
        throw new Error('not in cluster');
      });

      // Falls through to tier 4/5 and eventually throws
      expect(() => loadKubeConfig()).toThrow(KubeConfigError);
    });

    it('filters empty segments from KUBECONFIG', () => {
      process.env.KUBECONFIG = ':/path1::';
      mockExistsSync.mockImplementation((p: any) => p === '/path1');

      loadKubeConfig();

      expect(mockLoadFromFile).toHaveBeenCalledWith('/path1');
    });

    it('throws KubeConfigError when KUBECONFIG file is invalid', () => {
      process.env.KUBECONFIG = '/bad/config';
      mockExistsSync.mockReturnValue(true);
      mockLoadFromFile.mockImplementation(() => {
        throw new Error('parse error');
      });

      expect(() => loadKubeConfig()).toThrow(/Invalid kubeconfig/);
    });
  });

  describe('Tier 4: Default path', () => {
    it('loads from ~/.kube/config', () => {
      mockExistsSync.mockImplementation((p: any) => String(p).endsWith('.kube/config'));

      loadKubeConfig();

      expect(mockLoadFromFile).toHaveBeenCalledWith(expect.stringContaining('.kube/config'));
    });

    it('throws KubeConfigError when default file is invalid', () => {
      mockExistsSync.mockImplementation((p: any) => String(p).endsWith('.kube/config'));
      mockLoadFromFile.mockImplementation(() => {
        throw new Error('parse error');
      });

      expect(() => loadKubeConfig()).toThrow(/Invalid kubeconfig/);
    });
  });

  describe('Tier 5: In-cluster config', () => {
    it('loads from in-cluster config', () => {
      mockExistsSync.mockReturnValue(false);

      loadKubeConfig();

      expect(mockLoadFromCluster).toHaveBeenCalled();
    });

    it('throws when no config found at any tier', () => {
      mockExistsSync.mockReturnValue(false);
      mockLoadFromCluster.mockImplementation(() => {
        throw new Error('not in cluster');
      });

      expect(() => loadKubeConfig()).toThrow(KubeConfigError);
      expect(() => loadKubeConfig()).toThrow(/No kubeconfig found/);
    });
  });

  describe('Options', () => {
    it('applies context when specified', () => {
      mockExistsSync.mockReturnValue(false);
      // In-cluster will be used
      mockGetContexts.mockReturnValue([{ name: 'my-ctx' }]);

      loadKubeConfig({ context: 'my-ctx' });

      expect(mockSetCurrentContext).toHaveBeenCalledWith('my-ctx');
    });

    it('applies skipTLSVerify when set', () => {
      mockExistsSync.mockReturnValue(false);
      const cluster = { server: 'https://localhost', skipTLSVerify: false };
      mockClusters.push(cluster);

      loadKubeConfig({ skipTLSVerify: true });

      expect(cluster.skipTLSVerify).toBe(true);
    });

    it('does not set skipTLSVerify when clusters array is empty', () => {
      mockExistsSync.mockReturnValue(false);
      // mockClusters is empty by default (cleared in beforeEach)

      // Should not throw — iterating an empty array is fine
      expect(() => loadKubeConfig({ skipTLSVerify: true })).not.toThrow();
    });

    it('tier priority: explicit path takes precedence over env vars', () => {
      process.env.K8S_KUBECONFIG = '/env/config';
      process.env.KUBECONFIG = '/kubeconfig/config';
      mockExistsSync.mockReturnValue(true);

      loadKubeConfig({ kubeconfigPath: '/explicit/config' });

      expect(mockLoadFromFile).toHaveBeenCalledWith('/explicit/config');
      expect(mockLoadFromFile).toHaveBeenCalledTimes(1);
    });
  });
});

describe('resolveContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets and returns the requested context', () => {
    mockGetContexts.mockReturnValue([{ name: 'ctx-a' }, { name: 'ctx-b' }]);
    const kc = new KubeConfig();

    const result = resolveContext(kc, 'ctx-b');

    expect(result).toBe('ctx-b');
    expect(mockSetCurrentContext).toHaveBeenCalledWith('ctx-b');
  });

  it('throws for unknown context', () => {
    mockGetContexts.mockReturnValue([{ name: 'ctx-a' }]);
    const kc = new KubeConfig();

    expect(() => resolveContext(kc, 'unknown')).toThrow(KubeConfigError);
    expect(() => resolveContext(kc, 'unknown')).toThrow(/not found/);
  });

  it('returns current context when none specified', () => {
    mockGetCurrentContext.mockReturnValue('default-ctx');
    const kc = new KubeConfig();

    const result = resolveContext(kc);

    expect(result).toBe('default-ctx');
  });

  it('throws when no current context and none specified', () => {
    mockGetCurrentContext.mockReturnValue(undefined);
    const kc = new KubeConfig();

    expect(() => resolveContext(kc)).toThrow(KubeConfigError);
    expect(() => resolveContext(kc)).toThrow(/No current context/);
  });

  it('does not call setCurrentContext when no context specified', () => {
    mockGetCurrentContext.mockReturnValue('default-ctx');
    const kc = new KubeConfig();

    resolveContext(kc);

    expect(mockSetCurrentContext).not.toHaveBeenCalled();
  });
});

describe('getClusterInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cluster name and server', () => {
    mockGetCurrentContext.mockReturnValue('my-ctx');
    mockGetContextObject.mockReturnValue({ cluster: 'my-cluster' });
    mockGetCluster.mockReturnValue({ server: 'https://k8s.example.com' });

    const kc = new KubeConfig();
    const info = getClusterInfo(kc);

    expect(info).toEqual({
      name: 'my-cluster',
      server: 'https://k8s.example.com',
    });
  });

  it('returns null when no current context', () => {
    mockGetCurrentContext.mockReturnValue(undefined);
    const kc = new KubeConfig();

    expect(getClusterInfo(kc)).toBeNull();
  });

  it('returns null when context object is null', () => {
    mockGetCurrentContext.mockReturnValue('ctx');
    mockGetContextObject.mockReturnValue(null);

    const kc = new KubeConfig();
    expect(getClusterInfo(kc)).toBeNull();
  });

  it('returns null when context has no cluster', () => {
    mockGetCurrentContext.mockReturnValue('ctx');
    mockGetContextObject.mockReturnValue({});

    const kc = new KubeConfig();
    expect(getClusterInfo(kc)).toBeNull();
  });

  it('returns null when cluster not found', () => {
    mockGetCurrentContext.mockReturnValue('ctx');
    mockGetContextObject.mockReturnValue({ cluster: 'missing' });
    mockGetCluster.mockReturnValue(undefined);

    const kc = new KubeConfig();
    expect(getClusterInfo(kc)).toBeNull();
  });
});
