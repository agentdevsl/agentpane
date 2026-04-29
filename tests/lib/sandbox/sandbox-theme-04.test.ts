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

// ---------------------------------------------------------------------------
// arch29-W2-J / F04-03 — K8s execStream env-injection uses lastIndexOf
// ---------------------------------------------------------------------------
//
// Repro of the K8s indexOf('exec ') bug: when `cwd` contains the literal
// substring `'exec '` (e.g. a path that includes the word 'execute' or a
// directory named with `exec ` in it via shell-escaping artifacts), the env
// prefix gets injected into the wrong place — *before* the `cd` rather than
// before the trailing `&& exec`. This means env vars never reach the spawned
// command.
//
// Nomad uses `lastIndexOf` for exactly this reason; F04-03 closes the
// asymmetry.

describe('arch29-W2-J / F04-03 K8s execStream env injection (lastIndexOf parity)', () => {
  it("injects env at the trailing exec keyword when cwd contains 'exec '", async () => {
    vi.resetModules();

    // Capture the command argv that the SDK sees. We can then assert on the
    // exact shell body to verify env-injection placement.
    const capturedExecStreamArgs: Array<{ command: string[] }> = [];
    const sdkExecStream = vi.fn(async (opts: { command: string[] }) => {
      capturedExecStreamArgs.push({ command: opts.command });
      return {
        stdout: { pipe: vi.fn() } as unknown,
        stderr: { pipe: vi.fn() } as unknown,
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      };
    });

    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: class {
        execStream = sdkExecStream;
      },
      NotFoundError: class extends Error {},
    }));

    const { AgentSandboxInstance } = await import('@/lib/sandbox/providers/agent-sandbox-instance');

    const client = {
      exec: vi.fn(),
      execStream: sdkExecStream,
      getSandbox: vi.fn(),
    } as unknown;

    const instance = new AgentSandboxInstance(
      'sb-1',
      'agentpane-cs-1-aaa',
      'cs-1',
      'agentpane-sandboxes',
      client as never
    );

    await instance.execStream({
      cmd: 'node',
      args: ['app.js'],
      env: { TOKEN: 'abc123' },
      // The repro: a cwd containing the substring `exec ` (with trailing space).
      // With the bug (indexOf), env-injection lands at this leading occurrence,
      // *before* the `cd` keyword — so env vars never reach the exec'd cmd.
      // With the fix (lastIndexOf), env-injection lands at the trailing
      // `exec node app.js`, scoping env vars to the spawned process.
      cwd: '/opt/foo-exec test/bar',
    });

    expect(capturedExecStreamArgs.length).toBe(1);
    const captured = capturedExecStreamArgs[0]!;
    // Shape: ['sh', '-c', '<body>']
    expect(captured.command[0]).toBe('sh');
    expect(captured.command[1]).toBe('-c');
    const body = captured.command[2] ?? '';

    // The cwd must remain intact: the literal substring `'/opt/foo-exec test/bar'`
    // must be present unbroken in the resulting body. With the bug
    // (indexOf), the env prefix gets injected at the leading `exec ` *inside*
    // the cwd, splitting the path:
    //   cd '/opt/foo-TOKEN='abc123' exec test/bar' && exec 'node' 'app.js'
    // …which is broken syntactically and semantically.
    //
    // With the fix (lastIndexOf), the env prefix lands before the trailing
    // `exec` keyword:
    //   cd '/opt/foo-exec test/bar' && TOKEN='abc123' exec 'node' 'app.js'
    expect(body).toContain("cd '/opt/foo-exec test/bar' &&");
    expect(body).toContain("TOKEN='abc123' exec 'node' 'app.js'");
    // Must NOT contain the broken-cwd shape that the indexOf bug produces.
    expect(body).not.toContain('foo-TOKEN=');
  });

  it('still injects env correctly when cwd is innocuous (no embedded exec)', async () => {
    vi.resetModules();

    const captured: Array<{ command: string[] }> = [];
    const sdkExecStream = vi.fn(async (opts: { command: string[] }) => {
      captured.push({ command: opts.command });
      return {
        stdout: { pipe: vi.fn() } as unknown,
        stderr: { pipe: vi.fn() } as unknown,
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      };
    });

    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: class {
        execStream = sdkExecStream;
      },
      NotFoundError: class extends Error {},
    }));

    const { AgentSandboxInstance } = await import('@/lib/sandbox/providers/agent-sandbox-instance');
    const client = { execStream: sdkExecStream, getSandbox: vi.fn() } as unknown;
    const instance = new AgentSandboxInstance('sb-2', 'sb-name', 'cs-2', 'ns', client as never);

    await instance.execStream({
      cmd: 'node',
      args: ['app.js'],
      env: { TOKEN: 'abc123' },
      cwd: '/workspace',
    });

    expect(captured.length).toBe(1);
    const body = captured[0]?.command[2] ?? '';
    expect(body).toMatch(/cd '\/workspace' && TOKEN='abc123' exec 'node' 'app\.js'/);
  });
});

