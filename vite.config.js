import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  define: { __BUILD_VERSION__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 12) || Date.now().toString(36)) },
  worker: { format: 'iife' },
  build: { target: 'es2022' }
});
