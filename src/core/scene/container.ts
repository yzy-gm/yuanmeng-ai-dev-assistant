import { inflateRawSync } from 'node:zlib';

import { ProductError } from '../errors.js';

export type SceneSourceRole = 'manual-dat' | 'auto-dat' | 'raw-pbin';

export interface SceneContainerLimits {
  maxInputBytes?: number;
  maxPayloadBytes?: number;
  maxCompressionRatio?: number;
}

export interface SceneContainerResult {
  role: SceneSourceRole;
  format: 'zip-deflate' | 'raw-protobuf';
  compressedBytes: number | null;
  payloadBytes: number;
  crc32Valid: boolean | null;
  payload: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const EOCD_SIGNATURE = 0x06054b50;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 500;

function containerFailure(message: string): ProductError {
  return new ProductError('UNSUPPORTED_SCENE_CONTAINER', message, ['重新选择 manual、auto 或 raw 场景源。'], 'STATIC_LOCAL');
}

function integrityFailure(message: string, cause?: unknown): ProductError {
  return new ProductError('SCENE_INTEGRITY_FAILED', message, ['等待编辑器完成保存后重新读取。'], 'STATIC_LOCAL', cause);
}

function limitFailure(message: string, cause?: unknown): ProductError {
  return new ProductError('SCENE_LIMIT_EXCEEDED', message, ['降低场景文件规模或读取上限后重试。'], 'STATIC_LOCAL', cause);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw limitFailure(`${name} 必须是正整数。`);
  return value;
}

function ensureRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw integrityFailure(`${label} 越出容器边界。`);
  }
}

function u16(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 2, 'ZIP uint16');
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  ensureRange(bytes, offset, 4, 'ZIP uint32');
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function exactEntryName(bytes: Uint8Array, offset: number, length: number): boolean {
  const expected = new TextEncoder().encode('LayerData.pbin');
  if (length !== expected.length) return false;
  for (let index = 0; index < length; index += 1) if (bytes[offset + index] !== expected[index]) return false;
  return true;
}

function findEocd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (u32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  throw integrityFailure('ZIP 缺少 EOCD。');
}

