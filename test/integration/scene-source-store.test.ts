import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import { sha256Hex } from '../../src/core/hash.js';
import { SCENE_ADAPTER_ID } from '../../src/core/scene/normalize.js';
import { saveSceneSnapshot, loadSceneHeads, loadSceneSnapshot, setPreferredSceneSnapshot } from '../../src/core/scene/store.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';
import { refreshSceneFromBinding, SceneRefreshGenerationQueue } from '../../src/core/scene/workflow.js';
import {
  createSceneSourceBinding,
  loadSceneSourceBindings,
  readStableSceneSource,
  restoreSceneSourceBindingIfCurrent,
  saveSceneSourceBinding,
} from '../../src/integrations/scene/source.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ymai-scene-source-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function snapshot(role: 'manual-dat' | 'auto-dat' | 'raw-pbin', id: string): SceneSnapshot {
  return {
    schemaVersion: 1, snapshotId: id.repeat(64), bindingId: 'binding', role, sourceSha256: id.repeat(64),
    observedAt: '2026-08-21T00:00:00.000Z', adapterId: SCENE_ADAPTER_ID, instances: [], groups: [], issues: [], unknownFields: [],
  };
}

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0n);
  return bytes;
}

function wireVarint(field: number, value: bigint): number[] {
  return [...varint(BigInt(field << 3)), ...varint(value)];
}

function wireBytes(field: number, value: number[]): number[] {
  return [...varint(BigInt((field << 3) | 2)), ...varint(BigInt(value.length)), ...value];
}

function anonymousSceneBytes(instanceId = 2n): Uint8Array {
  const instance = [
    ...wireVarint(1, 1n),
    ...wireVarint(2, instanceId),
    ...wireVarint(3, 3n),
    ...wireBytes(6, wireBytes(1, [8, 1])),
  ];
  return Uint8Array.from(wireBytes(5, wireBytes(24, [
    ...wireVarint(1, 1n),
    ...wireBytes(2, instance),
  ])));
}

