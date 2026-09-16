import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { queryScene } from '../../src/core/scene/index.js';
import {
  diffSceneSnapshotsInWorker,
  processSceneSourceInWorker,
} from '../../src/core/scene/worker-client.js';

const workerPath = join(resolve(import.meta.dirname, '..', '..'), 'out', 'scene-worker.cjs');

function varint(value: number): Uint8Array {
  const output: number[] = [];
  let rest = BigInt(value);
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    output.push(byte);
  } while (rest !== 0n);
  return Uint8Array.from(output);
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

describe('scene worker scale matrix', () => {
  it('measures parse, index, exact query, diff and process RSS for 1k/10k/50k scenes', async () => {
    const measurements: Array<Record<string, number | string>> = [];
    const initialMemory = process.memoryUsage();
    let peakRss = initialMemory.rss;
    let peakMainHeap = initialMemory.heapUsed;
    let peakWorkerHeap = 0;
    for (const count of [1_000, 10_000, 50_000]) {
      const bytes = syntheticScene(count);
      const processStarted = performance.now();
      const processed = await processSceneSourceInWorker({
        bytes,
        bindingId: 'a'.repeat(64),
        role: 'raw-pbin',
        sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        observedAt: '2026-08-21T00:00:00.000Z',
      }, { workerPath });
      const processMilliseconds = performance.now() - processStarted;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakMainHeap = Math.max(peakMainHeap, process.memoryUsage().heapUsed);
      peakWorkerHeap = Math.max(peakWorkerHeap, processed.metrics.peakHeapUsedBytes);

      const queryStarted = performance.now();
      const query = queryScene(processed.index, { instanceId: String(count) });
      const queryMilliseconds = performance.now() - queryStarted;
      expect(query.kind).toBe('found');

      const after = structuredClone(processed.snapshot);
      after.snapshotId = 'c'.repeat(64);
      after.instances.find((instance) => instance.instanceId === String(count))!.ownerId = '1';
      const diffStarted = performance.now();
      const diff = await diffSceneSnapshotsInWorker(processed.snapshot, after, {}, { workerPath });
      const diffMilliseconds = performance.now() - diffStarted;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakMainHeap = Math.max(peakMainHeap, process.memoryUsage().heapUsed);
      expect(diff.changes).toEqual([expect.objectContaining({ kind: 'relation', instanceId: String(count) })]);
      measurements.push({ count, processMilliseconds, queryMilliseconds, diffMilliseconds });
    }
    const rssDeltaBytes = Math.max(0, peakRss - initialMemory.rss);
    const mainHeapDeltaBytes = Math.max(0, peakMainHeap - initialMemory.heapUsed);
    const thresholdsMet = measurements.every((value) => Number(value.processMilliseconds) < 20_000)
      && measurements.every((value) => Number(value.diffMilliseconds) < 20_000)
      && mainHeapDeltaBytes < 512 * 1024 * 1024
      && peakWorkerHeap < 512 * 1024 * 1024;
    const status = thresholdsMet ? 'PERFORMANCE_GATE_PASS' : 'PERFORMANCE_GATE_UNVERIFIED';
    console.info(JSON.stringify({ status, rssDeltaBytes, mainHeapDeltaBytes, peakWorkerHeap, measurements }));
    expect(measurements.map((value) => value.count)).toEqual([1_000, 10_000, 50_000]);
    expect(Number.isFinite(rssDeltaBytes)).toBe(true);
  }, 60_000);
});
