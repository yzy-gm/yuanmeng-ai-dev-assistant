import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkPublicMetadata } from './public-release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function node(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${script} failed (${result.status})`);
}
try {
  const manifest = await checkPublicMetadata(root);
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
  const directory = join(root, 'outputs', 'public', stamp);
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'source');
  node('scripts/generate-marketplace-icon.mjs');
  node('scripts/export-public-repository.mjs', ['--destination', source, '--json']);
  node('esbuild.mjs');
  const vsix = join(directory, `${manifest.name}-${manifest.version}.vsix`);
  node('node_modules/@vscode/vsce/vsce', ['package', '--out', vsix]);
  node('scripts/inspect-vsix.mjs', [vsix, '--json']);
  const result = {
    version: manifest.version, extensionId: `${manifest.publisher}.${manifest.name}`,
    source, vsix, sha256: createHash('sha256').update(await readFile(vsix)).digest('hex'),
    published: false,
  };
  await writeFile(join(directory, 'release-artifacts.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