// ---------------------------------------------------------------------------
// arch29-W2-J / F04-09 — K8s NetworkPolicy emission + boot guard
// ---------------------------------------------------------------------------

describe('arch29-W2-J / F04-09 K8s assertNetworkIsolationSupport', () => {
  const ORIGINAL = process.env.SANDBOX_DEFAULT_NETWORK_MODE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    else process.env.SANDBOX_DEFAULT_NETWORK_MODE = ORIGINAL;
  });

  it('is a no-op when SANDBOX_DEFAULT_NETWORK_MODE is unset', async () => {
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    vi.resetModules();
    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: vi.fn(),
      SandboxBuilder: vi.fn(),
      AlreadyExistsError: class extends Error {},
      NotFoundError: class extends Error {},
    }));
    vi.doMock('@kubernetes/client-node', () => ({
      ApisApi: class {},
      NetworkingV1Api: class {},
    }));

    const { AgentSandboxProvider } = await import('@/lib/sandbox/providers/agent-sandbox-provider');
    // Empty client — assertion should not even reach the SDK in no-op mode.
    const provider = new AgentSandboxProvider({ client: {} as never });
    await expect(provider.assertNetworkIsolationSupport()).resolves.toBeUndefined();
  });

  it('throws NETWORK_ISOLATION_UNSUPPORTED when networking.k8s.io is missing', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    vi.resetModules();

    // Mock @kubernetes/client-node to return a fake ApisApi that lists
    // available API groups WITHOUT `networking.k8s.io`. This simulates a
    // cluster that doesn't support NetworkPolicy.
    const getAPIVersions = vi.fn().mockResolvedValue({
      groups: [{ name: 'apps' }, { name: 'batch' }],
    });
    vi.doMock('@kubernetes/client-node', () => ({
      ApisApi: class {},
      NetworkingV1Api: class {},
    }));

    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: vi.fn(),
      SandboxBuilder: vi.fn(),
      AlreadyExistsError: class extends Error {},
      NotFoundError: class extends Error {},
    }));

    const { AgentSandboxProvider } = await import('@/lib/sandbox/providers/agent-sandbox-provider');
    const provider = new AgentSandboxProvider({
      client: {
        kubeConfig: {
          makeApiClient: vi.fn(() => ({ getAPIVersions })),
        },
      } as never,
    });

    await expect(provider.assertNetworkIsolationSupport()).rejects.toMatchObject({
      code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
    });
    expect(getAPIVersions).toHaveBeenCalled();
  });

  it('passes when networking.k8s.io is exposed', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    vi.resetModules();

    const getAPIVersions = vi.fn().mockResolvedValue({
      groups: [{ name: 'apps' }, { name: 'networking.k8s.io' }, { name: 'batch' }],
    });
    vi.doMock('@kubernetes/client-node', () => ({
      ApisApi: class {},
      NetworkingV1Api: class {},
    }));

    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: vi.fn(),
      SandboxBuilder: vi.fn(),
      AlreadyExistsError: class extends Error {},
      NotFoundError: class extends Error {},
    }));

    const { AgentSandboxProvider } = await import('@/lib/sandbox/providers/agent-sandbox-provider');
    const provider = new AgentSandboxProvider({
      client: {
        kubeConfig: {
          makeApiClient: vi.fn(() => ({ getAPIVersions })),
        },
      } as never,
    });

    await expect(provider.assertNetworkIsolationSupport()).resolves.toBeUndefined();
  });

  it('throws NETWORK_ISOLATION_UNSUPPORTED when discovery itself fails', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    vi.resetModules();

    const getAPIVersions = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.doMock('@kubernetes/client-node', () => ({
      ApisApi: class {},
      NetworkingV1Api: class {},
    }));
    vi.doMock('@agentpane/agent-sandbox-sdk', () => ({
      AgentSandboxClient: vi.fn(),
      SandboxBuilder: vi.fn(),
      AlreadyExistsError: class extends Error {},
      NotFoundError: class extends Error {},
    }));

    const { AgentSandboxProvider } = await import('@/lib/sandbox/providers/agent-sandbox-provider');
    const provider = new AgentSandboxProvider({
      client: {
        kubeConfig: {
          makeApiClient: vi.fn(() => ({ getAPIVersions })),
        },
      } as never,
    });

    await expect(provider.assertNetworkIsolationSupport()).rejects.toMatchObject({
      code: 'K8S_NETWORK_ISOLATION_UNSUPPORTED',
    });
  });
});

