import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../errors/base.js';
import { err, ok } from '../../utils/result.js';
import { BootstrapService } from '../service.js';
import type { BootstrapPhaseConfig } from '../types.js';

describe('BootstrapService', () => {
  it('runs all phases and returns context', async () => {
    const phases: BootstrapPhaseConfig[] = [
      {
        name: 'client',
        fn: async () => ok(null),
        timeout: 100,
        recoverable: false,
      },
      {
        name: 'collections',
        fn: async () => ok({ projects: { ready: true } }),
        timeout: 100,
        recoverable: false,
      },
    ];

    const service = new BootstrapService(phases);
    const result = await service.run();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        collections: { projects: { ready: true } },
      });
    }
  });

  it('stops on non-recoverable errors', async () => {
    const fatalError: AppError = {
      code: 'BOOTSTRAP_FAIL',
      message: 'failed',
      status: 500,
    };

    const phases: BootstrapPhaseConfig[] = [
      {
        name: 'sqlite',
        fn: async () => err(fatalError),
        timeout: 100,
        recoverable: false,
      },
      {
        name: 'schema',
        fn: async () => ok('schema'),
        timeout: 100,
        recoverable: false,
      },
    ];

    const service = new BootstrapService(phases);
    const result = await service.run();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(fatalError);
    }
  });

  it('continues on recoverable errors', async () => {
    const recoverableError: AppError = {
      code: 'BOOTSTRAP_WARN',
      message: 'warn',
      status: 500,
    };

    const phases: BootstrapPhaseConfig[] = [
      {
        name: 'client',
        fn: async () => ok(null),
        timeout: 100,
        recoverable: false,
      },
      {
        name: 'collections',
        fn: async () => ok({ projects: { ready: true } }),
        timeout: 100,
        recoverable: false,
      },
      {
        name: 'streams',
        fn: async () => err(recoverableError),
        timeout: 100,
        recoverable: true,
      },
      {
        name: 'github',
        fn: async () => ok('token'),
        timeout: 100,
        recoverable: true,
      },
    ];

    const service = new BootstrapService(phases);
    const result = await service.run();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        collections: { projects: { ready: true } },
      });
    }
  });

  it('times out phases', async () => {
    const phases: BootstrapPhaseConfig[] = [
      {
        name: 'sqlite',
        fn: async () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(ok('db')), 200);
          }),
        timeout: 50,
        recoverable: false,
      },
    ];

    const service = new BootstrapService(phases);
    const result = await service.run();

    expect(result.ok).toBe(false);
  });

  it('sets context for streams phase', async () => {
    const phases: BootstrapPhaseConfig[] = [
      {
        name: 'streams',
        fn: async () => ok({ connected: true }),
        timeout: 100,
        recoverable: false,
      },
    ];

    const service = new BootstrapService(phases);
    const result = await service.run();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.streams).toEqual({ connected: true });
    }
  });

  it('notifies subscribers on state changes', async () => {
    const phases: BootstrapPhaseConfig[] = [
      {
        name: 'sqlite',
        fn: async () => ok('db'),
        timeout: 100,
        recoverable: false,
      },
    ];

    const service = new BootstrapService(phases);
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    await service.run();
    unsubscribe();

    expect(listener).toHaveBeenCalled();
  });
});

describe('bootstrap phases', () => {
  it('sqlite phase initializes successfully', async () => {
    const { initializeSQLite } = await import('../phases/sqlite.js');

    // SQLite should always succeed since it uses in-memory for tests
    const result = await initializeSQLite();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Clean up the connection
      result.value.close();
    }
  });

  it('schema phase returns error when db missing', async () => {
    const { validateSchema } = await import('../phases/schema.js');
    const result = await validateSchema({});

    expect(result.ok).toBe(false);
  });

  it('collections phase returns ok in client mode (no db required)', async () => {
    const { initializeCollections } = await import('../phases/collections.js');
    const result = await initializeCollections({});

    // In client mode, collections don't require db - data comes from API
    expect(result.ok).toBe(true);
  });

  it('streams phase returns ok when Caddy is not reachable (non-fatal in dev)', async () => {
    const { connectStreams } = await import('../phases/streams.js');
    const { isStreamsAvailable } = await import('../../streams/client.js');

    // Mock fetch to simulate Caddy being unreachable
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await connectStreams();

    // Restore fetch
    globalThis.fetch = originalFetch;

    // Should return ok — streams are optional, app still boots without them
    expect(result.ok).toBe(true);
    // Verify streamsAvailable was set to false
    expect(isStreamsAvailable()).toBe(false);
  });

  it('streams phase enables streams when server returns 404 with stream headers', async () => {
    const { connectStreams } = await import('../phases/streams.js');
    const { isStreamsAvailable } = await import('../../streams/client.js');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({
        'access-control-allow-headers': 'content-type, Stream-Seq, Stream-TTL',
      }),
    });

    const result = await connectStreams();
    globalThis.fetch = originalFetch;

    expect(result.ok).toBe(true);
    expect(isStreamsAvailable()).toBe(true);
  });

  it('github phase returns ok when token missing', async () => {
    const { validateGitHub } = await import('../phases/github.js');
    const originalToken = process.env.GITHUB_TOKEN;

    delete process.env.GITHUB_TOKEN;
    const result = await validateGitHub({});

    expect(result.ok).toBe(true);

    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('seeding phase returns error when db missing', async () => {
    const { seedDefaults } = await import('../phases/seeding.js');
    const result = await seedDefaults({});

    expect(result.ok).toBe(false);
  });
});

// Hook/provider tests will be added in UI layer once React tooling is present.
