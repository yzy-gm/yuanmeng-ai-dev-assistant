import { sha256Hex } from '../hash.js';
import { ProductError } from '../errors.js';

export type SceneWireType = 0 | 1 | 2 | 5;

export type SceneWireValue =
  | { kind: 'varint'; unsignedDecimal: string }
  | { kind: 'fixed32'; bitsHex: string }
  | { kind: 'fixed64'; bitsHex: string }
  | { kind: 'bytes'; offset: number; length: number; sha256: string };

export interface SceneWireField {
  fieldNumber: number;
  wireType: SceneWireType;
  occurrence: number;
  path: string;
  startOffset: number;
  endOffset: number;
  value: SceneWireValue;
}

export interface SceneWireDocument {
  byteLength: number;
  sha256: string;
  fields: SceneWireField[];
}

export interface SceneWireLimits {
  maxBytes?: number;
  maxFields?: number;
  maxLengthDelimitedBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FIELDS = 1_000_000;
const DEFAULT_MAX_LENGTH_DELIMITED_BYTES = 64 * 1024 * 1024;
const MAX_FIELD_NUMBER = 0x1fffffff;

function failure(message: string): ProductError {
  return new ProductError('SCENE_WIRE_INVALID', message, ['确认选择的是稳定且受支持的场景数据文件。'], 'STATIC_LOCAL');
}

function limitFailure(message: string): ProductError {
  return new ProductError('SCENE_LIMIT_EXCEEDED', message, ['降低文件规模或调整私有场景读取上限后重试。'], 'STATIC_LOCAL');
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw limitFailure(`${name} 必须是正整数。`);
  return value;
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw failure('varint 在文件末尾被截断。');
    if (index === 9 && byte > 1) throw failure('varint 超过 uint64 范围。');
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, nextOffset: offset + index + 1 };
  }
  throw failure('varint 超过 10 字节。');
}

function ensureAvailable(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (length < 0 || offset < 0 || offset + length > bytes.length) throw failure(`${label} 在文件末尾被截断。`);
}

function littleEndianHex(bytes: Uint8Array, offset: number, length: number): string {
  ensureAvailable(bytes, offset, length, 'fixed 字段');
  let result = '';
  for (let index = offset + length - 1; index >= offset; index -= 1) result += bytes[index]!.toString(16).padStart(2, '0');
  return result;
}

export function parseWireDocument(bytes: Uint8Array, limits: SceneWireLimits = {}): SceneWireDocument {
  const maxBytes = positiveLimit(limits.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
  const maxFields = positiveLimit(limits.maxFields ?? DEFAULT_MAX_FIELDS, 'maxFields');
  const maxLengthDelimitedBytes = positiveLimit(
    limits.maxLengthDelimitedBytes ?? DEFAULT_MAX_LENGTH_DELIMITED_BYTES,
    'maxLengthDelimitedBytes',
  );
  if (bytes.length === 0) throw failure('场景 wire payload 为空。');
  if (bytes.length > maxBytes) throw limitFailure('场景 wire payload 超过大小上限。');

  const occurrences = new Map<number, number>();
  const fields: SceneWireField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (fields.length >= maxFields) throw limitFailure('场景 wire 字段数量超过上限。');
    const startOffset = offset;
    const tag = readVarint(bytes, offset);
    offset = tag.nextOffset;
    if (tag.value === 0n) throw failure('protobuf tag 不能为 0。');
    const fieldNumberBigInt = tag.value >> 3n;
    const wireTypeBigInt = tag.value & 7n;
    if (fieldNumberBigInt < 1n || fieldNumberBigInt > BigInt(MAX_FIELD_NUMBER)) throw failure('protobuf field number 越界。');
    if (wireTypeBigInt !== 0n && wireTypeBigInt !== 1n && wireTypeBigInt !== 2n && wireTypeBigInt !== 5n) {
      throw failure(`不支持的 protobuf wire type：${wireTypeBigInt.toString()}。`);
    }
    const fieldNumber = Number(fieldNumberBigInt);
    const wireType = Number(wireTypeBigInt) as SceneWireType;
    let value: SceneWireValue;
    if (wireType === 0) {
      const scalar = readVarint(bytes, offset);
      offset = scalar.nextOffset;
      value = { kind: 'varint', unsignedDecimal: scalar.value.toString(10) };
    } else if (wireType === 1) {
      value = { kind: 'fixed64', bitsHex: littleEndianHex(bytes, offset, 8) };
      offset += 8;
    } else if (wireType === 5) {
      value = { kind: 'fixed32', bitsHex: littleEndianHex(bytes, offset, 4) };
      offset += 4;
    } else {
      const lengthValue = readVarint(bytes, offset);
      offset = lengthValue.nextOffset;
      if (lengthValue.value > BigInt(Number.MAX_SAFE_INTEGER)) throw limitFailure('length-delimited 长度不能安全表示。');
      const length = Number(lengthValue.value);
      if (length > maxLengthDelimitedBytes) throw limitFailure('length-delimited 字段超过大小上限。');
      ensureAvailable(bytes, offset, length, 'length-delimited 字段');
      value = { kind: 'bytes', offset, length, sha256: sha256Hex(bytes.subarray(offset, offset + length)) };
      offset += length;
    }
    const occurrence = occurrences.get(fieldNumber) ?? 0;
    occurrences.set(fieldNumber, occurrence + 1);
    fields.push({
      fieldNumber,
      wireType,
      occurrence,
      path: `$.${fieldNumber}[${occurrence}]`,
      startOffset,
      endOffset: offset,
      value,
    });
  }
  return { byteLength: bytes.length, sha256: sha256Hex(bytes), fields };
}

export function bytesForField(payload: Uint8Array, field: SceneWireField): Uint8Array {
  if (field.value.kind !== 'bytes') throw failure('目标 wire 字段不是 length-delimited。');
  return payload.subarray(field.value.offset, field.value.offset + field.value.length);
}

export function fixed32Float(field: SceneWireField): number {
  if (field.value.kind !== 'fixed32') throw failure('目标 wire 字段不是 fixed32。');
  const bits = Number.parseInt(field.value.bitsHex, 16);
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits, false);
  return view.getFloat32(0, false);
}
