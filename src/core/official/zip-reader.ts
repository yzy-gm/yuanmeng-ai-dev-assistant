import { inflateRawSync } from 'node:zlib';

export interface ZipDirectoryEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
  method: number;
  crc: number;
  localOffset: number;
}

export function readZipDirectory(input: Uint8Array): ZipDirectoryEntry[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65_557); cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50
      && cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) { end = cursor; break; }
  }
  if (end < 0) throw new Error('ZIP end record missing');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== count || count > 10_000 || start + size !== end) {
    throw new Error('ZIP directory unsupported or out of bounds');
  }
  const entries: ZipDirectoryEntry[] = [];
  const names = new Set<string>();
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP entry invalid');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > end) throw new Error('ZIP entry out of bounds');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/gu, '/');
    if (!name || name.length > 512 || name.includes('\0') || /^(?:\/|[a-z]:)/iu.test(name)
      || name.split('/').includes('..') || names.has(name)) throw new Error('ZIP entry path invalid or duplicated');
    names.add(name);
    entries.push({
      name, flags: bytes.readUInt16LE(cursor + 8), method: bytes.readUInt16LE(cursor + 10),
      crc: bytes.readUInt32LE(cursor + 16), compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize: bytes.readUInt32LE(cursor + 24), localOffset: bytes.readUInt32LE(cursor + 42),
    });
    cursor = next;
  }
  if (cursor !== end) throw new Error('ZIP directory length mismatch');
  return entries.filter((entry) => !entry.name.endsWith('/')).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Decompress only requested template entries, in memory; never extract or execute files.
export function readZipEntry(input: Uint8Array, entry: ZipDirectoryEntry, maxBytes: number): Buffer {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const offset = entry.localOffset;
  if ((entry.flags & 1) !== 0 || entry.uncompressedSize > maxBytes || offset + 30 > bytes.length
    || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP payload unsupported');
  const nameLength = bytes.readUInt16LE(offset + 26);
  const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28);
  const localName = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8').replace(/\\/gu, '/');
  if (start + entry.compressedSize > bytes.length || localName !== entry.name
    || bytes.readUInt16LE(offset + 8) !== entry.method || bytes.readUInt16LE(offset + 6) !== entry.flags) {
    throw new Error('ZIP local header mismatch');
  }
  const payload = bytes.subarray(start, start + entry.compressedSize);
  const content = entry.method === 0 ? payload
    : entry.method === 8 ? inflateRawSync(payload, { maxOutputLength: maxBytes }) : null;
  if (content === null || content.length !== entry.uncompressedSize || crc32(content) !== entry.crc) {
    throw new Error('ZIP payload length or checksum mismatch');
  }
  return content;
}
