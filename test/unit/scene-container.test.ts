import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { readSceneContainer } from '../../src/core/scene/container.js';

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

function zip(payload: Uint8Array, overrides: { name?: string; crc?: number; extraEntry?: boolean; flags?: number; method?: number; trailing?: number[] } = {}): Uint8Array {
  const name = new TextEncoder().encode(overrides.name ?? 'LayerData.pbin');
  const compressed = deflateRawSync(payload);
  const crc = overrides.crc ?? crc32(payload);
  const flags = overrides.flags ?? 0x0008;
  const method = overrides.method ?? 8;
  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0),
    ...u32(0), ...u32(0), ...u32(0), ...u16(name.length), ...u16(0), ...name,
  ];
  const descriptor = [...u32(0x08074b50), ...u32(crc), ...u32(compressed.length), ...u32(payload.length)];
  const centralOffset = local.length + compressed.length + descriptor.length;
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(compressed.length), ...u32(payload.length), ...u16(name.length), ...u16(0), ...u16(0),
    ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name,
  ];
  const entries = overrides.extraEntry === true ? 2 : 1;
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries), ...u16(entries),
    ...u32(central.length), ...u32(centralOffset), ...u16(0),
  ];
  return Uint8Array.from([...local, ...compressed, ...descriptor, ...central, ...eocd, ...(overrides.trailing ?? [])]);
}

describe('validated scene container reader', () => {
  it('reads a raw pbin only under an explicit raw role', () => {
    const payload = Uint8Array.from([0x08, 0x01]);
    const result = readSceneContainer(payload, 'raw-pbin');
    expect(result.format).toBe('raw-protobuf');
    expect(result.payload).toEqual(payload);
    expect(() => readSceneContainer(payload, 'manual-dat')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_SCENE_CONTAINER' }));
  });

  it('validates and inflates a single LayerData.pbin ZIP entry without writing it to disk', () => {
    const payload = Uint8Array.from([0x08, 0x96, 0x01]);
    const result = readSceneContainer(zip(payload), 'auto-dat');
    expect(result.format).toBe('zip-deflate');
    expect(result.crc32Valid).toBe(true);
    expect(result.payload).toEqual(payload);
  });

  it.each([
    ['wrong entry', { name: '../LayerData.pbin' }, 'UNSUPPORTED_SCENE_CONTAINER'],
    ['wrong crc', { crc: 123 }, 'SCENE_INTEGRITY_FAILED'],
    ['extra entry count', { extraEntry: true }, 'UNSUPPORTED_SCENE_CONTAINER'],
    ['encrypted', { flags: 0x0009 }, 'UNSUPPORTED_SCENE_CONTAINER'],
    ['unsupported method', { method: 0 }, 'UNSUPPORTED_SCENE_CONTAINER'],
    ['trailing bytes', { trailing: [1] }, 'SCENE_INTEGRITY_FAILED'],
  ])('rejects %s', (_name, overrides, code) => {
    expect(() => readSceneContainer(zip(Uint8Array.from([0x08, 1]), overrides), 'manual-dat'))
      .toThrowError(expect.objectContaining({ code }));
  });

  it('rejects truncated containers and decompression bombs by declared or actual size', () => {
    const valid = zip(Uint8Array.from([0x08, 1]));
    expect(() => readSceneContainer(valid.subarray(0, valid.length - 4), 'manual-dat'))
      .toThrowError(expect.objectContaining({ code: 'SCENE_INTEGRITY_FAILED' }));
    expect(() => readSceneContainer(zip(new Uint8Array(1024)), 'manual-dat', { maxPayloadBytes: 128 }))
      .toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));
  });
});
