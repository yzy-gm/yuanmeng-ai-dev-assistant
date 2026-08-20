import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { adaptOfficialUiTables } from '../src/core/ui/adapter.js';
import { findUi } from '../src/core/ui/index.js';
import { parseLuaLiteralDocument } from '../src/core/lua/literal-parser.js';

const path = process.argv[2];
if (path === undefined) throw new Error('missing fixture path');
async function main(): Promise<void> {
  let input: string | null = await readFile(path!, 'utf8');
  const started = performance.now();
  let document: ReturnType<typeof parseLuaLiteralDocument> | null = parseLuaLiteralDocument(input, {
    maxNodes: 1_000_000,
    maxSourceBytes: 64 * 1024 * 1024,
    collectMetadata: false,
  });
  const nodes = adaptOfficialUiTables([{ document, sourceFile: 'src/Data/CustomUIData2.lua' }]);
  const parseIndexMilliseconds = performance.now() - started;
  document = null;
  input = null;
  if (typeof global.gc === 'function') global.gc();
  const queries: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const queryStarted = performance.now();
    const result = findUi({
      schemaVersion: 1, snapshotId: 'a'.repeat(64), createdAt: '2026-08-20T00:00:00.000Z',
      projectInstanceId: '00000000-0000-4000-8000-000000000905', mapFingerprint: null, sources: [], nodes, duplicateNames: [],
    }, `Node${(index * 997) % nodes.length + 1}`, { mode: 'exact-name' });
    if (result.kind !== 'unique') throw new Error('large fixture exact search was not unique');
    queries.push(performance.now() - queryStarted);
  }
  queries.sort((left, right) => left - right);
  if (typeof global.gc === 'function') global.gc();
  console.log(JSON.stringify({
    nodeCount: nodes.length,
    parseIndexMilliseconds,
    rssBytes: process.memoryUsage().rss,
    exactSearchP95Milliseconds: queries[Math.floor(queries.length * 0.95)] ?? 0,
  }));
}
void main();
