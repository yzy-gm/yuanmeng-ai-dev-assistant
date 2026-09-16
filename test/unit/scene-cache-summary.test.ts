import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { summarizeSceneCache } from '../../src/core/scene/cache.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-cache-summary-'));
  roots.push(root);
  return root;
}

async function seed(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, ...relativePath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  await utimes(path, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('read-only scene cache summary', () => {
  it('summarizes prunable areas without reading file contents and protects gameplay runs/raw scene data', async () => {
    const root = await temporaryRoot();
    await seed(root, '.yuanmeng-inspector/scene/snapshots/a.json', 'snapshot-content');
    await seed(root, '.yuanmeng-inspector/reports/report.json', 'report-content');
    await seed(root, '.yuanmeng-inspector/gameplay/runs/run-1/manifest.json', 'run-content');
    await seed(root, '.yuanmeng-inspector/scene/LayerData.pbin', 'raw-map-data');
    await seed(root, '.yuanmeng-inspector/registry/registry.json', 'registry-content');

    const before = await readFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', 'a.json'), 'utf8');
    const summary = await summarizeSceneCache(root, { warningThresholdBytes: 1, largestLimit: 2 });
    const after = await readFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', 'a.json'), 'utf8');

    expect(summary).toMatchObject({
      schemaVersion: 1,
      fileCount: 2,
      totalBytes: Buffer.byteLength('snapshot-content') + Buffer.byteLength('report-content'),
      protected: { gameplayRuns: { fileCount: 1, bytes: Buffer.byteLength('run-content') } },
      warning: 'over-budget',
    });
    expect(summary.areas).toEqual([
      { area: 'derived', fileCount: 0, bytes: 0 },
      { area: 'gameplay/reports', fileCount: 0, bytes: 0 },
      { area: 'journal', fileCount: 0, bytes: 0 },
      { area: 'journals', fileCount: 0, bytes: 0 },
      { area: 'logs', fileCount: 0, bytes: 0 },
      { area: 'reports', fileCount: 1, bytes: Buffer.byteLength('report-content') },
      { area: 'scene/derived', fileCount: 0, bytes: 0 },
      { area: 'scene/diffs', fileCount: 0, bytes: 0 },
      { area: 'scene/evidence', fileCount: 0, bytes: 0 },
      { area: 'scene/journal', fileCount: 0, bytes: 0 },
      { area: 'scene/snapshots', fileCount: 1, bytes: Buffer.byteLength('snapshot-content') },
      { area: 'ui/snapshots', fileCount: 0, bytes: 0 },
    ]);
    expect(summary.largestFiles).toHaveLength(2);
    expect(summary.largestFiles.map((entry) => entry.relativePath)).toContain('.yuanmeng-inspector/reports/report.json');
    expect(summary.largestFiles.map((entry) => entry.relativePath)).not.toContain('.yuanmeng-inspector/gameplay/runs/run-1/manifest.json');
    expect(before).toBe(after);
    expect(await readFile(join(root, '.yuanmeng-inspector', 'scene', 'LayerData.pbin'), 'utf8')).toBe('raw-map-data');
  });

  it('returns an empty stable summary when the private cache directory does not exist', async () => {
    const root = await temporaryRoot();
    await expect(summarizeSceneCache(root)).resolves.toMatchObject({
      schemaVersion: 1,
      fileCount: 0,
      totalBytes: 0,
      warning: null,
      largestFiles: [],
      protected: { gameplayRuns: { fileCount: 0, bytes: 0 } },
    });
  });
});