function readZip(bytes: Uint8Array, role: SceneSourceRole, maxPayloadBytes: number, maxCompressionRatio: number): SceneContainerResult {
  const eocdOffset = findEocd(bytes);
  const commentLength = u16(bytes, eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== bytes.length) throw integrityFailure('ZIP 存在尾随或截断数据。');
  if (u16(bytes, eocdOffset + 4) !== 0 || u16(bytes, eocdOffset + 6) !== 0) throw containerFailure('不支持多磁盘 ZIP。');
  const entriesOnDisk = u16(bytes, eocdOffset + 8);
  const totalEntries = u16(bytes, eocdOffset + 10);
  if (entriesOnDisk !== 1 || totalEntries !== 1) throw containerFailure('场景 ZIP 必须只有一个 LayerData.pbin 条目。');
  const centralSize = u32(bytes, eocdOffset + 12);
  const centralOffset = u32(bytes, eocdOffset + 16);
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) throw containerFailure('当前私有版不支持 Zip64。');
  ensureRange(bytes, centralOffset, centralSize, 'ZIP Central Directory');
  if (centralOffset + centralSize !== eocdOffset) throw integrityFailure('Central Directory 边界不一致。');
  if (u32(bytes, centralOffset) !== CENTRAL_SIGNATURE) throw integrityFailure('Central Directory 签名无效。');
  const flags = u16(bytes, centralOffset + 8);
  const method = u16(bytes, centralOffset + 10);
  if ((flags & 1) !== 0) throw containerFailure('不读取加密场景 ZIP。');
  if ((flags & 8) === 0) throw containerFailure('场景 ZIP 必须使用已验证的 data descriptor 结构。');
  if (method !== 8) throw containerFailure('场景 ZIP 只支持 Deflate。');
  const expectedCrc = u32(bytes, centralOffset + 16);
  const compressedSize = u32(bytes, centralOffset + 20);
  const uncompressedSize = u32(bytes, centralOffset + 24);
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw containerFailure('当前私有版不支持 Zip64。');
  if (uncompressedSize > maxPayloadBytes) throw limitFailure('场景 payload 超过上限。');
  if (compressedSize === 0 || uncompressedSize / compressedSize > maxCompressionRatio) throw limitFailure('场景 ZIP 压缩比超过安全上限。');
  const centralNameLength = u16(bytes, centralOffset + 28);
  const centralExtraLength = u16(bytes, centralOffset + 30);
  const centralCommentLength = u16(bytes, centralOffset + 32);
  const localOffset = u32(bytes, centralOffset + 42);
  if (localOffset === 0xffffffff) throw containerFailure('当前私有版不支持 Zip64。');
  const centralRecordLength = 46 + centralNameLength + centralExtraLength + centralCommentLength;
  if (centralRecordLength !== centralSize) throw containerFailure('场景 ZIP 包含额外或损坏的 Central Directory 记录。');
  ensureRange(bytes, centralOffset + 46, centralNameLength, 'Central Directory 文件名');
  if (!exactEntryName(bytes, centralOffset + 46, centralNameLength)) throw containerFailure('ZIP 条目必须精确命名为 LayerData.pbin。');

  if (u32(bytes, localOffset) !== LOCAL_SIGNATURE) throw integrityFailure('Local Header 签名无效。');
  const localFlags = u16(bytes, localOffset + 6);
  const localMethod = u16(bytes, localOffset + 8);
  if (localFlags !== flags || localMethod !== method) throw integrityFailure('Local Header 与 Central Directory 不一致。');
  const localNameLength = u16(bytes, localOffset + 26);
  const localExtraLength = u16(bytes, localOffset + 28);
  ensureRange(bytes, localOffset + 30, localNameLength, 'Local Header 文件名');
  if (!exactEntryName(bytes, localOffset + 30, localNameLength)) throw integrityFailure('Local Header 文件名不一致。');
  const compressedOffset = localOffset + 30 + localNameLength + localExtraLength;
  ensureRange(bytes, compressedOffset, compressedSize, 'ZIP 压缩数据');
  const descriptorOffset = compressedOffset + compressedSize;
  ensureRange(bytes, descriptorOffset, 16, 'ZIP data descriptor');
  if (u32(bytes, descriptorOffset) !== DESCRIPTOR_SIGNATURE) throw integrityFailure('ZIP data descriptor 签名无效。');
  if (
    u32(bytes, descriptorOffset + 4) !== expectedCrc
    || u32(bytes, descriptorOffset + 8) !== compressedSize
    || u32(bytes, descriptorOffset + 12) !== uncompressedSize
  ) throw integrityFailure('ZIP data descriptor 与 Central Directory 不一致。');
  if (descriptorOffset + 16 !== centralOffset) throw integrityFailure('ZIP 压缩数据边界不一致。');

  let inflated: Uint8Array;
  try {
    inflated = inflateRawSync(bytes.subarray(compressedOffset, descriptorOffset), { maxOutputLength: maxPayloadBytes });
  } catch (error) {
    throw integrityFailure('无法安全解压场景 ZIP。', error);
  }
  if (inflated.length !== uncompressedSize) throw integrityFailure('场景 payload 长度与 Central Directory 不一致。');
  if (crc32(inflated) !== expectedCrc) throw integrityFailure('场景 payload CRC 校验失败。');
  return {
    role,
    format: 'zip-deflate',
    compressedBytes: compressedSize,
    payloadBytes: inflated.length,
    crc32Valid: true,
    payload: Uint8Array.from(inflated),
  };
}

export function readSceneContainer(
  bytes: Uint8Array,
  role: SceneSourceRole,
  limits: SceneContainerLimits = {},
): SceneContainerResult {
  const maxInputBytes = positiveLimit(limits.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, 'maxInputBytes');
  const maxPayloadBytes = positiveLimit(limits.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 'maxPayloadBytes');
  const maxCompressionRatio = positiveLimit(limits.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO, 'maxCompressionRatio');
  if (bytes.length === 0) throw containerFailure('场景源文件为空。');
  if (bytes.length > maxInputBytes) throw limitFailure('场景源文件超过大小上限。');
  const isZip = bytes.length >= 4 && u32(bytes, 0) === LOCAL_SIGNATURE;
  if (role === 'raw-pbin') {
    if (isZip) throw containerFailure('raw-pbin 角色不能绑定 ZIP 容器。');
    if (bytes.length > maxPayloadBytes) throw limitFailure('场景 payload 超过上限。');
    return {
      role,
      format: 'raw-protobuf',
      compressedBytes: null,
      payloadBytes: bytes.length,
      crc32Valid: null,
      payload: Uint8Array.from(bytes),
    };
  }
  if (!isZip) throw containerFailure('manual-dat/auto-dat 必须绑定受支持的 ZIP 容器。');
  return readZip(bytes, role, maxPayloadBytes, maxCompressionRatio);
}
