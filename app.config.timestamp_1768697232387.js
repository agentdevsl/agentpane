// app.config.ts

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from '@tanstack/react-start/config';

var app_config_default = defineConfig({
  vite: {
    plugins: () => [tailwindcss()],
    resolve: {
      alias: {
        '@': new URL('./src', import.meta.url).pathname,
      },
    },
  },
  server: {
    preset: 'node-server',
  },
});

export { app_config_default as default };
