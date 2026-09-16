import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublicMetadata, publicFiles } from './public-release-files.mjs';

try {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await checkPublicMetadata(root);
  const files = await publicFiles(root);
  process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, files: files.length, scope: 'metadata-and-source-inventory', published: false })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'PREFLIGHT_FAILED', message: error.message })}\n`);
  process.exitCode = 1;
}
