import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git', '.vscode-test', '.yuanmeng-inspector', 'coverage', 'node_modules', 'out', 'outputs', 'work',
]);

function normalizeRelative(value) {
  return value.split(sep).join('/');
}

function excludedFile(relativePath) {
  const name = basename(relativePath);
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.vsix')
    || name.endsWith('.log') || name.endsWith('.map')
    || name === 'LayerData.dat' || name === 'LayerData-Auto.dat' || name === 'LayerData.pbin';
}

async function collectFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const relativePath = normalizeRelative(relative(root, absolute));
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile() && !excludedFile(relativePath)) files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function gitValue(root, args, fallback) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Creates a private, local rollback baseline. Generated folders, caches,
 * editor-derived private data and environment-secret files are excluded.
 * Nothing is committed, pushed, uploaded or written outside outputs/private.
 */
export async function createPrivateSourceBaseline(options) {
  const root = resolve(options.root);
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!createdAt.endsWith('Z') || !Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be UTC ISO 8601');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const stamp = createdAt.replaceAll(':', '-').replaceAll('.', '-');
  const outputDirectory = join(root, 'outputs', 'private', 'rollback', stamp);
  await mkdir(outputDirectory, { recursive: true });
  const files = await collectFiles(root);
  if (files.length === 0) throw new Error('No eligible source files found');
  const listPath = join(outputDirectory, 'source-files.txt');
  const archivePath = join(outputDirectory, 'source.tar.gz');
  const manifestPath = join(outputDirectory, 'manifest.json');
  await writeFile(listPath, `${files.join('\n')}\n`, 'utf8');
  execFileSync('tar', ['-czf', archivePath, '-C', root, '-T', listPath], { stdio: 'pipe' });
  const manifest = {
    schemaVersion: 1,
    createdAt,
    extensionVersion: packageJson.version,
    gitHead: options.gitHead ?? gitValue(root, ['rev-parse', 'HEAD'], 'unavailable'),
    gitBranch: options.gitBranch ?? gitValue(root, ['branch', '--show-current'], 'unavailable'),
    archiveSha256: await sha256File(archivePath),
    fileCount: files.length,
    archiveRelativePath: normalizeRelative(relative(root, archivePath)),
    exclusions: [...EXCLUDED_DIRECTORY_NAMES].sort(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { archivePath, manifestPath, listPath, manifest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = process.argv[2] ?? process.cwd();
  const result = await createPrivateSourceBaseline({ root });
  process.stdout.write(`${JSON.stringify(result.manifest)}\n`);
}
