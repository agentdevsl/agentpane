import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    env: {
      PGLITE_DATA_DIR: '',
    },
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      'node_modules',
      'dist',
      '.claude',
      '.worktrees',
      'submodule',
      '**/_archived/**',
      'packages/**',
      'tests/diagram-overlap.spec.ts',
    ],
    alias: {
      '@/db/client': resolve(__dirname, './src/db/client.ts'),
      '@/services/agent.service': resolve(__dirname, './src/services/agent.service.ts'),
      '@/services/session.service': resolve(__dirname, './src/services/session.service.ts'),
      '@/services/task.service': resolve(__dirname, './src/services/task.service.ts'),
      '@/services/worktree.service': resolve(__dirname, './src/services/worktree.service.ts'),
      '@/services/project.service': resolve(__dirname, './src/services/project.service.ts'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.{test,spec}.tsx',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/index.ts',
        // TODO: P1-4 — Remove src/app/ exclusion once frontend tests added
        'src/app/**/*.ts',
        'src/app/**/*.tsx',
        'src/types/**/*.ts',
        'src/lib/types/**/*.ts',
        'src/lib/sandbox/providers/_archived/**',
        'src/lib/vite-stubs/**',
      ],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        statements: 70,
        branches: 62,
        functions: 66,
        lines: 70,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@agentpane/agent-sandbox-sdk': resolve(
        __dirname,
        './packages/agent-sandbox-sdk/src/index.ts'
      ),
      '@agentpane/nomad-sandbox-sdk': resolve(
        __dirname,
        './packages/nomad-sandbox-sdk/src/index.ts'
      ),
    },
  },
});
