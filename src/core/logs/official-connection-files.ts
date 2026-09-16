import { open, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { OfficialConnectionLogDocument } from './official-connection.js';

const MAX_ANCESTORS = 5;
const MAX_OUTPUT_LOG_DIRECTORIES = 8;
const MAX_LOG_FILES = 12;
const MAX_LOG_BYTES = 256 * 1024;

interface DirectoryCandidate {
  path: string;
  mtimeMs: number;
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface OfficialConnectionLogCache {
  signature: string | null;
  documents: OfficialConnectionLogDocument[];
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
}

function ancestorPaths(seed: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let current = seed;
  for (let index = 0; index < MAX_ANCESTORS && current !== '' && !seen.has(current); index += 1) {
    paths.push(current);
    seen.add(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

async function findOutputLogDirectories(logPath: string): Promise<DirectoryCandidate[]> {
  const candidates: DirectoryCandidate[] = [];
  const seen = new Set<string>();
  for (const parent of ancestorPaths(logPath)) {
    let entries: DirectoryEntry[];
    try {
      entries = await readdir(parent, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if (isMissing(error)) continue;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^output_logging_[A-Za-z0-9_-]+$/u.test(entry.name)) continue;
      const path = join(parent, entry.name);
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const metadata = await stat(path);
        if (metadata.isDirectory()) candidates.push({ path, mtimeMs: metadata.mtimeMs });
      } catch (error) {
        if (!isMissing(error)) continue;
      }
    }
  }
  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, MAX_OUTPUT_LOG_DIRECTORIES);
}

async function readTail(path: string): Promise<string | null> {
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
  if (!metadata.isFile()) return null;
  const length = Math.min(metadata.size, MAX_LOG_BYTES);
  const start = Math.max(0, metadata.size - length);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(buffer, offset, length - offset, start + offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Read only bounded tails of the current VS Code extension-host output log
 * folders. The caller must pass the current extension context's log path.
 */
export async function readOfficialConnectionLogDocuments(
  logPath: string,
  cache?: OfficialConnectionLogCache,
): Promise<OfficialConnectionLogDocument[]> {
  const directories = await findOutputLogDirectories(logPath);
  const files: Array<{ path: string; name: string; modifiedAt: number; size: number }> = [];
  for (const directory of directories) {
    let entries: DirectoryEntry[];
    try {
      entries = await readdir(directory.path, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      if (isMissing(error)) continue;
      continue;
    }
    for (const entry of entries
      .filter((candidate) => candidate.isFile() && /dreamhelper/iu.test(candidate.name) && /\.log$/iu.test(candidate.name))
      .slice(0, MAX_LOG_FILES)) {
      const path = join(directory.path, entry.name);
      try {
        const metadata = await stat(path);
        if (metadata.isFile()) files.push({ path, name: entry.name, modifiedAt: metadata.mtimeMs, size: metadata.size });
      } catch (error) {
        if (!isMissing(error)) continue;
      }
    }
  }
  const signature = files
    .map((file) => `${file.path}\0${file.modifiedAt}\0${file.size}`)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .join('\n');
  if (cache?.signature === signature) return cache.documents;
  const documents: OfficialConnectionLogDocument[] = [];
  for (const file of files) {
    try {
      const content = await readTail(file.path);
      if (content === null) continue;
      documents.push({ name: file.name, content, modifiedAt: file.modifiedAt });
    } catch (error) {
      if (!isMissing(error)) continue;
    }
  }
  if (cache !== undefined) {
    cache.signature = signature;
    cache.documents = documents;
  }
  return documents;
}
