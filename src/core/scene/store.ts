import { join } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';
import { stableJson } from '../hash.js';
import type { SceneSnapshot } from './types.js';
import { assertSceneSnapshotDocument } from './worker-protocol.js';

export interface SceneHeads {
  schemaVersion: 1;
  manualSnapshotId: string | null;
  autoSnapshotId: string | null;
  rawSnapshotId: string | null;
  preferredSnapshotId: string | null;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function validateHeads(value: unknown): asserts value is SceneHeads {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProductError('VALIDATION_FAILED', '场景 heads 必须是对象。', ['清理损坏的场景缓存后重试。'], 'STATIC_LOCAL');
  const heads = value as Partial<SceneHeads>;
  if (heads.schemaVersion !== 1) throw new ProductError('VALIDATION_FAILED', '场景 heads 版本无效。', ['升级插件或清理场景缓存。'], 'STATIC_LOCAL');
  for (const candidate of [heads.manualSnapshotId, heads.autoSnapshotId, heads.rawSnapshotId, heads.preferredSnapshotId]) {
    if (candidate !== null && (typeof candidate !== 'string' || !SHA256_PATTERN.test(candidate))) {
      throw new ProductError('VALIDATION_FAILED', '场景 heads 快照 ID 无效。', ['清理损坏的场景缓存后重试。'], 'STATIC_LOCAL');
    }
  }
}

function validateSnapshot(value: unknown): asserts value is SceneSnapshot {
  assertSceneSnapshotDocument(value);
}

function emptyHeads(): SceneHeads {
  return { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('场景刷新已取消。');
  error.name = 'AbortError';
  throw error;
}

function assertCommit(signal: AbortSignal | undefined, commitGuard: (() => void) | undefined): void {
  throwIfAborted(signal);
  commitGuard?.();
}

async function restoreHeadsIfCommitted(
  root: string,
  io: FileIO,
  attempted: SceneHeads,
  previous: SceneHeads,
): Promise<void> {
  const path = join(root, '.yuanmeng-inspector', 'scene', 'heads.json');
  try {
    const current: unknown = JSON.parse(await io.readFile(path, 'utf8'));
    validateHeads(current);
    if (stableJson(current) === stableJson(attempted)) {
      await atomicWriteJson(io, path, previous, validateHeads);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function recoverableCacheError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    || error instanceof SyntaxError
    || (error instanceof ProductError && error.code === 'VALIDATION_FAILED');
}

export async function loadSceneHeads(root: string, io: FileIO): Promise<SceneHeads> {
  try {
    const value: unknown = JSON.parse(await io.readFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), 'utf8'));
    validateHeads(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyHeads();
    throw error;
  }
}

export async function loadSceneSnapshot(root: string, snapshotId: string, io: FileIO): Promise<SceneSnapshot> {
  if (!SHA256_PATTERN.test(snapshotId)) throw new ProductError('VALIDATION_FAILED', '场景快照 ID 无效。', ['选择有效快照。'], 'STATIC_LOCAL');
  const value: unknown = JSON.parse(await io.readFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${snapshotId}.json`), 'utf8'));
  validateSnapshot(value);
  return value;
}

export async function loadSceneSnapshotIfValid(
  root: string,
  snapshotId: string,
  io: FileIO,
): Promise<SceneSnapshot | null> {
  try {
    return await loadSceneSnapshot(root, snapshotId, io);
  } catch (error) {
    if (recoverableCacheError(error)) return null;
    throw error;
  }
}

export async function loadSceneHeadsOrEmpty(root: string, io: FileIO): Promise<SceneHeads> {
  try {
    return await loadSceneHeads(root, io);
  } catch (error) {
    if (recoverableCacheError(error)) return emptyHeads();
    throw error;
  }
}

export async function setPreferredSceneSnapshot(
  root: string,
  snapshotId: string,
  io: FileIO,
  options: { signal?: AbortSignal; heads?: SceneHeads; commitGuard?(): void } = {},
): Promise<SceneHeads> {
  if (!SHA256_PATTERN.test(snapshotId)) throw new ProductError('VALIDATION_FAILED', '场景快照 ID 无效。', ['选择有效快照。'], 'STATIC_LOCAL');
  const heads = options.heads ?? await loadSceneHeads(root, io);
  if (![heads.manualSnapshotId, heads.autoSnapshotId, heads.rawSnapshotId].includes(snapshotId)) {
    throw new ProductError('VALIDATION_FAILED', '首选场景快照不是当前 role head。', ['重新刷新对应场景源。'], 'STATIC_LOCAL');
  }
  if (heads.preferredSnapshotId === snapshotId) return heads;
  const next = { ...heads, preferredSnapshotId: snapshotId };
  assertCommit(options.signal, options.commitGuard);
  try {
    await atomicWriteJson(io, join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), next, validateHeads, {
      commitGuard: () => assertCommit(options.signal, options.commitGuard),
    });
    assertCommit(options.signal, options.commitGuard);
  } catch (error) {
    await restoreHeadsIfCommitted(root, io, next, heads);
    throw error;
  }
  return next;
}

export async function saveSceneSnapshot(
  root: string,
  snapshot: SceneSnapshot,
  io: FileIO,
  options: { preferred: boolean; signal?: AbortSignal; heads?: SceneHeads; commitGuard?(): void },
): Promise<SceneHeads> {
  validateSnapshot(snapshot);
  const sceneRoot = join(root, '.yuanmeng-inspector', 'scene');
  assertCommit(options.signal, options.commitGuard);
  await atomicWriteJson(io, join(sceneRoot, 'snapshots', `${snapshot.snapshotId}.json`), snapshot, validateSnapshot, {
    commitGuard: () => assertCommit(options.signal, options.commitGuard),
  });
  assertCommit(options.signal, options.commitGuard);
  const heads = options.heads ?? await loadSceneHeads(root, io);
  const next: SceneHeads = {
    ...heads,
    manualSnapshotId: snapshot.role === 'manual-dat' ? snapshot.snapshotId : heads.manualSnapshotId,
    autoSnapshotId: snapshot.role === 'auto-dat' ? snapshot.snapshotId : heads.autoSnapshotId,
    rawSnapshotId: snapshot.role === 'raw-pbin' ? snapshot.snapshotId : heads.rawSnapshotId,
    preferredSnapshotId: options.preferred ? snapshot.snapshotId : heads.preferredSnapshotId ?? snapshot.snapshotId,
  };
  assertCommit(options.signal, options.commitGuard);
  try {
    await atomicWriteJson(io, join(sceneRoot, 'heads.json'), next, validateHeads, {
      commitGuard: () => assertCommit(options.signal, options.commitGuard),
    });
    assertCommit(options.signal, options.commitGuard);
  } catch (error) {
    await restoreHeadsIfCommitted(root, io, next, heads);
    throw error;
  }
  return next;
}
