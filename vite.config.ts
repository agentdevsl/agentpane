import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';
import { getStubCode, getStubId, SERVER_TOOL_MODULES } from './src/lib/vite-stubs/browser-stubs';

const stubPath = resolve(__dirname, 'src/lib/agents/tools/browser-stubs.ts');

/**
 * Plugin to replace server-only agent tools with browser stubs.
 * This prevents Node.js modules from being bundled for the browser.
 */
function serverOnlyStubs(): Plugin {
  return {
    name: 'server-only-stubs',
    enforce: 'pre',
    resolveId(source, _importer) {
      // Match imports of server-only tools by their file path patterns
      const normalized = source.replace(/\.(js|ts)$/, '');

      for (const mod of SERVER_TOOL_MODULES) {
        if (normalized.endsWith(mod) || normalized.endsWith(`/${mod}`)) {
          return stubPath;
        }
      }

      // Check if this module has a stub
      const stubId = getStubId(source);
      if (stubId) {
        return stubId;
      }

      return null;
    },
    load(id) {
      // Load stub code if available
      const stubCode = getStubCode(id);
      if (stubCode) {
        return stubCode;
      }

      return null;
    },
  };
}

export default defineConfig({
  define: {
    'process.env': JSON.stringify({}),
    // Note: do not include secrets here.
    'import.meta.env.VITE_E2E_SEED': JSON.stringify(process.env.VITE_E2E_SEED),
  },
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || 'localhost',
    proxy: {
      // Proxy API requests to the backend server
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Disable both incoming and outgoing proxy timeouts for long-lived SSE connections
        timeout: 0,
        proxyTimeout: 0,
      },
      // Proxy durable streams to dev streams server
      '/v1/stream': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    TanStackRouterVite({
      routesDirectory: './src/app/routes',
      generatedRouteTree: './src/app/routeTree.gen.ts',
      routeFileIgnorePattern: '.*\\/api\\/.*',
    }),
    react(),
    serverOnlyStubs(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    exclude: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
  worker: {
    format: 'es',
  },
  ssr: {
    external: ['better-sqlite3'],
  },
});
