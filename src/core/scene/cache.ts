import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, nodeFileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';
import { loadSceneHeads } from './store.js';
import { sharedSceneRefreshScheduler } from './workflow.js';

export interface SceneCachePruneOptions {
  maxCount: number;
  maxAgeMilliseconds: number;
  now?: Date;
}

export interface SceneCacheCandidate {
  relativePath: string;
  bytes: number;
  contentSha256: string;
  reason: 'age' | 'count' | 'age-and-count';
}

export interface SceneCachePrunePreview {
  schemaVersion: 1;
  candidates: SceneCacheCandidate[];
  totalBytes: number;
  stateHash: string;
}

export interface SceneCachePruneResult extends SceneCachePrunePreview {
  deletedCount: number;
  deletedBytes: number;
}

export interface SceneCachePruneOperations {
  unlink(path: string): Promise<void>;
}

const DEFAULT_PRUNE_OPERATIONS: SceneCachePruneOperations = { unlink };

interface CacheFile {
  path: string;
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  contentSha256: string;
}

const CACHE_DIRECTORIES = [
  ['scene', 'snapshots'],
  ['ui', 'snapshots'],
  ['scene', 'derived'],
  ['scene', 'diffs'],
  ['scene', 'evidence'],
  ['scene', 'journal'],
  ['derived'],
  ['logs'],
  ['reports'],
  ['journal'],
  ['journals'],
  ['gameplay', 'reports'],
] as const;
const CACHE_AREA_PATHS = [...new Set(CACHE_DIRECTORIES.map((segments) => segments.join('/')))]
  .sort((left, right) => left.localeCompare(right, 'en'));
const PROTECTED_CACHE_AREA_PATHS = ['gameplay/runs'] as const;
const SNAPSHOT_PATH = /^\.yuanmeng-inspector\/(scene|ui)\/snapshots\/([a-f0-9]{64})\.json$/u;
const JOURNAL_ENTRY_PATH = /^\.yuanmeng-inspector\/scene\/journal\/([a-f0-9]{64})\.json$/u;
const JOURNAL_INDEX_PATH = '.yuanmeng-inspector/scene/journal/index.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ATOMIC_TEMP_FILE = /^\..+\.\d+\.[a-f0-9]+\.tmp$/u;

export interface SceneCacheSummaryOptions {
  /** Number of largest files to return. Zero is valid when only totals are needed. */
  largestLimit?: number;
  /** A warning is returned when prunable bytes exceed this value. */
  warningThresholdBytes?: number;
}

export interface SceneCacheAreaSummary {
  area: string;
  fileCount: number;
  bytes: number;
}

export interface SceneCacheFileSummary {
  relativePath: string;
  bytes: number;
}

export interface SceneCacheSummary {
  schemaVersion: 1;
  fileCount: number;
  totalBytes: number;
  areas: SceneCacheAreaSummary[];
  largestFiles: SceneCacheFileSummary[];
  protected: {
    gameplayRuns: {
      fileCount: number;
      bytes: number;
    };
  };
  warning: 'over-budget' | null;
}

const DEFAULT_CACHE_SUMMARY_OPTIONS = Object.freeze({
  largestLimit: 10,
  warningThresholdBytes: 2 * 1024 * 1024 * 1024,
});

function validateSummaryOptions(options: SceneCacheSummaryOptions): Required<SceneCacheSummaryOptions> {
  const largestLimit = options.largestLimit ?? DEFAULT_CACHE_SUMMARY_OPTIONS.largestLimit;
  const warningThresholdBytes = options.warningThresholdBytes ?? DEFAULT_CACHE_SUMMARY_OPTIONS.warningThresholdBytes;
  if (!Number.isSafeInteger(largestLimit) || largestLimit < 0 || largestLimit > 100) {
    throw new ProductError('VALIDATION_FAILED', '缓存摘要最大文件数量必须是 0 到 100 的整数。', ['调整缓存摘要设置后重试。'], 'STATIC_LOCAL');
  }
  if (!Number.isSafeInteger(warningThresholdBytes) || warningThresholdBytes < 0) {
    throw new ProductError('VALIDATION_FAILED', '缓存摘要告警阈值必须是非负整数。', ['调整缓存摘要设置后重试。'], 'STATIC_LOCAL');
  }
  return { largestLimit, warningThresholdBytes };
}

interface CacheSummaryAccumulator {
  fileCount: number;
  totalBytes: number;
  files: SceneCacheFileSummary[];
}

