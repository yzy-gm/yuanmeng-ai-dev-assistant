import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT_FILES = ['.gitignore', '.vscodeignore', 'AGENTS.md', 'README.md', 'CHANGELOG.md', 'RELEASE_NOTES.md',
  'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json',
  'package.nls.json', 'package.nls.en.json', 'esbuild.mjs', 'eslint.config.mjs',
  'tsconfig.json', 'tsconfig.cli.json', 'tsconfig.extension.json', 'vitest.config.ts'];
const PUBLIC_DOCS = ['docs/mcp.md', 'docs/editor-acceptance-checklist.md', 'docs/public-release.md'];

export async function publicFiles(root) {
  const files = [...ROOT_FILES, ...PUBLIC_DOCS];
  async function walk(relativePath) {
    // Test executions can leave project caches beside synthetic Lua fixtures.
    if (relativePath.split('/').includes('.yuanmeng-inspector')) return;
    if (relativePath.split('/').some((part) => ['.git', '.yuanmeng-inspector', 'node_modules', 'outputs', 'work'].includes(part) || part === '.env' || part.startsWith('.env.'))) {
      throw new Error(`Private or generated directory refused: ${relativePath}`);
    }
    const metadata = await lstat(join(root, relativePath));
    if (metadata.isSymbolicLink()) throw new Error(`Symlink refused: ${relativePath}`);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(join(root, relativePath))).sort()) await walk(`${relativePath}/${name}`);
    } else if (metadata.isFile()) files.push(relativePath);
    else throw new Error(`Unsupported entry: ${relativePath}`);
  }
  for (const directory of ['src', 'test', 'scripts', 'schemas', 'media']) await walk(directory);
  for (const file of files) {
    if (!(await lstat(join(root, file))).isFile()) throw new Error(`Not a file: ${file}`);
  }
  return files.sort();
}

export async function checkPublicMetadata(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (manifest.publisher !== 'bujianxingguang' || manifest.name !== 'yuanmeng-ai-dev-assistant') throw new Error('Extension identity changed');
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version) || manifest.license !== 'MIT') throw new Error('Stable MIT metadata required');
  if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version || lock.packages[''].license !== 'MIT') throw new Error('Lock metadata mismatch');
  if (manifest.repository?.url !== 'https://github.com/yzy-gm/yuanmeng-ai-dev-assistant.git') throw new Error('Repository mismatch');
  if (!(await readFile(join(root, 'LICENSE'), 'utf8')).includes('Permission is hereby granted')) throw new Error('MIT text missing');
  return manifest;
}
