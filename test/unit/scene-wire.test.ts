import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseWireDocument } from '../../src/core/scene/wire.js';

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return bytes;
}

function field(fieldNumber: number, wireType: 0 | 1 | 2 | 5, payload: number[]): number[] {
  return [...varint(BigInt((fieldNumber << 3) | wireType)), ...payload];
}

describe('bounded scene wire reader', () => {
  it('preserves lossless scalar bits and opaque length-delimited bytes', () => {
    const opaque = [0x08, 0x2a];
    const bytes = Uint8Array.from([
      ...field(1, 0, varint(9_007_199_254_740_993n)),
      ...field(2, 5, [0x00, 0x00, 0x80, 0x3f]),
      ...field(3, 1, [1, 2, 3, 4, 5, 6, 7, 8]),
      ...field(4, 2, [...varint(BigInt(opaque.length)), ...opaque]),
    ]);

    const document = parseWireDocument(bytes);

    expect(document.fields).toEqual([
      expect.objectContaining({ fieldNumber: 1, occurrence: 0, value: { kind: 'varint', unsignedDecimal: '9007199254740993' } }),
      expect.objectContaining({ fieldNumber: 2, occurrence: 0, value: { kind: 'fixed32', bitsHex: '3f800000' } }),
      expect.objectContaining({ fieldNumber: 3, occurrence: 0, value: { kind: 'fixed64', bitsHex: '0807060504030201' } }),
      expect.objectContaining({
        fieldNumber: 4,
        occurrence: 0,
        value: {
          kind: 'bytes',
          offset: bytes.length - opaque.length,
          length: opaque.length,
          sha256: createHash('sha256').update(Uint8Array.from(opaque)).digest('hex'),
        },
      }),
    ]);
    expect('children' in document.fields[3]!).toBe(false);
  });

  it('tracks repeated field occurrences deterministically', () => {
    const bytes = Uint8Array.from([
      ...field(7, 0, varint(1n)),
      ...field(7, 0, varint(2n)),
    ]);
    expect(parseWireDocument(bytes).fields.map((candidate) => candidate.path)).toEqual(['$.7[0]', '$.7[1]']);
  });

  it.each([
    ['tag zero', [0x00], 'SCENE_WIRE_INVALID'],
    ['unsupported group', [0x0b], 'SCENE_WIRE_INVALID'],
    ['truncated fixed32', [0x0d, 1, 2], 'SCENE_WIRE_INVALID'],
    ['truncated bytes', [0x0a, 5, 1], 'SCENE_WIRE_INVALID'],
    ['overlong varint', [0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00], 'SCENE_WIRE_INVALID'],
  ])('rejects %s', (_name, input, code) => {
    expect(() => parseWireDocument(Uint8Array.from(input as number[]))).toThrowError(expect.objectContaining({ code }));
  });

  it('enforces byte and node budgets', () => {
    const bytes = Uint8Array.from([...field(1, 0, [1]), ...field(2, 0, [2])]);
    expect(() => parseWireDocument(bytes, { maxBytes: 2 })).toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));
    expect(() => parseWireDocument(bytes, { maxFields: 1 })).toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));
  });
});
