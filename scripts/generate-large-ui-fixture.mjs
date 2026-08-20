import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const output = process.argv[2];
const count = Number(process.argv[3] ?? 100_000);
if (output === undefined || !Number.isSafeInteger(count) || count < 1) {
  throw new Error('usage: node scripts/generate-large-ui-fixture.mjs <output> [count]');
}
await mkdir(dirname(output), { recursive: true });
const chunks = ['return {'];
for (let index = 1; index <= count; index += 1) {
  chunks.push(`_${index} = { _uid = ${index}, _name = "Node${index}" },`);
}
chunks.push('}\n');
await writeFile(output, chunks.join('\n'), 'utf8');
