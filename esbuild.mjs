import { mkdir } from 'node:fs/promises';
import * as esbuild from 'esbuild';

await mkdir('out', { recursive: true });

await Promise.all([
  esbuild.build({
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'out/extension.cjs',
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    legalComments: 'none',
    minify: false,
    platform: 'node',
    sourcemap: false,
    target: 'node16.13'
  }),
  esbuild.build({
    banner: { js: '#!/usr/bin/env node' },
    entryPoints: ['src/cli/main.ts'],
    outfile: 'out/cli.cjs',
    bundle: true,
    format: 'cjs',
    legalComments: 'none',
    minify: false,
    platform: 'node',
    sourcemap: false,
    target: 'node20'
  })
]);