describe('scene source binding and stable reads', () => {
  it('rejects a cache snapshot whose nested instance structure is incomplete', async () => {
    const root = await temporaryDirectory();
    const snapshotId = 'a'.repeat(64);
    const directory = join(root, '.yuanmeng-inspector', 'scene', 'snapshots');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${snapshotId}.json`), JSON.stringify({
      schemaVersion: 1, snapshotId, bindingId: 'binding', role: 'raw-pbin', sourceSha256: 'b'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: SCENE_ADAPTER_ID,
      instances: [{ instanceId: '901' }], groups: [], issues: [], unknownFields: [],
    }), 'utf8');
    await expect(loadSceneSnapshot(root, snapshotId, nodeFileIO)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('restores a cancelled binding only while its own generation is still authoritative on disk', async () => {
    const root = await temporaryDirectory();
    const createIn = async (name: string) => {
      const directory = join(root, name);
      await mkdir(directory);
      const sourcePath = join(directory, 'LayerData.pbin');
      await writeFile(sourcePath, Uint8Array.from([8, 1]));
      return createSceneSourceBinding({
        io: nodeFileIO,
        projectInstanceId: 'project-anonymous',
        projectRootHash: 'e'.repeat(64),
        role: 'raw-pbin',
        sourcePath,
      });
    };
    const baseline = await createIn('baseline');
    const staleA = await createIn('stale-a');
    const replacementB = await createIn('replacement-b');

    await saveSceneSourceBinding(root, baseline, nodeFileIO);
    await saveSceneSourceBinding(root, staleA, nodeFileIO);
    await saveSceneSourceBinding(root, replacementB, nodeFileIO);
    await expect(restoreSceneSourceBindingIfCurrent(root, staleA, baseline, nodeFileIO)).resolves.toBe(false);
    await expect(loadSceneSourceBindings(root, nodeFileIO)).resolves.toEqual([replacementB]);

    await saveSceneSourceBinding(root, staleA, nodeFileIO);
    await expect(restoreSceneSourceBindingIfCurrent(root, staleA, baseline, nodeFileIO)).resolves.toBe(true);
    await expect(loadSceneSourceBindings(root, nodeFileIO)).resolves.toEqual([baseline]);
  });

  it('restores the previous binding when authority expires only after its atomic rename returned', async () => {
    const root = await temporaryDirectory();
    const createIn = async (name: string) => {
      const directory = join(root, name);
      await mkdir(directory);
      const sourcePath = join(directory, 'LayerData.pbin');
      await writeFile(sourcePath, Uint8Array.from([8, 1]));
      return createSceneSourceBinding({
        io: nodeFileIO,
        projectInstanceId: 'project-anonymous',
        projectRootHash: 'f'.repeat(64),
        role: 'raw-pbin',
        sourcePath,
      });
    };
    const baseline = await createIn('baseline-post-rename');
    const stale = await createIn('stale-post-rename');
    await saveSceneSourceBinding(root, baseline, nodeFileIO);
    let guards = 0;
    await expect(saveSceneSourceBinding(root, stale, nodeFileIO, {
      commitGuard: () => {
        guards += 1;
        if (guards === 4) {
          const error = new Error('lost binding generation after rename');
          error.name = 'AbortError';
          throw error;
        }
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loadSceneSourceBindings(root, nodeFileIO)).resolves.toEqual([baseline]);
  });

  it('bounds node byte reads to maxBytes plus one while preserving unbounded compatibility', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'bytes.bin');
    await writeFile(source, Uint8Array.from([1, 2, 3, 4]));
    expect(Array.from(await nodeFileIO.readBytes(source, 2))).toEqual([1, 2, 3]);
    expect(Array.from(await nodeFileIO.readBytes(source))).toEqual([1, 2, 3, 4]);
  });

  it('accepts only the exact file name for each explicit source role', async () => {
    const root = await temporaryDirectory();
    const sourceDirectory = join(root, 'ugc');
    await mkdir(sourceDirectory);
    const raw = join(sourceDirectory, 'LayerData.pbin');
    const wrong = join(sourceDirectory, 'renamed.pbin');
    await writeFile(raw, Uint8Array.from([8, 1]));
    await writeFile(wrong, Uint8Array.from([8, 1]));
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: 'a'.repeat(64), role: 'raw-pbin', sourcePath: raw,
    });
    expect(binding.displayDirectory).toBe('ugc');
    expect(binding.sourcePath).toBe(await nodeFileIO.realpath(raw));
    await expect(createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: 'a'.repeat(64), role: 'raw-pbin', sourcePath: wrong,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('waits for stable size and mtime, then reads and hashes once', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'LayerData.pbin');
    await writeFile(source, Uint8Array.from([8, 1]));
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: 'b'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    const stable = await readStableSceneSource(binding, {
      io: nodeFileIO, sampleMilliseconds: 5, stableSampleCount: 2, totalTimeoutMilliseconds: 100,
    });
    expect(stable.bytes).toEqual(Uint8Array.from([8, 1]));
    expect(stable.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('passes the 256 MiB bound into the source byte read', async () => {
    let observedLimit: number | undefined;
    const io = {
      ...nodeFileIO,
      readBytes: async (path: string, maxBytes?: number) => {
        observedLimit = maxBytes;
        return nodeFileIO.readBytes(path, maxBytes);
      },
    };
    const root = await temporaryDirectory();
    const source = join(root, 'LayerData.pbin');
    await writeFile(source, Uint8Array.from([8, 1]));
    const binding = await createSceneSourceBinding({
      io, projectInstanceId: 'project-anonymous', projectRootHash: '2'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    await readStableSceneSource(binding, {
      io, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 100,
    });
    expect(observedLimit).toBe(256 * 1024 * 1024);
  });

  it('aborts a pending stability sample without reading the source', async () => {
    const controller = new AbortController();
    let reads = 0;
    const io = {
      ...nodeFileIO,
      realpath: async (path: string) => path,
      stat: async () => ({ isDirectory: () => false, isFile: () => true, mtimeMs: 1, size: 2 }),
      readBytes: async () => {
        reads += 1;
        return Uint8Array.from([8, 1]);
      },
    };
    const binding = {
      schemaVersion: 1 as const,
      bindingId: 'a'.repeat(64), projectInstanceId: 'project-anonymous', projectRootHash: 'b'.repeat(64),
      role: 'raw-pbin' as const, sourcePath: 'C:\\anonymous\\LayerData.pbin', displayDirectory: 'anonymous',
      directoryHash: 'c'.repeat(64), createdAt: '2026-08-21T00:00:00.000Z',
    };
    const startedAt = Date.now();
    const pending = readStableSceneSource(binding, {
      io, signal: controller.signal, sampleMilliseconds: 1_000, stableSampleCount: 3, totalTimeoutMilliseconds: 5_000,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(reads).toBe(0);
  });

  it('rejects a source above 256 MiB before reading its bytes', async () => {
    let reads = 0;
    const io = {
      ...nodeFileIO,
      realpath: async (path: string) => path,
      stat: async () => ({ isDirectory: () => false, isFile: () => true, mtimeMs: 1, size: 256 * 1024 * 1024 + 1 }),
      readBytes: async () => {
        reads += 1;
        return new Uint8Array();
      },
    };
    const binding = {
      schemaVersion: 1 as const,
      bindingId: 'a'.repeat(64), projectInstanceId: 'project-anonymous', projectRootHash: 'b'.repeat(64),
      role: 'raw-pbin' as const, sourcePath: 'C:\\anonymous\\LayerData.pbin', displayDirectory: 'anonymous',
      directoryHash: 'c'.repeat(64), createdAt: '2026-08-21T00:00:00.000Z',
    };
    await expect(readStableSceneSource(binding, {
      io, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 10,
    })).rejects.toMatchObject({ code: 'SCENE_LIMIT_EXCEEDED' });
    expect(reads).toBe(0);
  });

  it('rechecks the size immediately before readBytes when the file grows', async () => {
    let stats = 0;
    let reads = 0;
    const io = {
      ...nodeFileIO,
      realpath: async (path: string) => path,
      stat: async () => {
        stats += 1;
        const size = stats === 1 ? 2 : 256 * 1024 * 1024 + 1;
        return { isDirectory: () => false, isFile: () => true, mtimeMs: 1, size };
      },
      readBytes: async () => {
        reads += 1;
        return Uint8Array.from([8, 1]);
      },
    };
    const binding = {
      schemaVersion: 1 as const,
      bindingId: 'a'.repeat(64), projectInstanceId: 'project-anonymous', projectRootHash: 'b'.repeat(64),
      role: 'raw-pbin' as const, sourcePath: 'C:\\anonymous\\LayerData.pbin', displayDirectory: 'anonymous',
      directoryHash: 'c'.repeat(64), createdAt: '2026-08-21T00:00:00.000Z',
    };
    await expect(readStableSceneSource(binding, {
      io, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 10,
    })).rejects.toMatchObject({ code: 'SCENE_LIMIT_EXCEEDED' });
    expect(reads).toBe(0);
  });

  it('does not accept bytes whose length differs from the stable stat size', async () => {
    const io = {
      ...nodeFileIO,
      realpath: async (path: string) => path,
      stat: async () => ({ isDirectory: () => false, isFile: () => true, mtimeMs: 1, size: 2 }),
      readBytes: async () => Uint8Array.from([8, 1, 2]),
    };
    const binding = {
      schemaVersion: 1 as const,
      bindingId: 'a'.repeat(64), projectInstanceId: 'project-anonymous', projectRootHash: 'b'.repeat(64),
      role: 'raw-pbin' as const, sourcePath: 'C:\\anonymous\\LayerData.pbin', displayDirectory: 'anonymous',
      directoryHash: 'c'.repeat(64), createdAt: '2026-08-21T00:00:00.000Z',
    };
    await expect(readStableSceneSource(binding, {
      io, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 5,
    })).rejects.toMatchObject({ code: 'SCENE_SOURCE_UNSTABLE' });
  });
});

describe('scene refresh workflow', () => {
  it('reuses the matching role head without replacing its observed time', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'LayerData.pbin');
    await writeFile(source, anonymousSceneBytes());
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: 'd'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    const first = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1,
      totalTimeoutMilliseconds: 100, observedAt: '2026-08-21T00:00:00.000Z',
    });
    const second = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1,
      totalTimeoutMilliseconds: 100, observedAt: '2026-08-21T01:00:00.000Z',
    });
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.snapshot.observedAt).toBe('2026-08-21T00:00:00.000Z');
  });

  it('reuses a matching cached head before attempting to parse the source', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'LayerData.pbin');
    const bytes = Uint8Array.from([0xff]);
    await writeFile(source, bytes);
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: 'e'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    const cached = {
      ...snapshot('raw-pbin', 'e'),
      bindingId: binding.bindingId,
      sourceSha256: sha256Hex(bytes),
    };
    await saveSceneSnapshot(root, cached, nodeFileIO, { preferred: true });
    const refreshed = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 100,
    });
    expect(refreshed.snapshot).toEqual(cached);
  });

  it('falls back to parsing and repairs a corrupt matching head snapshot', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'LayerData.pbin');
    await writeFile(source, anonymousSceneBytes());
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: 'f'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    const first = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1,
      totalTimeoutMilliseconds: 100, observedAt: '2026-08-21T00:00:00.000Z',
    });
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${first.snapshot.snapshotId}.json`), '{');
    const repaired = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1,
      totalTimeoutMilliseconds: 100, observedAt: '2026-08-21T02:00:00.000Z',
    });
    expect(repaired.snapshot.observedAt).toBe('2026-08-21T02:00:00.000Z');
    await expect(loadSceneSnapshot(root, repaired.snapshot.snapshotId, nodeFileIO)).resolves.toEqual(repaired.snapshot);
  });

  it('switches only the preferred head when reusing a non-preferred role head', async () => {
    const root = await temporaryDirectory();
    const manual = snapshot('manual-dat', 'a');
    await saveSceneSnapshot(root, manual, nodeFileIO, { preferred: true });
    const source = join(root, 'LayerData.pbin');
    await writeFile(source, anonymousSceneBytes());
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: '1'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    const first = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: false, sampleMilliseconds: 1, stableSampleCount: 1,
      totalTimeoutMilliseconds: 100, observedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(first.heads.preferredSnapshotId).toBe(manual.snapshotId);
    const reused = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1,
      totalTimeoutMilliseconds: 100, observedAt: '2026-08-21T03:00:00.000Z',
    });
    expect(reused.snapshot.observedAt).toBe('2026-08-21T00:00:00.000Z');
    expect(reused.heads.preferredSnapshotId).toBe(first.snapshot.snapshotId);
    expect(reused.heads.manualSnapshotId).toBe(manual.snapshotId);
  });

  it('rolls back a cancelled generation that reached the heads write when its queued replacement fails', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'LayerData.pbin');
    await writeFile(source, anonymousSceneBytes(2n));
    const binding = await createSceneSourceBinding({
      io: nodeFileIO, projectInstanceId: 'project-anonymous', projectRootHash: '9'.repeat(64), role: 'raw-pbin', sourcePath: source,
    });
    const baseline = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 100,
    });
    await writeFile(source, anonymousSceneBytes(3n));

    const queue = new SceneRefreshGenerationQueue();
    let replacement: Promise<unknown> | null = null;
    let replacementQueued = false;
    const guardedIo = {
      ...nodeFileIO,
      rename: async (from: string, to: string) => {
        await nodeFileIO.rename(from, to);
        if (!replacementQueued && to.endsWith('heads.json')) {
          replacementQueued = true;
          replacement = queue.start(root, 'raw-pbin', async (generation) => refreshSceneFromBinding(root, binding, {
            io: nodeFileIO, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 100,
            signal: generation.signal,
            processSource: async () => { throw new Error('replacement failed'); },
          }));
        }
      },
    };
    const stale = queue.start(root, 'raw-pbin', async (generation) => refreshSceneFromBinding(root, binding, {
      io: guardedIo, preferred: true, sampleMilliseconds: 1, stableSampleCount: 1, totalTimeoutMilliseconds: 100,
      signal: generation.signal,
    }));

    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    await expect(replacement).rejects.toThrow('replacement failed');
    await expect(loadSceneHeads(root, nodeFileIO)).resolves.toEqual(baseline.heads);
  });
});

