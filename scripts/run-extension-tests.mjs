import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const version = argument('--version', 'stable');
const grep = argument('--grep', '');
const allowExtensionRecommendations = process.argv.includes('--host-noise-probe');
const hostNoiseProbe = allowExtensionRecommendations
  || process.argv.includes('--host-noise-probe-ignore-recommendations');
const officialSchemaGateProbe = process.argv.includes('--official-schema-gate');
const uiAdapterMode = officialSchemaGateProbe ? 'production-gate' : 'synthetic-simulation';
const repoRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ymai extension 测试-'));
const rootA = join(temporaryRoot, '元梦 项目甲');
const rootB = join(temporaryRoot, 'Project Beta');
const workspacePath = join(temporaryRoot, '双工程.code-workspace');
const testBundle = join(repoRoot, 'out', 'extension-tests.cjs');

try {
  await import(new URL('../esbuild.mjs', import.meta.url));
  for (const root of [rootA, rootB]) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
  }
  await writeFile(workspacePath, JSON.stringify({
    folders: [{ path: rootA }, { path: rootB }],
    settings: { 'extensions.ignoreRecommendations': !allowExtensionRecommendations },
  }), 'utf8');
  await esbuild.build({
    entryPoints: [join(repoRoot, 'test', 'extension', 'index.ts')],
    outfile: testBundle,
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    legalComments: 'none',
    platform: 'node',
    target: 'node16.13',
  });
  process.env.YMAI_EXTENSION_TEST_GREP = grep;
  process.env.YMAI_EXTENSION_TEST_ROOT_A = rootA;
  process.env.YMAI_EXTENSION_TEST_ROOT_B = rootB;
  process.env.YMAI_EXTENSION_TEST_TEMP = temporaryRoot;
  process.env.YMAI_EXTENSION_TEST_UI_ADAPTER = uiAdapterMode;
  process.env.YMAI_HOST_NOISE_PROBE = hostNoiseProbe ? '1' : '0';
  process.env.YMAI_OFFICIAL_SCHEMA_GATE_PROBE = officialSchemaGateProbe ? '1' : '0';
  await runTests({
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: testBundle,
    extensionTestsEnv: {
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot,
      PUBLIC: process.env.PUBLIC ?? join(dirname(process.env.USERPROFILE ?? 'C:\\Users\\Default'), 'Public'),
      YMAI_EXTENSION_TEST_UI_ADAPTER: uiAdapterMode,
      YMAI_HOST_NOISE_PROBE: hostNoiseProbe ? '1' : '0',
      YMAI_OFFICIAL_SCHEMA_GATE_PROBE: officialSchemaGateProbe ? '1' : '0',
    },
    launchArgs: [`"${workspacePath}"`],
    version,
  });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
