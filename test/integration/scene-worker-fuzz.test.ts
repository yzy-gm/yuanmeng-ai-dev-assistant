import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { processSceneSourceInWorker } from '../../src/core/scene/worker-client.js';
import type { SceneSourceRole } from '../../src/core/scene/container.js';

const workerPath = join(resolve(import.meta.dirname, '..', '..'), 'out', 'scene-worker.cjs');

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff]; }
function u32(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]; }

function sceneZip(payload: Uint8Array, trailing: number[] = []): Uint8Array {
  const name = new TextEncoder().encode('LayerData.pbin');
  const compressed = deflateRawSync(payload);
  const crc = crc32(payload);
  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(8), ...u16(8), ...u16(0), ...u16(0),
    ...u32(0), ...u32(0), ...u32(0), ...u16(name.length), ...u16(0), ...name,
  ];
  const descriptor = [...u32(0x08074b50), ...u32(crc), ...u32(compressed.length), ...u32(payload.length)];
  const centralOffset = local.length + compressed.length + descriptor.length;
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(8), ...u16(8), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(compressed.length), ...u32(payload.length), ...u16(name.length), ...u16(0), ...u16(0),
    ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name,
  ];
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(centralOffset), ...u16(0),
  ];
  return Uint8Array.from([...local, ...compressed, ...descriptor, ...central, ...eocd, ...trailing]);
}

function input(bytes: Uint8Array, role: SceneSourceRole) {
  return {
    bytes,
    bindingId: 'a'.repeat(64),
    role,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    observedAt: '2026-08-21T00:00:00.000Z',
  };
}

describe('scene worker malformed-input pressure', () => {
  it.each([
    ['illegal tag', Uint8Array.from([0]), 'raw-pbin' as const, 'SCENE_WIRE_INVALID'],
    ['truncated length field', Uint8Array.from([0x0a, 5, 1]), 'raw-pbin' as const, 'SCENE_WIRE_INVALID'],
    ['overlong varint', Uint8Array.from([0x08, ...new Array<number>(10).fill(0x80), 0]), 'raw-pbin' as const, 'SCENE_WIRE_INVALID'],
    ['zip bomb ratio', sceneZip(new Uint8Array(1024 * 1024)), 'manual-dat' as const, 'SCENE_LIMIT_EXCEEDED'],
    ['dirty trailing zip bytes', sceneZip(Uint8Array.from([8, 1]), [1]), 'manual-dat' as const, 'SCENE_INTEGRITY_FAILED'],
  ])('rejects %s with a bounded product error', async (_name, bytes, role, code) => {
    await expect(processSceneSourceInWorker(input(bytes, role), { workerPath }))
      .rejects.toMatchObject({ code });
  });
});
