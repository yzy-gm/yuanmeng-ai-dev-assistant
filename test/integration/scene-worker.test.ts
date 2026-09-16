import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import { loadSceneHeads } from '../../src/core/scene/store.js';
import {
  diffSceneSnapshotsInWorker,
  processSceneSourceInWorker,
} from '../../src/core/scene/worker-client.js';
import { refreshSceneFromBinding } from '../../src/core/scene/workflow.js';
import { createSceneSourceBinding } from '../../src/integrations/scene/source.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const workerPath = join(repoRoot, 'out', 'scene-worker.cjs');
const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function varint(value: number): Uint8Array {
  const result: number[] = [];
  let rest = BigInt(value);
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    result.push(byte);
  } while (rest !== 0n);
  return Uint8Array.from(result);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function wireVarint(field: number, value: number): Uint8Array {
  return concat([varint(field << 3), varint(value)]);
}

function wireBytes(field: number, value: Uint8Array): Uint8Array {
  return concat([varint((field << 3) | 2), varint(value.length), value]);
}

function syntheticScene(instanceCount: number): Uint8Array {
  const instances: Uint8Array[] = [wireVarint(1, 0)];
  for (let index = 1; index <= instanceCount; index += 1) {
    instances.push(wireBytes(2, concat([
      wireVarint(2, index),
      wireVarint(3, 7000 + (index % 10)),
    ])));
  }
  return wireBytes(5, wireBytes(24, concat(instances)));
}

function workerInput(bytes: Uint8Array) {
  return {
    bytes,
    bindingId: 'a'.repeat(64),
    role: 'raw-pbin' as const,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    observedAt: '2026-08-21T00:00:00.000Z',
  };
}

describe('scene worker execution', () => {
  it('keeps the Extension Host event loop ticking while parsing and indexing 50k instances', async () => {
    const input = workerInput(syntheticScene(50_000));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      const result = await processSceneSourceInWorker(input, { workerPath });
      expect(result.snapshot.instances).toHaveLength(50_000);
      expect(result.index.byInstanceId.size).toBe(50_000);
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  }, 30_000);

  it('terminates in-flight CPU work on abort and never commits heads or registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-scene-worker-cancel-'));
    directories.push(root);
    const sourcePath = join(root, 'LayerData.pbin');
    await writeFile(sourcePath, syntheticScene(50_000));
    const binding = await createSceneSourceBinding({
      io: nodeFileIO,
      projectInstanceId: 'project-anonymous',
      projectRootHash: 'b'.repeat(64),
      role: 'raw-pbin',
      sourcePath,
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = refreshSceneFromBinding(root, binding, {
      io: nodeFileIO,
      preferred: true,
      sampleMilliseconds: 1,
      stableSampleCount: 1,
      totalTimeoutMilliseconds: 5_000,
      signal: controller.signal,
      processSource: (input, callbacks) => processSceneSourceInWorker(input, { workerPath, ...callbacks }),
      onProgress: (phase) => { if (phase === 'wire') controller.abort(); },
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(loadSceneHeads(root, nodeFileIO)).resolves.toEqual({
      schemaVersion: 1,
      manualSnapshotId: null,
      autoSnapshotId: null,
      rawSnapshotId: null,
      preferredSnapshotId: null,
    });
    await expect(stat(join(root, '.yuanmeng-inspector', 'registry', 'registry.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('preserves the last valid head when a replacement generation is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-scene-worker-preserve-'));
    directories.push(root);
    const sourcePath = join(root, 'LayerData.pbin');
    await writeFile(sourcePath, syntheticScene(10));
    const binding = await createSceneSourceBinding({
      io: nodeFileIO,
      projectInstanceId: 'project-anonymous',
      projectRootHash: 'b'.repeat(64),
      role: 'raw-pbin',
      sourcePath,
    });
    const first = await refreshSceneFromBinding(root, binding, {
      io: nodeFileIO,
      preferred: true,
      sampleMilliseconds: 1,
      stableSampleCount: 1,
      totalTimeoutMilliseconds: 5_000,
      processSource: (input, callbacks) => processSceneSourceInWorker(input, { workerPath, ...callbacks }),
    });
    await writeFile(sourcePath, syntheticScene(50_000));
    const controller = new AbortController();
    const replacement = refreshSceneFromBinding(root, binding, {
      io: nodeFileIO,
      preferred: true,
      sampleMilliseconds: 1,
      stableSampleCount: 1,
      totalTimeoutMilliseconds: 5_000,
      signal: controller.signal,
      processSource: (input, callbacks) => processSceneSourceInWorker(input, { workerPath, ...callbacks }),
      onProgress: (phase) => { if (phase === 'wire') controller.abort(); },
    });
    await expect(replacement).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loadSceneHeads(root, nodeFileIO)).resolves.toEqual(first.heads);
  }, 10_000);

  it('rejects non-closed worker messages without reflecting private payloads', async () => {
    const worker = new Worker(workerPath);
    try {
      const response = await new Promise<unknown>((resolveResponse, reject) => {
        worker.once('message', resolveResponse);
        worker.once('error', reject);
        worker.postMessage({ kind: 'process', requestId: 'request', bytes: new Uint8Array([8, 1]), privatePath: 'D:\\private-map\\LayerData.pbin' });
      });
      expect(response).toMatchObject({ kind: 'error', code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(response)).not.toContain('private-map');
      expect(JSON.stringify(response)).not.toContain('LayerData');
    } finally {
      await worker.terminate();
    }
  });

  it('rejects immediately when a worker exits cleanly before sending a terminal response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-scene-worker-silent-'));
    directories.push(root);
    const silentWorkerPath = join(root, 'silent-worker.cjs');
    await writeFile(silentWorkerPath, 'process.exit(0);\n', 'utf8');
    const startedAt = Date.now();
    await expect(processSceneSourceInWorker(workerInput(syntheticScene(1)), {
      workerPath: silentWorkerPath,
      timeoutMilliseconds: 2_000,
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: expect.stringContaining('未完成') });
    expect(Date.now() - startedAt).toBeLessThan(500);
  }, 5_000);

  it('runs large diffs in a worker and returns only derived changes', async () => {
    const parsed = await processSceneSourceInWorker(workerInput(syntheticScene(1_000)), { workerPath });
    const after = structuredClone(parsed.snapshot);
    after.snapshotId = 'c'.repeat(64);
    after.instances.find((instance) => instance.instanceId === '1000')!.ownerId = '1';
    const diff = await diffSceneSnapshotsInWorker(parsed.snapshot, after, {}, { workerPath });
    expect(diff.changes).toEqual([expect.objectContaining({ kind: 'relation', instanceId: '1000' })]);
  });
});
