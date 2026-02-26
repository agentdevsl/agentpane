import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Run smoke tests first to verify server health before other tests
    include: ['tests/e2e/smoke.test.ts', 'tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/k8s/**'],
    testTimeout: 60000,
    hookTimeout: 30000,
    setupFiles: ['./tests/e2e/setup.ts'],
    sequence: {
      concurrent: false,
    },
    maxConcurrency: 1,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