describe('scene snapshot heads', () => {
  it('keeps manual, auto and raw heads separate and never lets auto silently overwrite preferred manual', async () => {
    const root = await temporaryDirectory();
    const manual = snapshot('manual-dat', 'a');
    const auto = snapshot('auto-dat', 'b');
    await saveSceneSnapshot(root, manual, nodeFileIO, { preferred: true });
    await saveSceneSnapshot(root, auto, nodeFileIO, { preferred: false });
    const heads = await loadSceneHeads(root, nodeFileIO);
    expect(heads).toEqual({
      schemaVersion: 1, manualSnapshotId: manual.snapshotId, autoSnapshotId: auto.snapshotId,
      rawSnapshotId: null, preferredSnapshotId: manual.snapshotId,
    });
    expect((await loadSceneSnapshot(root, manual.snapshotId, nodeFileIO)).role).toBe('manual-dat');
  });

  it('restores heads when setPreferred loses authority only after atomic rename returned', async () => {
    const root = await temporaryDirectory();
    const manual = snapshot('manual-dat', 'a');
    const raw = snapshot('raw-pbin', 'b');
    const baseline = await saveSceneSnapshot(root, manual, nodeFileIO, { preferred: true });
    const heads = await saveSceneSnapshot(root, raw, nodeFileIO, { preferred: false });
    let guards = 0;
    await expect(setPreferredSceneSnapshot(root, raw.snapshotId, nodeFileIO, {
      heads,
      commitGuard: () => {
        guards += 1;
        if (guards === 4) {
          const error = new Error('lost generation after rename');
          error.name = 'AbortError';
          throw error;
        }
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loadSceneHeads(root, nodeFileIO)).resolves.toEqual({ ...heads, preferredSnapshotId: baseline.preferredSnapshotId });
  });

  it('restores heads when saveSceneSnapshot loses authority only after the heads write returned', async () => {
    const root = await temporaryDirectory();
    const manual = snapshot('manual-dat', 'c');
    const baseline = await saveSceneSnapshot(root, manual, nodeFileIO, { preferred: true });
    const raw = snapshot('raw-pbin', 'd');
    let headsRenamed = false;
    let headsPostGuards = 0;
    const io = {
      ...nodeFileIO,
      rename: async (from: string, to: string) => {
        await nodeFileIO.rename(from, to);
        if (to.endsWith('heads.json')) headsRenamed = true;
      },
    };
    await expect(saveSceneSnapshot(root, raw, io, {
      preferred: true,
      heads: baseline,
      commitGuard: () => {
        if (!headsRenamed) return;
        headsPostGuards += 1;
        if (headsPostGuards === 2) {
          const error = new Error('lost generation after heads write');
          error.name = 'AbortError';
          throw error;
        }
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loadSceneHeads(root, nodeFileIO)).resolves.toEqual(baseline);
  });
});
