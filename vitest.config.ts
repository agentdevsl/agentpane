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
      ],
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      // Baseline measured 2026-04-21 on unit+jsdom+db projects:
      // statements 68.19%, branches 59.44%, functions 62.96%, lines 68.70%.
      // Thresholds are floor(actual - 5) to current floor; ratchet up once we
      // have a week of post-merge data.
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
    },
  },
});
