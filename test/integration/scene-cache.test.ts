import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applySceneCachePrune, previewSceneCachePrune } from '../../src/core/scene/cache.js';
import { sharedSceneRefreshScheduler } from '../../src/core/scene/workflow.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ymai-scene-cache-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function seed(root: string, relativePath: string, content = 'anonymous'): Promise<string> {
  const path = join(root, ...relativePath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  await utimes(path, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'));
  return path;
}

describe('private scene cache pruning', () => {
  it('previews only cache candidates and always protects every role/preferred head', async () => {
    const root = await temporaryDirectory();
    const manual = 'a'.repeat(64);
    const raw = 'b'.repeat(64);
    const stale = 'c'.repeat(64);
    await seed(root, `.yuanmeng-inspector/scene/snapshots/${manual}.json`);
    await seed(root, `.yuanmeng-inspector/scene/snapshots/${raw}.json`);
    const stalePath = await seed(root, `.yuanmeng-inspector/scene/snapshots/${stale}.json`, 'old');
    await seed(root, '.yuanmeng-inspector/scene/evidence/evidence.json');
    await seed(root, '.yuanmeng-inspector/logs/imported/log.json');
    const misplacedSource = await seed(root, '.yuanmeng-inspector/logs/LayerData.pbin');
    await seed(root, '.yuanmeng-inspector/reports/report.json');
    await seed(root, '.yuanmeng-inspector/journal/entry.json');
    await seed(root, '.yuanmeng-inspector/scene/bindings/raw-pbin.json');
    await seed(root, '.yuanmeng-inspector/registry/registry.json');
    await seed(root, '.yuanmeng-inspector/settings.json');
    const source = await seed(root, 'ugc/LayerData.pbin');
    await mkdir(join(root, '.yuanmeng-inspector', 'scene'), { recursive: true });
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), JSON.stringify({
      schemaVersion: 1,
      manualSnapshotId: manual,
      autoSnapshotId: null,
      rawSnapshotId: raw,
      preferredSnapshotId: manual,
    }), 'utf8');

    const preview = await previewSceneCachePrune(root, {
      maxCount: 2,
      maxAgeMilliseconds: 7 * 24 * 60 * 60 * 1000,
      now: new Date('2026-08-21T00:00:00.000Z'),
    });
    expect(preview.candidates.map((candidate) => candidate.relativePath)).toEqual([
      '.yuanmeng-inspector/journal/entry.json',
      '.yuanmeng-inspector/logs/imported/log.json',
      '.yuanmeng-inspector/reports/report.json',
      '.yuanmeng-inspector/scene/evidence/evidence.json',
      `.yuanmeng-inspector/scene/snapshots/${stale}.json`,
    ]);
    expect(preview.candidates.every((candidate) => candidate.bytes > 0 && candidate.reason.length > 0)).toBe(true);
    expect(preview.candidates.every((candidate) => candidate.contentSha256.match(/^[a-f0-9]{64}$/u))).toBe(true);
    await expect(stat(stalePath)).resolves.toBeDefined();
    await expect(stat(source)).resolves.toBeDefined();
    await expect(stat(misplacedSource)).resolves.toBeDefined();
    expect(preview.stateHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('requires an unchanged explicit confirmation hash before deleting candidates', async () => {
    const root = await temporaryDirectory();
    const stale = 'd'.repeat(64);
    const stalePath = await seed(root, `.yuanmeng-inspector/scene/snapshots/${stale}.json`);
    const options = { maxCount: 0, maxAgeMilliseconds: 1, now: new Date('2026-08-21T00:00:00.000Z') };
    const preview = await previewSceneCachePrune(root, options);
    await expect(applySceneCachePrune(root, options, '0'.repeat(64))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await seed(root, '.yuanmeng-inspector/logs/new.json');
    await expect(applySceneCachePrune(root, options, preview.stateHash)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readFile(stalePath, 'utf8')).toBe('anonymous');
    const current = await previewSceneCachePrune(root, options);
    const applied = await applySceneCachePrune(root, options, current.stateHash);
    expect(applied.deletedCount).toBe(2);
    await expect(stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a same-path same-size replacement whose timestamp was restored after preview', async () => {
    const root = await temporaryDirectory();
    const target = await seed(root, '.yuanmeng-inspector/reports/report.json', 'old-value');
    const options = { maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z') };
    const preview = await previewSceneCachePrune(root, options);
    await writeFile(target, 'new-value', 'utf8');
    await utimes(target, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z'));

    await expect(applySceneCachePrune(root, options, preview.stateHash)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(readFile(target, 'utf8')).resolves.toBe('new-value');
  });

  it('never treats an atomic journal or report writer temporary file as a prune candidate', async () => {
    const root = await temporaryDirectory();
    const temporary = await seed(root, '.yuanmeng-inspector/journal/.entry.json.1234.abcdef.tmp');
    const preview = await previewSceneCachePrune(root, {
      maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z'),
    });
    expect(preview.candidates).toEqual([]);
    await expect(stat(temporary)).resolves.toBeDefined();
  });

  it('prunes the real scene journal directory but permanently protects and synchronizes its index', async () => {
    const root = await temporaryDirectory();
    const journalId = '1'.repeat(64);
    const entryPath = await seed(root, `.yuanmeng-inspector/scene/journal/${journalId}.json`, 'old-entry');
    const indexPath = await seed(root, '.yuanmeng-inspector/scene/journal/index.json', JSON.stringify({
      schemaVersion: 1,
      entries: [{
        journalId,
        bindingId: 'binding-anonymous',
        role: 'raw-pbin',
        adapterId: 'observed-v1',
        fromSnapshotId: '2'.repeat(64),
        toSnapshotId: '3'.repeat(64),
        toObservedAt: '2026-08-01T00:00:00.000Z',
      }],
    }));
    const options = { maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z') };
    const preview = await previewSceneCachePrune(root, options);
    expect(preview.candidates.map((candidate) => candidate.relativePath)).toContain(`.yuanmeng-inspector/scene/journal/${journalId}.json`);
    expect(preview.candidates.map((candidate) => candidate.relativePath)).not.toContain('.yuanmeng-inspector/scene/journal/index.json');
    await applySceneCachePrune(root, options, preview.stateHash);
    await expect(stat(entryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toEqual({ schemaVersion: 1, entries: [] });
  });

  it('keeps the old journal index authoritative when a later file deletion fails mid-batch', async () => {
    const root = await temporaryDirectory();
    const ids = ['7'.repeat(64), '8'.repeat(64)];
    const paths = await Promise.all(ids.map((id) => seed(root, `.yuanmeng-inspector/scene/journal/${id}.json`, id)));
    const entries = ids.map((journalId, index) => ({
      journalId,
      bindingId: 'binding-anonymous',
      role: 'raw-pbin',
      adapterId: 'observed-v1',
      fromSnapshotId: String(index + 1).repeat(64),
      toSnapshotId: String(index + 2).repeat(64),
      toObservedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
    }));
    const indexPath = await seed(root, '.yuanmeng-inspector/scene/journal/index.json', JSON.stringify({ schemaVersion: 1, entries }));
    const options = { maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z') };
    const preview = await previewSceneCachePrune(root, options);
    let deletions = 0;
    await expect(applySceneCachePrune(root, options, preview.stateHash, {
      unlink: async (path) => {
        deletions += 1;
        if (deletions === 2) throw Object.assign(new Error('injected delete failure'), { code: 'EACCES' });
        await rm(path);
      },
    })).rejects.toMatchObject({ code: 'EACCES' });
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toEqual({ schemaVersion: 1, entries });
    await expect(stat(paths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(paths[1]!)).resolves.toBeDefined();
  });

  it('protects the UI current archive and committed gameplay runs while only permitting legacy gameplay reports', async () => {
    const root = await temporaryDirectory();
    const currentId = '4'.repeat(64);
    const staleId = '5'.repeat(64);
    const currentArchive = await seed(root, `.yuanmeng-inspector/ui/snapshots/${currentId}.json`, 'current');
    const staleArchive = await seed(root, `.yuanmeng-inspector/ui/snapshots/${staleId}.json`, 'stale');
    await seed(root, '.yuanmeng-inspector/ui/current.json', JSON.stringify({ schemaVersion: 1, snapshotId: currentId, nodes: [] }));
    const spec = await seed(root, '.yuanmeng-inspector/gameplay/spec.json', 'spec');
    const scenario = await seed(root, '.yuanmeng-inspector/gameplay/scenarios/multiplayer.json', 'scenario');
    const report = await seed(root, '.yuanmeng-inspector/gameplay/reports/old.json', 'report');
    const latest = await seed(root, '.yuanmeng-inspector/gameplay/latest.json', 'latest');
    const manifest = await seed(root, '.yuanmeng-inspector/gameplay/runs/run-1/manifest.json', 'manifest');
    const options = {
      maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z'),
    };
    const preview = await previewSceneCachePrune(root, options);
    const paths = preview.candidates.map((candidate) => candidate.relativePath);
    expect(paths).toContain(`.yuanmeng-inspector/ui/snapshots/${staleId}.json`);
    expect(paths).toContain('.yuanmeng-inspector/gameplay/reports/old.json');
    expect(paths).not.toContain(`.yuanmeng-inspector/ui/snapshots/${currentId}.json`);
    expect(paths).not.toContain('.yuanmeng-inspector/gameplay/spec.json');
    expect(paths).not.toContain('.yuanmeng-inspector/gameplay/scenarios/multiplayer.json');
    expect(paths).not.toContain('.yuanmeng-inspector/gameplay/latest.json');
    expect(paths).not.toContain('.yuanmeng-inspector/gameplay/runs/run-1/manifest.json');
    await applySceneCachePrune(root, options, preview.stateHash);
    await expect(stat(currentArchive)).resolves.toBeDefined();
    await expect(stat(staleArchive)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(spec)).resolves.toBeDefined();
    await expect(stat(scenario)).resolves.toBeDefined();
    await expect(stat(report)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(latest)).resolves.toBeDefined();
    await expect(stat(manifest)).resolves.toBeDefined();
  });

  it('refuses cache pruning when the UI current snapshot identity is corrupt', async () => {
    const root = await temporaryDirectory();
    await seed(root, `.yuanmeng-inspector/ui/snapshots/${'6'.repeat(64)}.json`, 'archive');
    await seed(root, '.yuanmeng-inspector/ui/current.json', '{');
    await expect(previewSceneCachePrune(root, {
      maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z'),
    })).rejects.toBeDefined();
  });

  it('refuses to plan deletion when heads are corrupt and protection cannot be proven', async () => {
    const root = await temporaryDirectory();
    const snapshotPath = await seed(root, `.yuanmeng-inspector/scene/snapshots/${'e'.repeat(64)}.json`);
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), '{', 'utf8');
    await expect(previewSceneCachePrune(root, {
      maxCount: 0,
      maxAgeMilliseconds: 0,
      now: new Date('2026-08-21T00:00:00.000Z'),
    })).rejects.toBeInstanceOf(SyntaxError);
    await expect(stat(snapshotPath)).resolves.toBeDefined();
  });

  it('serializes pruning with refresh and refuses a snapshot promoted to a head while waiting', async () => {
    const root = await temporaryDirectory();
    const promoted = 'f'.repeat(64);
    const snapshotPath = await seed(root, `.yuanmeng-inspector/scene/snapshots/${promoted}.json`);
    const headsPath = join(root, '.yuanmeng-inspector', 'scene', 'heads.json');
    await mkdir(join(root, '.yuanmeng-inspector', 'scene'), { recursive: true });
    await writeFile(headsPath, JSON.stringify({
      schemaVersion: 1,
      manualSnapshotId: null,
      autoSnapshotId: null,
      rawSnapshotId: null,
      preferredSnapshotId: null,
    }), 'utf8');
    const options = { maxCount: 0, maxAgeMilliseconds: 0, now: new Date('2026-08-21T00:00:00.000Z') };
    const preview = await previewSceneCachePrune(root, options);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const refresh = sharedSceneRefreshScheduler.start(root, 'manual-dat', async () => {
      await blocked;
      await writeFile(headsPath, JSON.stringify({
        schemaVersion: 1,
        manualSnapshotId: promoted,
        autoSnapshotId: null,
        rawSnapshotId: null,
        preferredSnapshotId: promoted,
      }), 'utf8');
    });
    const prune = applySceneCachePrune(root, options, preview.stateHash);
    const earlyOutcome = await Promise.race([
      prune.then(() => 'completed', () => 'rejected'),
      new Promise<'waiting'>((resolve) => { setTimeout(() => resolve('waiting'), 30); }),
    ]);
    expect(earlyOutcome).toBe('waiting');
    await expect(stat(snapshotPath)).resolves.toBeDefined();

    release();
    await refresh;
    await expect(prune).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(stat(snapshotPath)).resolves.toBeDefined();
  });
});
