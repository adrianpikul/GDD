import { chmod } from 'node:fs/promises';
import { argv } from 'node:process';
import { build, context } from 'esbuild';

const output = 'dist/cli.js';
const options = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: output,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  plugins: [
    {
      name: 'make-cli-executable',
      setup(buildApi) {
        buildApi.onEnd(async (result) => {
          if (!result.errors.length) await chmod(output, 0o755);
        });
      }
    }
  ]
};

if (argv.includes('--watch')) {
  const buildContext = await context(options);
  await buildContext.watch();
} else {
  await build(options);
}