async function collectSummaryFiles(
  root: string,
  directory: string,
  accumulator: CacheSummaryAccumulator,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSummaryFiles(root, path, accumulator);
      continue;
    }
    if (!entry.isFile() || ATOMIC_TEMP_FILE.test(entry.name) || /^LayerData(?:-Auto)?\.(?:dat|pbin)$/iu.test(entry.name)) continue;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    const relativePath = relative(root, path).replace(/\\/gu, '/');
    accumulator.fileCount += 1;
    accumulator.totalBytes += metadata.size;
    accumulator.files.push({ relativePath, bytes: metadata.size });
  }
}

async function summarizeArea(root: string, area: string): Promise<CacheSummaryAccumulator> {
  const accumulator: CacheSummaryAccumulator = { fileCount: 0, totalBytes: 0, files: [] };
  await collectSummaryFiles(root, join(resolve(root), '.yuanmeng-inspector', ...area.split('/')), accumulator);
  return accumulator;
}

/**
 * Read only metadata summary for generated inspector cache. It deliberately does
 * not open file contents or calculate hashes, and never includes raw LayerData,
 * registry/runtime state, or committed gameplay runs in the prunable total.
 */
export async function summarizeSceneCache(
  root: string,
  options: SceneCacheSummaryOptions = {},
): Promise<SceneCacheSummary> {
  const resolvedRoot = resolve(root);
  const resolvedOptions = validateSummaryOptions(options);
  const [areas, gameplayRuns] = await Promise.all([
    Promise.all(CACHE_AREA_PATHS.map(async (area) => {
      const summary = await summarizeArea(resolvedRoot, area);
      return { area, fileCount: summary.fileCount, bytes: summary.totalBytes, files: summary.files };
    })),
    summarizeArea(resolvedRoot, PROTECTED_CACHE_AREA_PATHS[0]),
  ]);
  const files = areas.flatMap((area) => area.files)
    .sort((left, right) => right.bytes - left.bytes || left.relativePath.localeCompare(right.relativePath, 'en'));
  return {
    schemaVersion: 1,
    fileCount: areas.reduce((total, area) => total + area.fileCount, 0),
    totalBytes: areas.reduce((total, area) => total + area.bytes, 0),
    areas: areas.map(({ area, fileCount, bytes }) => ({ area, fileCount, bytes })),
    largestFiles: files.slice(0, resolvedOptions.largestLimit),
    protected: {
      gameplayRuns: { fileCount: gameplayRuns.fileCount, bytes: gameplayRuns.totalBytes },
    },
    warning: areas.reduce((total, area) => total + area.bytes, 0) > resolvedOptions.warningThresholdBytes
      ? 'over-budget'
      : null,
  };
}

async function contentSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function validateOptions(options: SceneCachePruneOptions): void {
  if (!Number.isSafeInteger(options.maxCount) || options.maxCount < 0) {
    throw new ProductError('VALIDATION_FAILED', '缓存保留数量必须是非负整数。', ['调整清理设置后重试。'], 'STATIC_LOCAL');
  }
  if (!Number.isFinite(options.maxAgeMilliseconds) || options.maxAgeMilliseconds < 0) {
    throw new ProductError('VALIDATION_FAILED', '缓存保留时间必须是非负数。', ['调整清理设置后重试。'], 'STATIC_LOCAL');
  }
  if (options.now !== undefined && Number.isNaN(options.now.getTime())) {
    throw new ProductError('VALIDATION_FAILED', '缓存清理时间无效。', ['使用有效时间后重试。'], 'STATIC_LOCAL');
  }
}

async function collectFiles(root: string, directory: string, output: CacheFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, path, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (ATOMIC_TEMP_FILE.test(entry.name)) continue;
    if (/^LayerData(?:-Auto)?\.(?:dat|pbin)$/iu.test(entry.name)) continue;
    const relativePath = relative(root, path).replace(/\\/gu, '/');
    if (relativePath === JOURNAL_INDEX_PATH) continue;
    const metadata = await stat(path);
    const hash = await contentSha256(path);
    const verified = await stat(path);
    if (metadata.size !== verified.size || metadata.mtimeMs !== verified.mtimeMs) {
      throw new ProductError('VALIDATION_FAILED', '缓存文件在预览时发生变化。', ['等待派生文件写入完成后重新预览。'], 'STATIC_LOCAL');
    }
    const snapshotMatch = SNAPSHOT_PATH.exec(relativePath);
    if (relativePath.includes('/snapshots/') && snapshotMatch === null) continue;
    output.push({ path, relativePath, bytes: metadata.size, mtimeMs: metadata.mtimeMs, contentSha256: hash });
  }
}

