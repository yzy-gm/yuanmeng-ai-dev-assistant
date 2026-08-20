import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildUiSnapshot, findUi } from '../../src/core/ui/index.js';
import { FixedClock } from '../../src/core/clock.js';
import { nodeFileIO } from '../../src/core/fs.js';
import { reduceStatus } from '../../src/core/status/status.js';
import { waitForStableExport } from '../../src/integrations/official/files.js';
import { parseLuaLiteralDocument } from '../../src/core/lua/literal-parser.js';
import { RequestQueueHost, createQueueSession, createRefreshUiRequest } from '../../src/integrations/queue/protocol.js';

describe('multi-project data isolation', () => {
  it('keeps simultaneous refresh queues isolated across success, corruption, half-write, and fingerprint rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-multi-'));
    const projects = [join(root, '甲'), join(root, '乙'), join(root, '丙')];
    try {
      await Promise.all(projects.map((project) => mkdir(join(project, '.yuanmeng-inspector', 'ui'), { recursive: true })));
      const snapshots = projects.map((project, index) => buildUiSnapshot({
        createdAt: `2026-08-20T00:00:0${index}.000Z`,
        projectInstanceId: `00000000-0000-4000-8000-00000000090${index + 6}`,
        mapFingerprint: null,
        sources: [],
        nodes: [{ id: String(index + 1), name: `Only-${index}`, type: 'unknown', parentId: null, path: `/Only-${index}`, depth: 0, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null }],
      }));
      await Promise.all(projects.map((project, index) => writeFile(join(project, '.yuanmeng-inspector', 'ui', 'current.json'), JSON.stringify(snapshots[index]), 'utf8')));
      expect(findUi(JSON.parse(await readFile(join(projects[0]!, '.yuanmeng-inspector', 'ui', 'current.json'), 'utf8')) as typeof snapshots[number], 'Only-1', { mode: 'exact-name' }).kind).toBe('not-found');
      expect(findUi(JSON.parse(await readFile(join(projects[1]!, '.yuanmeng-inspector', 'ui', 'current.json'), 'utf8')) as typeof snapshots[number], 'Only-1', { mode: 'exact-name' }).kind).toBe('unique');

      const clock = new FixedClock('2026-08-20T01:00:00.000Z');
      const sessions = projects.map((_, index) => createQueueSession(`00000000-0000-4000-8000-0000000009${index + 1}1`, clock));
      const oldC = 'return { _1 = { _uid = 3, _name = "OldC" } }\n';
      const cPath = join(projects[2]!, 'src', 'Data-C.lua');
      await mkdir(join(projects[2]!, 'src'), { recursive: true });
      await writeFile(cPath, oldC, 'utf8');
      const aHost = new RequestQueueHost({ clock, io: nodeFileIO, runtimeRoot: join(projects[0]!, '.runtime'), session: sessions[0]!, refreshUi: async () => { await writeFile(join(projects[0]!, 'refresh.txt'), 'A-new', 'utf8'); } });
      const bHost = new RequestQueueHost({ clock, io: nodeFileIO, runtimeRoot: join(projects[1]!, '.runtime-b'), session: sessions[1]!, refreshUi: async () => { throw new Error('corrupt CustomUIData'); } });
      const cHost = new RequestQueueHost({ clock, io: nodeFileIO, runtimeRoot: join(projects[2]!, '.runtime-c'), session: sessions[2]!, refreshUi: async () => {
        const baseline = { [cPath]: 'old-hash' };
        await writeFile(cPath, 'return { _1 =', 'utf8');
        try {
          await waitForStableExport({ io: nodeFileIO, paths: [cPath], baselineHashes: baseline, sampleMilliseconds: 5, stableSampleCount: 2, splitCollectionMilliseconds: 10, totalTimeoutMilliseconds: 30, validateContent: (content) => { parseLuaLiteralDocument(content); } });
        } catch {
          // The observer rejected the half-written file; the queue must still report failure.
        }
        throw new Error('half-written C export');
      } });
      const requests = sessions.map((session) => createRefreshUiRequest(session, clock));
      const paths = [join(projects[0]!, 'a.json'), join(projects[1]!, 'b.json'), join(projects[1]!, 'c.json')];
      const results = await Promise.all([
        aHost.processFile(await (async () => { await writeFile(paths[0]!, JSON.stringify(requests[0]), 'utf8'); return paths[0]!; })()),
        bHost.processFile(await (async () => { await writeFile(paths[1]!, JSON.stringify(requests[1]), 'utf8'); return paths[1]!; })()),
        cHost.processFile(await (async () => { await writeFile(paths[2]!, JSON.stringify(requests[2]), 'utf8'); return paths[2]!; })()),
      ]);
      expect(results.map((result) => result.status)).toEqual(['completed', 'failed', 'failed']);
      expect(await readFile(join(projects[0]!, 'refresh.txt'), 'utf8')).toBe('A-new');
      expect(await readFile(cPath, 'utf8')).toBe('return { _1 =');
      const rotated = reduceStatus({ commandsPresent: true, refreshAttempt: { outcome: 'success', completedAt: '2026-08-20T01:00:00.000Z', reasonCode: 'REFRESH_SUCCEEDED', observedStableNewFiles: true, parseSucceeded: true, mapFingerprint: 'd'.repeat(64) }, snapshot: { lastRefreshAt: '2026-08-20T00:00:00.000Z', sourceHashes: {}, mapFingerprint: 'c'.repeat(64), officialExtensionVersion: null, verifiedFresh: true }, currentMapFingerprint: 'd'.repeat(64), project: snapshots[0] ? { schemaVersion: 1, projectInstanceId: snapshots[0].projectInstanceId, projectRootHash: 'a'.repeat(64), hasSrc: true, hasGameEntry: true, mapFingerprint: 'd'.repeat(64), mapName: null, currentLayerId: null, layers: [] } : undefined });
      expect(rotated.ui.freshness).toBe('stale');
      expect(rotated.ui.reasonCodes).toContain('MAP_FINGERPRINT_CHANGED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
