import { defineConfig } from 'vite';
export default defineConfig({ base: './', worker: { format: 'iife' }, build: { target: 'es2022' } });