async function currentUiSnapshotId(root: string): Promise<string | null> {
  const path = join(root, '.yuanmeng-inspector', 'ui', 'current.json');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ProductError('VALIDATION_FAILED', 'UI 当前快照损坏，无法证明缓存保护边界。', ['重新获取 UI 结构后再清理缓存。'], 'STATIC_LOCAL', error);
  }
  const snapshotId = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { snapshotId?: unknown }).snapshotId
    : undefined;
  if (typeof snapshotId !== 'string' || !SHA256_PATTERN.test(snapshotId)) {
    throw new ProductError('VALIDATION_FAILED', 'UI 当前快照 ID 无效，无法证明缓存保护边界。', ['重新获取 UI 结构后再清理缓存。'], 'STATIC_LOCAL');
  }
  return snapshotId;
}

interface CacheJournalIndex {
  schemaVersion: 1;
  entries: Array<{ journalId: string; [key: string]: unknown }>;
}

function validateCacheJournalIndex(value: unknown): asserts value is CacheJournalIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志索引损坏，拒绝清理日志。', ['刷新场景以重建日志索引。'], 'STATIC_LOCAL');
  }
  const index = value as Partial<CacheJournalIndex>;
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries) || index.entries.length > 100_000) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志索引损坏，拒绝清理日志。', ['刷新场景以重建日志索引。'], 'STATIC_LOCAL');
  }
  const ids = new Set<string>();
  for (const entry of index.entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || !SHA256_PATTERN.test(entry.journalId) || ids.has(entry.journalId)) {
      throw new ProductError('VALIDATION_FAILED', '场景变更日志索引损坏，拒绝清理日志。', ['刷新场景以重建日志索引。'], 'STATIC_LOCAL');
    }
    ids.add(entry.journalId);
  }
}

async function removeJournalIndexEntries(root: string, journalIds: ReadonlySet<string>, commitGuard: () => void): Promise<void> {
  if (journalIds.size === 0) return;
  const path = join(root, ...JOURNAL_INDEX_PATH.split('/'));
  let value: unknown;
  try {
    value = JSON.parse(await nodeFileIO.readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ProductError('VALIDATION_FAILED', '场景变更日志索引损坏，拒绝清理日志。', ['刷新场景以重建日志索引。'], 'STATIC_LOCAL', error);
  }
  validateCacheJournalIndex(value);
  const next: CacheJournalIndex = {
    schemaVersion: 1,
    entries: value.entries.filter((entry) => !journalIds.has(entry.journalId)),
  };
  await atomicWriteJson(nodeFileIO, path, next, validateCacheJournalIndex, { commitGuard });
}

async function enumerateSceneCache(root: string): Promise<CacheFile[]> {
  const inspectorRoot = join(resolve(root), '.yuanmeng-inspector');
  const files: CacheFile[] = [];
  for (const segments of CACHE_DIRECTORIES) await collectFiles(resolve(root), join(inspectorRoot, ...segments), files);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath, 'en'));
}

