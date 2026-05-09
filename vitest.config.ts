import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const sharedExclude = [
  '**/node_modules/**',
  'node_modules',
  'dist',
  '.claude',
  '.worktrees',
  'submodule',
  '**/_archived/**',
  'packages/**',
  'tests/diagram-overlap.spec.ts',
];

const sharedResolve = {
  alias: {
    '@': resolve(__dirname, './src'),
    '@agentpane/agent-sandbox-sdk': resolve(__dirname, './packages/agent-sandbox-sdk/src/index.ts'),
    '@agentpane/nomad-sandbox-sdk': resolve(__dirname, './packages/nomad-sandbox-sdk/src/index.ts'),
  },
};

const sharedAlias = {
  '@/db/client': resolve(__dirname, './src/db/client.ts'),
  '@/services/agent.service': resolve(__dirname, './src/services/agent.service.ts'),
  '@/services/session.service': resolve(__dirname, './src/services/session.service.ts'),
  '@/services/task.service': resolve(__dirname, './src/services/task.service.ts'),
  '@/services/worktree.service': resolve(__dirname, './src/services/worktree.service.ts'),
  '@/services/project.service': resolve(__dirname, './src/services/project.service.ts'),
};

export default defineConfig({
  resolve: sharedResolve,
  test: {
    projects: [
      // Project 1: Unit tests — pure logic, no DB, no DOM
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          setupFiles: ['./tests/setup-unit.ts'],
          env: {
            PGLITE_DATA_DIR: '',
          },
          include: [
            'tests/lib/**/*.{test,spec}.{ts,tsx}',
            'tests/mocks/**/*.{test,spec}.{ts,tsx}',
            'tests/routes/**/*.{test,spec}.{ts,tsx}',
            'src/lib/**/*.{test,spec}.ts',
            'src/**/__tests__/**/*.{test,spec}.ts',
          ],
          exclude: [
            ...sharedExclude,
            'tests/lib/agents/container-bridge.test.ts',
            'tests/lib/utils/path-safety.test.ts',
            'tests/lib/remaining.test.ts',
            'tests/lib/api/client-full.test.ts',
            'src/lib/sandbox/__tests__/git-token-resolver.test.ts',
            '**/*.test.tsx',
          ],
          alias: sharedAlias,
          pool: 'threads',
          testTimeout: 10000,
          hookTimeout: 10000,
        },
        resolve: sharedResolve,
      },
      // Project 2: jsdom tests — component tests needing DOM
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./tests/setup-jsdom.ts'],
          env: {
            PGLITE_DATA_DIR: '',
          },
          include: [
            'tests/components/**/*.{test,spec}.{ts,tsx}',
            'tests/hooks/**/*.{test,spec}.{ts,tsx}',
            'tests/lib/api/client-full.test.ts',
            'tests/lib/remaining.test.ts',
            '**/*.test.tsx',
          ],
          exclude: sharedExclude,
          alias: sharedAlias,
          pool: 'threads',
          testTimeout: 10000,
          hookTimeout: 10000,
        },
        resolve: sharedResolve,
      },
      // Project 3: DB tests — service tests needing SQLite (forks for process isolation)
      {
        test: {
          name: 'db',
          environment: 'node',
          globals: true,
          setupFiles: ['./tests/setup.ts'],
          env: {
            PGLITE_DATA_DIR: '',
          },
          include: [
            'tests/services/**/*.{test,spec}.{ts,tsx}',
            'tests/api/**/*.{test,spec}.{ts,tsx}',
            'tests/server/**/*.{test,spec}.{ts,tsx}',
            'tests/db/**/*.{test,spec}.{ts,tsx}',
            'tests/lib/agents/container-bridge.test.ts',
            'tests/lib/agents/container-bridge-token-batch.test.ts',
            'tests/lib/utils/path-safety.test.ts',
            'src/lib/sandbox/__tests__/git-token-resolver.test.ts',
          ],
          exclude: sharedExclude,
          alias: sharedAlias,
          pool: 'forks',
          testTimeout: 10000,
          hookTimeout: 10000,
        },
        resolve: sharedResolve,
      },
      // Project 4: Integration tests — end-to-end service workflows (separate CI job)
      {
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          setupFiles: ['./tests/setup.ts'],
          include: ['tests/integration/**/*.{test,spec}.{ts,tsx}'],
          exclude: sharedExclude,
          alias: sharedAlias,
          pool: 'forks',
          testTimeout: 30000,
          hookTimeout: 15000,
        },
        resolve: sharedResolve,
      },
      // Project 5: Functional E2E tests — full pipeline workflows (run separately)
      {
        test: {
          name: 'functional',
          environment: 'node',
          globals: true,
          setupFiles: ['./tests/setup.ts'],
          include: ['tests/functional/**/*.{test,spec}.{ts,tsx}'],
          exclude: sharedExclude,
          alias: sharedAlias,
          pool: 'forks',
          testTimeout: 60000,
          hookTimeout: 30000,
        },
        resolve: sharedResolve,
      },
    ],
    // Coverage stays at the top level
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.{test,spec}.tsx',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/index.ts',
        'src/app/**/*.ts',
        'src/app/**/*.tsx',
        'src/types/**/*.ts',
        'src/lib/types/**/*.ts',
        'src/lib/sandbox/providers/_archived/**',
        'src/lib/vite-stubs/**',
        // Browser-only modules: TanStack DB collections, React hooks, and
        // UI-side data shaping. These are exercised by the `unit`/`jsdom`
        // projects and have dedicated colocated/`tests/lib/**` suites; they
        // cannot be reached from server-side integration/functional tests
        // and inflate the "uncovered" denominator without being dead code.
        'src/lib/sessions/**',
        'src/lib/task-creation/**',
        'src/lib/topology/**',
        'src/lib/hooks/**',
        // CLI Monitor and Sandbox Status are TanStack DB collections + SSE
        // sync routed into them. Same browser-only pattern as the modules
        // above — only consumed from `src/app/**` (which is itself excluded).
        // Server-side integration/functional tests cannot reach them.
        'src/lib/cli-monitor/**',
        'src/lib/sandbox-status/**',
        // Browser-side API client (file header literally states "Browser-side
        // API client"). Consumed by route loaders and components only; covered
        // by jsdom-project tests (see tests/lib/api/client-full.test.ts).
        'src/lib/api/client.ts',
        // Browser-side DurableStreams client (file header: "Client-side wrapper
        // for durable streams"). Uses EventSource + window globals. Covered by
        // tests/integration/streams-client-parsing.test.ts at the parser level
        // and by jsdom hooks tests; the live EventSource path is browser-only.
        'src/lib/streams/client.ts',
        // Browser-only token encryption built on Web Crypto API + localStorage.
        // Mirrored by the server-side `src/lib/crypto/server-encryption.ts`
        // for backend code. Covered by `tests/lib/crypto/crypto.test.ts` in
        // the unit/jsdom projects; cannot run under integration/functional.
        'src/lib/crypto/token-encryption.ts',
        // Browser-side bootstrap orchestrator (file header: "Database runs on
        // server - client uses API endpoints"). Pairs with `BootstrapProvider`
        // in `src/app/**`. Cannot reach server-side test projects.
        'src/lib/bootstrap/service.ts',
        // ELK-based workflow designer layout — UI-only. The workflow designer
        // route is tested via routes/__tests__ but the layout helpers run in
        // the browser only.
        'src/lib/workflow-dsl/**',
        // Server entry point. `src/server/api.ts` is the binary that calls
        // `Bun.serve()` and `src/server/bootstrap/server-bootstrap.ts` is the
        // pipeline it delegates to. Importing either from a test would start
        // an actual HTTP server; they are exercised in CI by the live-server
        // smoke test, not by integration/functional projects.
        'src/server/api.ts',
        'src/server/bootstrap/server-bootstrap.ts',
        // Separate npm packages with their own published tests; not part of
        // the server runtime under measurement.
        'packages/**',
      ],
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      // Re-baselined 2026-05-09 after slice POLISH-2 deleted the legacy
      // src/server/routes/sandbox.ts duplicate. CI command runs all five
      // projects (unit + jsdom + db + integration + functional --coverage),
      // measured: statements 87.45%, branches 77.51%, functions 81.59%,
      // lines 88.06%.
      //
      // Thresholds are floor(actual − 2) on each metric; ratchet up further
      // once a week of post-merge data confirms stability.
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 79,
        lines: 86,
      },
    },
  },
});