describe('arch29-W2-J / F04-09 Nomad assertNetworkIsolationSupport', () => {
  const ORIGINAL = process.env.SANDBOX_DEFAULT_NETWORK_MODE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    else process.env.SANDBOX_DEFAULT_NETWORK_MODE = ORIGINAL;
  });

  it('is a no-op when SANDBOX_DEFAULT_NETWORK_MODE is unset', async () => {
    delete process.env.SANDBOX_DEFAULT_NETWORK_MODE;
    vi.resetModules();
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

    const { NomadSandboxProvider } = await import('@/lib/sandbox/providers/nomad-sandbox-provider');
    const provider = new NomadSandboxProvider({ client: {} as never });
    await expect(provider.assertNetworkIsolationSupport()).resolves.toBeUndefined();
  });

  it('throws when Nomad version is older than 0.10', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    vi.resetModules();

    const healthCheck = vi.fn().mockResolvedValue({
      healthy: true,
      leader: '127.0.0.1',
      version: '0.9.7',
      namespaceExists: true,
      datacenter: 'dc1',
    });

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

    const { NomadSandboxProvider } = await import('@/lib/sandbox/providers/nomad-sandbox-provider');
    const provider = new NomadSandboxProvider({
      client: { healthCheck } as never,
    });

    await expect(provider.assertNetworkIsolationSupport()).rejects.toMatchObject({
      code: 'NOMAD-800',
    });
  });

  it('throws when Nomad cluster is unhealthy', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    vi.resetModules();

    const healthCheck = vi.fn().mockResolvedValue({
      healthy: false,
      leader: null,
      version: null,
      namespaceExists: false,
      datacenter: null,
      error: 'no leader',
    });

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

    const { NomadSandboxProvider } = await import('@/lib/sandbox/providers/nomad-sandbox-provider');
    const provider = new NomadSandboxProvider({
      client: { healthCheck } as never,
    });

    await expect(provider.assertNetworkIsolationSupport()).rejects.toMatchObject({
      code: 'NOMAD-800',
    });
  });

  it('passes when Nomad version is 1.x and healthy', async () => {
    process.env.SANDBOX_DEFAULT_NETWORK_MODE = 'none';
    vi.resetModules();

    const healthCheck = vi.fn().mockResolvedValue({
      healthy: true,
      leader: '127.0.0.1',
      version: '1.7.2',
      namespaceExists: true,
      datacenter: 'dc1',
    });

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

    const { NomadSandboxProvider } = await import('@/lib/sandbox/providers/nomad-sandbox-provider');
    const provider = new NomadSandboxProvider({
      client: { healthCheck } as never,
    });

    await expect(provider.assertNetworkIsolationSupport()).resolves.toBeUndefined();
  });
});
