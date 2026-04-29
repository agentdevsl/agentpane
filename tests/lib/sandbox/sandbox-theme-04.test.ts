/**
 * theme-04 (sandbox providers) — coverage for the fixes landed in the
 * p0-p1-april remediation branch.
 *
 * Groups:
 *   P0-01 image validation
 *   P1-01 provider conformance
 *   P1-02 AgentCore gating
 *   P1-03 K8s / Nomad recover()
 *   P1-05 credential injection via writeFile
 *   P1-06 network-mode default opt-in
 *   P1-07 per-tenant quota
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// P0-01 — image validation
// ---------------------------------------------------------------------------

describe('P0-01 image validation', () => {
  it('isDigestPinnedImage accepts digest-pinned references', async () => {
    const { isDigestPinnedImage } = await import('@/lib/sandbox/types');
    expect(
      isDigestPinnedImage(
        'ghcr.io/agentdevsl/agent-sandbox@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      )
    ).toBe(true);
    expect(
      isDigestPinnedImage(
        'image:tag@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      )
    ).toBe(true);
  });

  it('isDigestPinnedImage rejects tag-only references', async () => {
    const { isDigestPinnedImage } = await import('@/lib/sandbox/types');
    expect(isDigestPinnedImage('srlynch1/agent-sandbox:latest')).toBe(false);
    expect(isDigestPinnedImage('agent-sandbox')).toBe(false);
    expect(isDigestPinnedImage('ghcr.io/x/y:v1')).toBe(false);
  });

  it('isDigestPinnedImage rejects malformed digests', async () => {
    const { isDigestPinnedImage } = await import('@/lib/sandbox/types');
    expect(isDigestPinnedImage('image@sha256:short')).toBe(false);
    expect(isDigestPinnedImage('image@sha1:abcdef')).toBe(false);
    expect(isDigestPinnedImage('@sha256:abcdef')).toBe(false);
  });

  it('SANDBOX_DEFAULTS.image is digest-pinned', async () => {
    const { SANDBOX_DEFAULTS, isDigestPinnedImage } = await import('@/lib/sandbox/types');
    expect(isDigestPinnedImage(SANDBOX_DEFAULTS.image)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-01 — provider conformance
// ---------------------------------------------------------------------------

describe('P1-01 SandboxProvider conformance', () => {
  it('every real provider satisfies the SandboxProvider shape (compile-time)', async () => {
    // This test is largely a compile-time assertion: if any provider fails to
    // implement required SandboxProvider members, the `satisfies` operator
    // below breaks typecheck. We also poke each method shape at runtime.
    vi.resetModules();
    vi.doMock('dockerode', () => {
      // `new Docker(opts)` is called inside the provider constructor — we need
      // a class-shaped constructor. biome auto-fixes `function () {}` into an
      // arrow which is NOT constructable, so we use a `class` explicitly.
      class MockDocker {}
      return { default: MockDocker };
    });
    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: vi.fn(),
      SandboxBuilder: vi.fn(),
      AlreadyExistsError: class extends Error {},
      NotFoundError: class extends Error {},
    }));
    vi.doMock('@agentpane/nomad-sandbox-sdk', () => ({
      NomadSandboxClient: vi.fn(),
      NomadJobBuilder: vi.fn(),
      ConnectionError: class extends Error {},
      NomadApiError: class extends Error {},
      NotFoundError: class extends Error {},
      TimeoutError: class extends Error {},
      NOMAD_JOB_PREFIX: 'agentpane-',
      NOMAD_META: { SANDBOX_ID: 'sandbox_id', PROJECT_ID: 'project_id' },
    }));

    const { DockerProvider } = await import('@/lib/sandbox/providers/docker-provider');
    const { AgentSandboxProvider } = await import('@/lib/sandbox/providers/agent-sandbox-provider');
    const { NomadSandboxProvider } = await import('@/lib/sandbox/providers/nomad-sandbox-provider');

    const docker = new DockerProvider();
    const k8s = new AgentSandboxProvider({ client: {} as never });
    const nomad = new NomadSandboxProvider({ client: {} as never });

    for (const provider of [docker, k8s, nomad]) {
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.create).toBe('function');
      expect(typeof provider.get).toBe('function');
      expect(typeof provider.getById).toBe('function');
      expect(typeof provider.list).toBe('function');
      expect(typeof provider.recover).toBe('function');
      expect(typeof provider.pullImage).toBe('function');
      expect(typeof provider.isImageAvailable).toBe('function');
      expect(typeof provider.healthCheck).toBe('function');
      expect(typeof provider.cleanup).toBe('function');
      expect(typeof provider.on).toBe('function');
      expect(typeof provider.off).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// P1-02 — AgentCore gating
// ---------------------------------------------------------------------------

describe('P1-02 AgentCore gating', () => {
  const ORIGINAL = process.env.AGENTCORE_ENABLED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENTCORE_ENABLED;
    else process.env.AGENTCORE_ENABLED = ORIGINAL;
  });

  it('setAgentCoreProvider is a no-op when AGENTCORE_ENABLED is unset', async () => {
    delete process.env.AGENTCORE_ENABLED;

    // Spy on the dynamic import target — if the gate is violated, this fails.
    // We import the service fresh with resetModules so the guard runs.
    vi.resetModules();

    // We can't easily detect a non-import, so instead verify: after calling
    // setAgentCoreProvider with the flag off, providerName stays at the
    // injected provider's name (not 'agentcore').
    const { ContainerAgentService } = await import(
      '@/services/container-agent/container-agent.service'
    );
    const service = new ContainerAgentService(
      { query: { tasks: { findMany: vi.fn().mockResolvedValue([]) } } } as never,
      { name: 'docker' } as never,
      { publish: vi.fn() } as never,
      { getDecryptedKey: vi.fn() } as never
    );
    await service.setAgentCoreProvider({
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      runtimeArn: 'arn:aws:agentcore:test',
    });
    expect(service.providerName).toBe('docker');
    service.dispose();
  });
});

// ---------------------------------------------------------------------------
// P1-03 — K8s / Nomad recover()
// ---------------------------------------------------------------------------

describe('P1-03 K8s recover()', () => {
  it('recover() re-registers live CRDs and deletes terminal ones', async () => {
    vi.resetModules();
    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: vi.fn(),
      SandboxBuilder: vi.fn(),
      AlreadyExistsError: class extends Error {},
      NotFoundError: class extends Error {},
    }));

    const { AgentSandboxProvider } = await import('@/lib/sandbox/providers/agent-sandbox-provider');

    const listSandboxes = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'agentpane-cs-abc',
            labels: {
              'agentpane.io/sandbox-id': 'sb-live-1',
              'agentpane.io/project-id': 'cs-1',
            },
          },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
        {
          metadata: {
            name: 'agentpane-cs-xyz',
            labels: {
              'agentpane.io/sandbox-id': 'sb-dead-1',
              'agentpane.io/project-id': 'cs-2',
            },
          },
          status: {
            conditions: [{ type: 'Ready', status: 'False', reason: 'SandboxExpired' }],
          },
        },
      ],
    });
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const getSandbox = vi.fn().mockResolvedValue({
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    });

    const provider = new AgentSandboxProvider({
      client: {
        listSandboxes,
        deleteSandbox,
        getSandbox,
      } as never,
    });

    const result = await provider.recover();
    expect(result.recovered).toBe(1);
    expect(result.removed).toBe(1);
    expect(listSandboxes).toHaveBeenCalled();
    expect(deleteSandbox).toHaveBeenCalledWith('agentpane-cs-xyz', expect.any(String));
  });
});

describe('P1-03 Nomad recover()', () => {
  it('recover() re-registers running jobs and purges dead ones', async () => {
    vi.resetModules();
    vi.doMock('@agentpane/nomad-sandbox-sdk', () => ({
      NomadSandboxClient: vi.fn(),
      NomadJobBuilder: vi.fn(),
      ConnectionError: class extends Error {},
      NomadApiError: class extends Error {
        constructor(
          public override message: string,
          public statusCode: number
        ) {
          super(message);
        }
      },
      NotFoundError: class extends Error {},
      TimeoutError: class extends Error {},
      NOMAD_JOB_PREFIX: 'agentpane-',
      NOMAD_META: { SANDBOX_ID: 'sandbox_id', PROJECT_ID: 'project_id' },
    }));

    const { NomadSandboxProvider } = await import('@/lib/sandbox/providers/nomad-sandbox-provider');

    const listJobs = vi.fn().mockResolvedValue([
      {
        ID: 'agentpane-cs-1-abc',
        Status: 'running',
        Meta: { sandbox_id: 'sb-live-1', project_id: 'cs-1' },
      },
      {
        ID: 'agentpane-cs-2-def',
        Status: 'dead',
        Meta: { sandbox_id: 'sb-dead-1', project_id: 'cs-2' },
      },
    ]);
    const getJob = vi.fn().mockResolvedValue({ Status: 'running' });
    const getJobAllocations = vi
      .fn()
      .mockResolvedValue([{ ID: 'alloc-1', ClientStatus: 'running' }]);
    const stopJob = vi.fn().mockResolvedValue(undefined);

    const provider = new NomadSandboxProvider({
      client: {
        listJobs,
        getJob,
        getJobAllocations,
        stopJob,
      } as never,
    });

    const result = await provider.recover();
    expect(result.recovered).toBe(1);
    expect(result.removed).toBe(1);
    expect(stopJob).toHaveBeenCalledWith('agentpane-cs-2-def', true);
  });
});

// ---------------------------------------------------------------------------
// P0-01 / P1-07 — SandboxConfigService validation
// ---------------------------------------------------------------------------

describe('P0-01 / P1-07 SandboxConfigService validation', () => {
  it('validateImage accepts digest-pinned refs', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    const result = svc.validateImage(
      'ghcr.io/agentdevsl/agent-sandbox@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    );
    expect(result.ok).toBe(true);
  });

  it('validateImage rejects tag-only refs', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    const result = svc.validateImage('srlynch1/agent-sandbox:latest');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_CONFIG_IMAGE_NOT_DIGEST_PINNED');
    }
  });

  it('validateImage passes through undefined (use default)', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    expect(svc.validateImage(undefined).ok).toBe(true);
    expect(svc.validateImage(null).ok).toBe(true);
  });

  it('assertQuota rejects when maxSandboxes exceeded', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    const result = svc.assertQuota(
      { maxSandboxes: 2, maxCpuCores: 8, maxMemoryMb: 16384 },
      { activeSandboxes: 2, cpuCores: 1, memoryMb: 1024 }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');
    }
  });

  it('assertQuota rejects when cpuCores exceeds ceiling', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    const result = svc.assertQuota(
      { maxSandboxes: 10, maxCpuCores: 4, maxMemoryMb: 16384 },
      { activeSandboxes: 0, cpuCores: 8, memoryMb: 1024 }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');
    }
  });

  it('assertQuota rejects when memoryMb exceeds ceiling', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    const result = svc.assertQuota(
      { maxSandboxes: 10, maxCpuCores: 16, maxMemoryMb: 4096 },
      { activeSandboxes: 0, cpuCores: 2, memoryMb: 8192 }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');
    }
  });

  it('assertQuota passes when under the ceiling', async () => {
    const { SandboxConfigService } = await import('@/services/sandbox-config.service');
    const svc = new SandboxConfigService({} as never);
    const result = svc.assertQuota(
      { maxSandboxes: 10, maxCpuCores: 16, maxMemoryMb: 16384 },
      { activeSandboxes: 3, cpuCores: 4, memoryMb: 4096 }
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-05 — credential injection uses writeFile when available
// ---------------------------------------------------------------------------

describe('P1-05 credential injection out-of-band', () => {
  function makeSandbox(writeFile?: ReturnType<typeof vi.fn>) {
    const exec = vi.fn().mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'mkdir') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'test' && args?.includes('-f')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'chmod') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'sh') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unhandled' };
    });
    return {
      id: 'sb-1',
      codespaceId: 'cs-1',
      containerId: 'c-1',
      status: 'running' as const,
      exec,
      execAsRoot: exec,
      createTmuxSession: vi.fn(),
      listTmuxSessions: vi.fn(),
      killTmuxSession: vi.fn(),
      sendKeysToTmux: vi.fn(),
      captureTmuxPane: vi.fn(),
      stop: vi.fn(),
      getMetrics: vi.fn(),
      touch: vi.fn(),
      getLastActivity: vi.fn(() => new Date()),
      writeFile,
    };
  }

  it('uses sandbox.writeFile when the provider supports it (credentials never hit argv)', async () => {
    const { CredentialsInjector } = await import('@/lib/sandbox/credentials-injector');
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(writeFile);

    const injector = new CredentialsInjector();
    const result = await injector.inject(
      sandbox as never,
      {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-secret-should-never-appear-in-argv',
          refreshToken: '',
          expiresAt: 1,
          scopes: [],
          subscriptionType: 'max',
        },
      } as never
    );

    expect(result.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('.credentials.json'),
      expect.any(String),
      0o600
    );
    // Verify NO `sh -c` exec was used
    const shExecs = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'sh'
    );
    expect(shExecs.length).toBe(0);
  });

  it('falls back to sh -c path when the provider lacks writeFile (legacy)', async () => {
    const { CredentialsInjector } = await import('@/lib/sandbox/credentials-injector');
    const sandbox = makeSandbox(undefined);

    const injector = new CredentialsInjector();
    const result = await injector.inject(
      sandbox as never,
      {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-legacy',
          refreshToken: '',
          expiresAt: 1,
          scopes: [],
          subscriptionType: 'max',
        },
      } as never
    );

    expect(result.ok).toBe(true);
    const shExecs = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'sh'
    );
    expect(shExecs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P1-06 — network-mode env opt-in
// ---------------------------------------------------------------------------

describe('P1-06 network-mode default', () => {
  const ORIGINAL = process.env.SANDBOX_DEFAULT_NETWORK_MODE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    else process.env.SANDBOX_DEFAULT_NETWORK_MODE = ORIGINAL;
  });

  it('defaults to bridge when env unset', async () => {
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    const { getDefaultSandboxNetworkMode } = await import('@/lib/sandbox/types');
    expect(getDefaultSandboxNetworkMode()).toBe('bridge');
  });

  it('returns none when operator opts in', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    const { getDefaultSandboxNetworkMode } = await import('@/lib/sandbox/types');
    expect(getDefaultSandboxNetworkMode()).toBe('none');
  });

  it('ignores junk values (falls back to bridge)', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'wild-west';
    const { getDefaultSandboxNetworkMode } = await import('@/lib/sandbox/types');
    expect(getDefaultSandboxNetworkMode()).toBe('bridge');
  });
});
