import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  outExtensions: () => ({ js: '.js' }),
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  sourcemap: true
});
