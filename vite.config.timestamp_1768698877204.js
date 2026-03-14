// vite.config.ts
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';

var stubPath = resolve(__dirname, 'src/lib/agents/tools/browser-stubs.ts');
function serverOnlyStubs() {
  return {
    name: 'server-only-stubs',
    enforce: 'pre',
    resolveId(source) {
      const serverModules = ['bash-tool', 'file-tools', 'search-tools'];
      const normalized = source.replace(/\.(js|ts)$/, '');
      for (const mod of serverModules) {
        if (normalized.endsWith(mod) || normalized.endsWith(`/${mod}`)) {
          return stubPath;
        }
      }
      return null;
    },
  };
}
var vite_config_default = defineConfig({
  server: {
    port: Number(process.env.PORT) || 3e3,
    host: process.env.HOST || 'localhost',
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    TanStackRouterVite({
      routesDirectory: './src/app/routes',
      generatedRouteTree: './src/app/routeTree.gen.ts',
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
    exclude: ['@anthropic-ai/claude-agent-sdk'],
  },
});

export { vite_config_default as default };
