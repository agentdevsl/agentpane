/**
 * Integration test for theme-04 W2-D-FIX (F04-04, F04-05): AgentCore lazy loading.
 *
 * Verifies that when `AGENTCORE_ENABLED=false` (the default), importing and
 * constructing `ContainerAgentService` does NOT pull any AgentCore-specific
 * module into the runtime module graph:
 *
 *   - src/services/container-agent/agentcore-bridge.service.ts (~561 LOC)
 *   - src/lib/agents/agentcore-bridge.ts (SSE→DurableStreams glue)
 *   - src/lib/sandbox/providers/agentcore-sandbox-provider.ts
 *   - src/lib/sandbox/providers/agentcore-sandbox-instance.ts (hand-rolled
 *     SigV4 signer, ~110 LOC of crypto code)
 *
 * And conversely, that with `AGENTCORE_ENABLED=true` calling
 * `setAgentCoreProvider()` DOES load all four modules.
 *
 * Test strategy: spawn a child Bun process for each scenario. The child
 * imports the service module, calls the relevant setup APIs, then probes
 * Bun's module loader registry (`Loader.registry` via `bun:jsc` /
 * `Bun.resolveSync`) and prints a JSON summary of which AgentCore-related
 * paths have been loaded. The parent test asserts the expected pattern.
 *
 * Why a child process: vitest's worker shares a single module cache across
 * the test file. We need a fresh module graph per scenario to verify the
 * load-or-skip behavior cleanly. A child process gives us that.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

// ── Probe script ──────────────────────────────────────────────────────────────
//
// Runs inside a child Bun process. It imports ContainerAgentService, optionally
// calls setAgentCoreProvider, then walks `require.cache` (CommonJS) and Bun's
// loaded-module list to see which AgentCore-related modules are present.

const PROBE_SCRIPT = `
import { ContainerAgentService } from '${REPO_ROOT}/src/services/container-agent/container-agent.service.ts';

// Build a minimal, in-memory ContainerAgentService.
//
// The constructor never touches DB / streams / git when neither startAgent nor
// any provider configuration is invoked, so a stub-shaped object is safe for
// the lazy-load probe.
const stubDb = {
  query: { tasks: { findMany: async () => [] }, codespaces: { findFirst: async () => null } },
};
const stubProvider = { name: 'docker' };
const stubStreams = { publish: async () => {}, createStream: async () => {} };
const stubApiKey = { getDecryptedKey: async () => null };

const service = new ContainerAgentService(
  stubDb,
  stubProvider,
  stubStreams,
  stubApiKey
);

// If the parent passed --set-agentcore-provider, wire it up. This requires
// AGENTCORE_ENABLED=true to actually load the bridge service — otherwise it's
// a no-op (the gate logs a warning and skips).
if (process.argv.includes('--set-agentcore-provider')) {
  await service.setAgentCoreProvider({
    region: 'us-east-1',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/stub',
  });
}

// Probe Bun's module loader for known AgentCore paths. \`Bun.resolveSync\`
// throws if the path isn't already loaded into the registry; \`Bun.resolve\`
// without options returns whatever the loader has indexed (loaded or not).
//
// We instead inspect the global module registry via the documented
// \`process.moduleLoadList\` (Node) or, on Bun, fall back to a heuristic: a
// dynamic import that has not occurred is invisible to the loader UNLESS the
// path was statically resolved at compile time, but Bun's static-import
// resolver does NOT add paths to the registry without a runtime load.
//
// Cleanest cross-runtime check: try to enumerate ESM \`registry\` via the
// \`process.binding('module_wrap')\` native binding when running on Node, or
// inspect Bun's \`Loader.registry\`.
//
// For a robust signal, we do the following: each AgentCore module exports a
// well-known sentinel symbol when loaded. We stash them on \`globalThis\`
// at load time. The probe then reads back the global to see which ones fired.

const sentinelKeys = {
  bridgeService: '__agentpane_loaded_agentcore_bridge_service',
  bridgeLib: '__agentpane_loaded_agentcore_bridge',
  sandboxProvider: '__agentpane_loaded_agentcore_sandbox_provider',
  sandboxInstance: '__agentpane_loaded_agentcore_sandbox_instance',
};

const result = {
  bridgeService: Boolean(globalThis[sentinelKeys.bridgeService]),
  bridgeLib: Boolean(globalThis[sentinelKeys.bridgeLib]),
  sandboxProvider: Boolean(globalThis[sentinelKeys.sandboxProvider]),
  sandboxInstance: Boolean(globalThis[sentinelKeys.sandboxInstance]),
  agentcoreEnabled: process.env.AGENTCORE_ENABLED === 'true',
  serviceConstructed: typeof service === 'object',
};

console.log(JSON.stringify(result));

// Explicitly tear down the service so the plan-cleanup interval (set by
// SandboxStateManager) does not keep the process alive. Without this, the
// probe hangs until the parent's spawnSync timeout kicks in.
service.dispose();
// Force-exit to release any other handles (durable streams clients, etc).
process.exit(0);
`.trim();

// ── Sentinel injection ────────────────────────────────────────────────────────
//
// The probe script relies on each AgentCore module exporting a side-effectful
// \`globalThis\` write. Rather than modifying production code, we patch the four
// modules with a tiny preload hook that wraps their default behavior.

const PRELOAD_SCRIPT = `
// Preload hook installed before the probe script imports anything.
// Patches Bun's module loader so that when one of the AgentCore source files
// is loaded, a sentinel is set on globalThis. Production code is unchanged.

import { plugin } from 'bun';

const sentinelMap = {
  '/src/services/container-agent/agentcore-bridge.service.ts': '__agentpane_loaded_agentcore_bridge_service',
  '/src/lib/agents/agentcore-bridge.ts': '__agentpane_loaded_agentcore_bridge',
  '/src/lib/sandbox/providers/agentcore-sandbox-provider.ts': '__agentpane_loaded_agentcore_sandbox_provider',
  '/src/lib/sandbox/providers/agentcore-sandbox-instance.ts': '__agentpane_loaded_agentcore_sandbox_instance',
};

plugin({
  name: 'agentcore-load-tracker',
  setup(build) {
    build.onLoad({ filter: /\\/agentcore-(bridge|bridge\\.service|sandbox-provider|sandbox-instance)\\.ts$/ }, async (args) => {
      const fs = await import('node:fs/promises');
      const original = await fs.readFile(args.path, 'utf8');
      // Find the matching sentinel
      let sentinel = null;
      for (const [suffix, key] of Object.entries(sentinelMap)) {
        if (args.path.endsWith(suffix)) {
          sentinel = key;
          break;
        }
      }
      if (!sentinel) return { contents: original, loader: 'ts' };
      // Prepend the side effect so it executes the moment the module is loaded.
      const patched = \`globalThis['\${sentinel}'] = true;\\n\` + original;
      return { contents: patched, loader: 'ts' };
    });
  },
});
`.trim();

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agentcore-lazy-load-'));
});

afterAll(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

interface ProbeResult {
  bridgeService: boolean;
  bridgeLib: boolean;
  sandboxProvider: boolean;
  sandboxInstance: boolean;
  agentcoreEnabled: boolean;
  serviceConstructed: boolean;
}

function runProbe(opts: { agentcoreEnabled: boolean; setAgentCoreProvider: boolean }): ProbeResult {
  const probePath = join(workDir, `probe-${Date.now()}-${Math.random()}.ts`);
  const preloadPath = join(workDir, `preload-${Date.now()}-${Math.random()}.ts`);
  writeFileSync(probePath, PROBE_SCRIPT, 'utf8');
  writeFileSync(preloadPath, PRELOAD_SCRIPT, 'utf8');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (opts.agentcoreEnabled) {
    env.AGENTCORE_ENABLED = 'true';
  } else {
    delete env.AGENTCORE_ENABLED;
  }

  // Bun argument order: `bun --preload <preload> <script> [args...]`.
  // Putting `run` between `--preload` and the script causes Bun to interpret
  // `run` as a subcommand and list package.json scripts.
  const args = ['--preload', preloadPath, probePath];
  if (opts.setAgentCoreProvider) {
    args.push('--set-agentcore-provider');
  }

  const result = spawnSync('bun', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
    timeout: 30_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `Probe exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    );
  }

  // The probe prints exactly one JSON line. There may be other console output
  // (e.g. AgentPane logger) before it — extract the last well-formed JSON
  // object from stdout.
  const lines = result.stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.startsWith('{')) continue;
    try {
      return JSON.parse(line) as ProbeResult;
    } catch {
      // Try the next-most-recent line
    }
  }
  throw new Error(
    `No JSON probe result found in stdout:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
  );
}

describe('AgentCore lazy loading (theme-04 W2-D-FIX, F04-04 / F04-05)', () => {
  it('AGENTCORE_ENABLED=false: ContainerAgentService construction loads NO AgentCore modules', () => {
    const result = runProbe({ agentcoreEnabled: false, setAgentCoreProvider: false });

    // Sanity
    expect(result.agentcoreEnabled).toBe(false);
    expect(result.serviceConstructed).toBe(true);

    // The whole point of the fix: zero AgentCore code in the loaded graph.
    expect(result.bridgeService).toBe(false);
    expect(result.bridgeLib).toBe(false);
    expect(result.sandboxProvider).toBe(false);
    expect(result.sandboxInstance).toBe(false);
  });

  it('AGENTCORE_ENABLED=false + setAgentCoreProvider call: still NO AgentCore modules (gate blocks load)', () => {
    const result = runProbe({ agentcoreEnabled: false, setAgentCoreProvider: true });

    expect(result.agentcoreEnabled).toBe(false);
    expect(result.serviceConstructed).toBe(true);

    // setAgentCoreProvider short-circuits when the flag is off, so the
    // dynamic imports for both the provider and the bridge service never
    // execute — none of the AgentCore graph is reachable.
    expect(result.bridgeService).toBe(false);
    expect(result.bridgeLib).toBe(false);
    expect(result.sandboxProvider).toBe(false);
    expect(result.sandboxInstance).toBe(false);
  });

  it('AGENTCORE_ENABLED=true + setAgentCoreProvider call: ALL AgentCore modules load', () => {
    const result = runProbe({ agentcoreEnabled: true, setAgentCoreProvider: true });

    expect(result.agentcoreEnabled).toBe(true);
    expect(result.serviceConstructed).toBe(true);

    // Provider load is the entry that drags in the SigV4 signer
    // (agentcore-sandbox-instance.ts) and the AWS SDK.
    expect(result.sandboxProvider).toBe(true);
    expect(result.sandboxInstance).toBe(true);

    // Bridge service load was triggered by setAgentCoreProvider via
    // loadAgentCoreBridge().
    expect(result.bridgeService).toBe(true);
    // bridge-lib (lib/agents/agentcore-bridge.ts) is a runtime dependency of
    // the bridge service.
    expect(result.bridgeLib).toBe(true);
  });

  it('AGENTCORE_ENABLED=true (no setAgentCoreProvider): bridge & provider stay UNLOADED until needed', () => {
    // Even with the flag on, simply constructing ContainerAgentService should
    // not trigger any AgentCore module load. The lazy contract is: load only
    // when setAgentCoreProvider() (or a startAgent path) actually needs it.
    const result = runProbe({ agentcoreEnabled: true, setAgentCoreProvider: false });

    expect(result.agentcoreEnabled).toBe(true);
    expect(result.serviceConstructed).toBe(true);

    expect(result.bridgeService).toBe(false);
    expect(result.bridgeLib).toBe(false);
    expect(result.sandboxProvider).toBe(false);
    expect(result.sandboxInstance).toBe(false);
  });
});
