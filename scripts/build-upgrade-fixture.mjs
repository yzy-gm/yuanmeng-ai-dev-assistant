import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const yazl = require('yazl');

const [sourceValue, targetValue, ...options] = process.argv.slice(2);
const versionIndex = options.indexOf('--version');
const version = versionIndex >= 0 ? options[versionIndex + 1] : '0.1.1';
if (sourceValue === undefined || targetValue === undefined || version === undefined) {
  process.stderr.write('usage: node scripts/build-upgrade-fixture.mjs <source.vsix> <target.vsix> [--version 0.1.1]\n');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`Invalid upgrade fixture version: ${version}`);
}

const source = resolve(sourceValue);
const target = resolve(targetValue);
if (source === target) throw new Error('Upgrade fixture target must differ from source VSIX.');

function readEntries(path) {
  return new Promise((resolveEntries, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError || zip === undefined) {
        reject(openError ?? new Error('Unable to open source VSIX.'));
        return;
      }
      const entries = [];
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || stream === undefined) {
            reject(streamError ?? new Error(`Unable to read ${entry.fileName}.`));
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.push({ name: entry.fileName, content: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolveEntries(entries));
      zip.readEntry();
    });
  });
}

function replaceVersion(entry) {
  if (entry.name === 'extension/package.json') {
    const manifest = JSON.parse(entry.content.toString('utf8'));
    manifest.version = version;
    return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (entry.name === 'extension.vsixmanifest') {
    const text = entry.content.toString('utf8');
    const replaced = text.replace(/(<Identity\b[^>]*\bVersion=")[^"]+("[^>]*>)/u, `$1${version}$2`);
    if (replaced === text) throw new Error('Source VSIX Identity version was not found.');
    return Buffer.from(replaced, 'utf8');
  }
  return entry.content;
}

async function writeVsix(path, entries) {
  await rm(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  const zip = new yazl.ZipFile();
  const completion = new Promise((resolveWrite, reject) => {
    const output = createWriteStream(path, { flags: 'wx' });
    output.on('close', resolveWrite);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
  for (const entry of entries) zip.addBuffer(replaceVersion(entry), entry.name);
  zip.end();
  await completion;
}

await readFile(source);
const entries = await readEntries(source);
await writeVsix(target, entries);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, source, target, version, entryCount: entries.length })}\n`);
