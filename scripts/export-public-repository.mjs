import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPublicMetadata, publicFiles } from './public-release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const index = args.indexOf('--destination');
let result;
try {
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--destination is required');
  const destination = resolve(args[index + 1]);
  if (await lstat(destination).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
    result = { ok: false, code: 'DESTINATION_EXISTS' };
  } else {
    // Refuse symlinked parents and paths inside runtime/source directories.
    const parent = await realpath(dirname(destination));
    if (parent.toLowerCase() !== dirname(destination).toLowerCase()) throw new Error('Destination parent must not be a symlink');
    const local = relative(root, destination).replaceAll('\\', '/');
    if (!local.startsWith('../') && !local.startsWith('outputs/') && !local.includes(':')) throw new Error('Use outputs/ or a separate destination');
    const manifest = await checkPublicMetadata(root);
    const files = await publicFiles(root);
    await mkdir(destination);
    const hashes = [];
    for (const file of files) {
      const target = join(destination, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, file), target);
      hashes.push({ path: file, sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
    }
    // The export never contains .git, so this audit cannot invoke Git inventory/history.
    const audit = spawnSync(process.execPath, [join(root, 'scripts/privacy-audit.mjs'), '--root', destination, '--json'], { encoding: 'utf8' });
    if (audit.status !== 0) {
      result = { ok: false, code: 'PRIVACY_AUDIT_FAILED', audit: JSON.parse(audit.stdout || '{}') };
    } else {
      await writeFile(join(destination, 'SOURCE_MANIFEST.json'), `${JSON.stringify({ version: manifest.version, files: hashes }, null, 2)}\n`);
      result = { ok: true, code: 'PUBLIC_SOURCE_READY', version: manifest.version, files: files.length, destination };
    }
  }
} catch (error) {
  result = { ok: false, code: 'EXPORT_FAILED', message: error.message };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.ok) process.exitCode = 1;
