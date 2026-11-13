import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [preact()],
  build: { outDir: fileURLToPath(new URL('../dist/web', import.meta.url)), emptyOutDir: true, target: 'es2019', assetsInlineLimit: 4096 },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