export async function previewSceneCachePrune(
  root: string,
  options: SceneCachePruneOptions,
): Promise<SceneCachePrunePreview> {
  validateOptions(options);
  const now = options.now?.getTime() ?? Date.now();
  const [heads, protectedUiSnapshotId] = await Promise.all([
    loadSceneHeads(root, nodeFileIO),
    currentUiSnapshotId(root),
  ]);
  const protectedSceneSnapshots = new Set([
    heads.manualSnapshotId,
    heads.autoSnapshotId,
    heads.rawSnapshotId,
    heads.preferredSnapshotId,
  ].filter((value): value is string => value !== null));
  const files = await enumerateSceneCache(root);
  let retained = 0;
  const candidates: SceneCacheCandidate[] = [];
  for (const file of files) {
    const snapshotMatch = SNAPSHOT_PATH.exec(file.relativePath);
    if (
      snapshotMatch !== null
      && (
        (snapshotMatch[1] === 'scene' && protectedSceneSnapshots.has(snapshotMatch[2]!))
        || (snapshotMatch[1] === 'ui' && snapshotMatch[2] === protectedUiSnapshotId)
      )
    ) continue;
    const overAge = now - file.mtimeMs > options.maxAgeMilliseconds;
    const overCount = retained >= options.maxCount;
    if (overAge || overCount) {
      candidates.push({
        relativePath: file.relativePath,
        bytes: file.bytes,
        contentSha256: file.contentSha256,
        reason: overAge && overCount ? 'age-and-count' : overAge ? 'age' : 'count',
      });
    } else {
      retained += 1;
    }
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const stateHash = sha256Hex(stableJson({
    schemaVersion: 1,
    policy: { maxCount: options.maxCount, maxAgeMilliseconds: options.maxAgeMilliseconds },
    heads,
    protectedUiSnapshotId,
    files: files.map(({ relativePath, bytes, mtimeMs, contentSha256 }) => ({ relativePath, bytes, mtimeMs, contentSha256 })),
    candidates,
  }));
  return {
    schemaVersion: 1,
    candidates,
    totalBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    stateHash,
  };
}

export async function applySceneCachePrune(
  root: string,
  options: SceneCachePruneOptions,
  confirmHash: string,
  operations: SceneCachePruneOperations = DEFAULT_PRUNE_OPERATIONS,
): Promise<SceneCachePruneResult> {
  if (!SHA256_PATTERN.test(confirmHash)) {
    throw new ProductError('VALIDATION_FAILED', '缓存清理确认哈希无效。', ['重新生成清理预览。'], 'STATIC_LOCAL');
  }
  const resolvedRoot = resolve(root);
  return sharedSceneRefreshScheduler.start(resolvedRoot, 'cache-prune', async (generation) => {
    const preview = await previewSceneCachePrune(resolvedRoot, options);
    if (generation.signal.aborted || preview.stateHash !== confirmHash) {
      throw new ProductError('VALIDATION_FAILED', '缓存状态已变化，拒绝执行旧的清理预览。', ['重新预览并确认。'], 'STATIC_LOCAL');
    }
    const inspectorRoot = join(resolvedRoot, '.yuanmeng-inspector');
    const inspectorPrefix = `${inspectorRoot}${sep}`;
    const targets = await Promise.all(preview.candidates.map(async (candidate) => {
      const target = resolve(resolvedRoot, ...candidate.relativePath.split('/'));
      if (!target.startsWith(inspectorPrefix) || /^LayerData(?:-Auto)?\.(?:dat|pbin)$/iu.test(candidate.relativePath.split('/').at(-1) ?? '')) {
        throw new ProductError('VALIDATION_FAILED', '缓存候选路径越出私有派生目录。', ['重新生成清理预览。'], 'STATIC_LOCAL');
      }
      const metadata = await lstat(target);
      if (
        !metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== candidate.bytes
        || await contentSha256(target) !== candidate.contentSha256
      ) {
        throw new ProductError('VALIDATION_FAILED', '缓存候选文件身份已变化。', ['重新生成清理预览。'], 'STATIC_LOCAL');
      }
      return { candidate, target };
    }));

    const journalIds = new Set(targets.flatMap(({ candidate }) => {
      const match = JOURNAL_ENTRY_PATH.exec(candidate.relativePath);
      return match === null ? [] : [match[1]!];
    }));
    const generationGuard = (): void => {
      if (generation.signal.aborted) {
        throw new ProductError('VALIDATION_FAILED', '缓存清理已被更新操作取消。', ['重新生成清理预览。'], 'STATIC_LOCAL');
      }
    };

    let deletedCount = 0;
    let deletedBytes = 0;
    for (const { candidate, target } of targets) {
      if (generation.signal.aborted) {
        throw new ProductError('VALIDATION_FAILED', '缓存清理已被更新操作取消。', ['重新生成清理预览。'], 'STATIC_LOCAL');
      }
      const heads = await loadSceneHeads(resolvedRoot, nodeFileIO);
      const snapshotMatch = SNAPSHOT_PATH.exec(candidate.relativePath);
      const uiSnapshotId = snapshotMatch?.[1] === 'ui' ? await currentUiSnapshotId(resolvedRoot) : null;
      if (snapshotMatch !== null && (
        (snapshotMatch[1] === 'scene' && [
          heads.manualSnapshotId,
          heads.autoSnapshotId,
          heads.rawSnapshotId,
          heads.preferredSnapshotId,
        ].includes(snapshotMatch[2]!))
        || (snapshotMatch[1] === 'ui' && snapshotMatch[2] === uiSnapshotId)
      )) {
        throw new ProductError('VALIDATION_FAILED', '缓存候选已成为当前场景快照，拒绝删除。', ['重新生成清理预览。'], 'STATIC_LOCAL');
      }
      const metadata = await lstat(target);
      if (
        !metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== candidate.bytes
        || await contentSha256(target) !== candidate.contentSha256
      ) {
        throw new ProductError('VALIDATION_FAILED', '缓存候选文件身份已变化。', ['重新生成清理预览。'], 'STATIC_LOCAL');
      }
      await operations.unlink(target);
      deletedCount += 1;
      deletedBytes += candidate.bytes;
    }
    // 先删除日志文件，全部成功后才提交索引。若删除中断，旧索引会显式暴露缺失证据，
    // 不会静默隐藏仍存在但尚未删除的血缘记录。
    await removeJournalIndexEntries(resolvedRoot, journalIds, generationGuard);
    return { ...preview, deletedCount, deletedBytes };
  });
}
