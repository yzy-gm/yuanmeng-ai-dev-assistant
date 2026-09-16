import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';
import { diffSceneSnapshots, type SceneChange } from './diff.js';
import type { SceneSourceRole } from './container.js';
import type { SceneSnapshot } from './types.js';
import { sharedSceneRefreshScheduler } from './workflow.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const JOURNAL_INDEX_LIMIT = 100_000;
const LEGACY_SCAN_LIMIT = 1_000;
const CHANGE_KINDS = new Set<SceneChange['kind']>([
  'removed', 'added', 'type', 'relation', 'variant', 'position', 'rotation', 'scale', 'feature',
  'unknown-fields', 'group-removed', 'group-added', 'group-members', 'group-nested', 'evidence',
  'group-relation', 'group-feature', 'root-feature',
]);

export interface SceneChangeJournalSummary {
  kind: SceneChange['kind'];
  count: number;
}

export interface SceneChangeJournalEntry {
  schemaVersion: 1;
  journalId: string;
  bindingId: string;
  role: SceneSourceRole;
  adapterId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  fromSourceSha256: string;
  toSourceSha256: string;
  fromObservedAt: string;
  toObservedAt: string;
  changeCount: number;
  summary: SceneChangeJournalSummary[];
}

export interface SceneChangeJournalListOptions {
  bindingId: string;
  role: SceneSourceRole;
  adapterId: string;
  limit: number;
  currentSnapshotId?: string;
}

export interface SceneChangeJournalEvidenceResult {
  entries: SceneChangeJournalEntry[];
  status: 'complete' | 'evidence-insufficient';
  diagnostics: string[];
}

interface SceneChangeJournalIndexEntry {
  journalId: string;
  bindingId: string;
  role: SceneSourceRole;
  adapterId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  toObservedAt: string;
}

interface SceneChangeJournalIndex {
  schemaVersion: 1;
  entries: SceneChangeJournalIndexEntry[];
}

function body(entry: Omit<SceneChangeJournalEntry, 'journalId'> | SceneChangeJournalEntry): Omit<SceneChangeJournalEntry, 'journalId'> {
  return {
    schemaVersion: entry.schemaVersion,
    bindingId: entry.bindingId,
    role: entry.role,
    adapterId: entry.adapterId,
    fromSnapshotId: entry.fromSnapshotId,
    toSnapshotId: entry.toSnapshotId,
    fromSourceSha256: entry.fromSourceSha256,
    toSourceSha256: entry.toSourceSha256,
    fromObservedAt: entry.fromObservedAt,
    toObservedAt: entry.toObservedAt,
    changeCount: entry.changeCount,
    summary: entry.summary,
  };
}

function journalId(value: Omit<SceneChangeJournalEntry, 'journalId'>): string {
  return sha256Hex(stableJson(value));
}

function validateEntry(value: unknown): asserts value is SceneChangeJournalEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志必须是对象。', ['重新生成当前场景变更日志。'], 'STATIC_LOCAL');
  }
  const entry = value as Partial<SceneChangeJournalEntry>;
  if (
    entry.schemaVersion !== 1
    || typeof entry.journalId !== 'string' || !SHA256_PATTERN.test(entry.journalId)
    || typeof entry.bindingId !== 'string' || entry.bindingId.length === 0
    || (entry.role !== 'manual-dat' && entry.role !== 'auto-dat' && entry.role !== 'raw-pbin')
    || typeof entry.adapterId !== 'string' || entry.adapterId.length === 0
    || typeof entry.fromSnapshotId !== 'string' || !SHA256_PATTERN.test(entry.fromSnapshotId)
    || typeof entry.toSnapshotId !== 'string' || !SHA256_PATTERN.test(entry.toSnapshotId)
    || typeof entry.fromSourceSha256 !== 'string' || !SHA256_PATTERN.test(entry.fromSourceSha256)
    || typeof entry.toSourceSha256 !== 'string' || !SHA256_PATTERN.test(entry.toSourceSha256)
    || typeof entry.fromObservedAt !== 'string' || !Number.isFinite(Date.parse(entry.fromObservedAt))
    || typeof entry.toObservedAt !== 'string' || !Number.isFinite(Date.parse(entry.toObservedAt))
    || typeof entry.changeCount !== 'number' || !Number.isInteger(entry.changeCount) || entry.changeCount < 0
    || !Array.isArray(entry.summary)
    || entry.summary.some((item) => (
      typeof item !== 'object' || item === null || Array.isArray(item)
      || typeof item.kind !== 'string'
      || typeof item.count !== 'number' || !Number.isInteger(item.count) || item.count < 1
    ))
  ) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志字段无效。', ['重新生成当前场景变更日志。'], 'STATIC_LOCAL');
  }
  const validated = entry as SceneChangeJournalEntry;
  const summaryKinds = new Set<SceneChange['kind']>();
  for (const item of validated.summary) {
    if (!CHANGE_KINDS.has(item.kind) || summaryKinds.has(item.kind)) {
      throw new ProductError('VALIDATION_FAILED', '场景变更日志摘要 kind 无效或重复。', ['删除损坏日志并重新生成。'], 'STATIC_LOCAL');
    }
    summaryKinds.add(item.kind);
  }
  if (validated.journalId !== journalId(body(validated))) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志内容寻址校验失败。', ['删除损坏日志并重新生成。'], 'STATIC_LOCAL');
  }
  const counted = validated.summary.reduce((total, item) => total + item.count, 0);
  if (counted !== validated.changeCount) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志摘要计数不一致。', ['重新生成当前场景变更日志。'], 'STATIC_LOCAL');
  }
}

function indexEntry(entry: SceneChangeJournalEntry): SceneChangeJournalIndexEntry {
  return {
    journalId: entry.journalId,
    bindingId: entry.bindingId,
    role: entry.role,
    adapterId: entry.adapterId,
    fromSnapshotId: entry.fromSnapshotId,
    toSnapshotId: entry.toSnapshotId,
    toObservedAt: entry.toObservedAt,
  };
}

function validateIndex(value: unknown): asserts value is SceneChangeJournalIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProductError('VALIDATION_FAILED', '场景变更日志索引无效。', ['重新生成变更日志索引。'], 'STATIC_LOCAL');
  const index = value as Partial<SceneChangeJournalIndex>;
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries) || index.entries.length > JOURNAL_INDEX_LIMIT) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志索引无效。', ['重新生成变更日志索引。'], 'STATIC_LOCAL');
  }
  const ids = new Set<string>();
  for (const entry of index.entries) {
    if (
      typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || !SHA256_PATTERN.test(entry.journalId) || ids.has(entry.journalId)
      || typeof entry.bindingId !== 'string' || entry.bindingId.length === 0
      || (entry.role !== 'manual-dat' && entry.role !== 'auto-dat' && entry.role !== 'raw-pbin')
      || typeof entry.adapterId !== 'string' || entry.adapterId.length === 0
      || !SHA256_PATTERN.test(entry.fromSnapshotId) || !SHA256_PATTERN.test(entry.toSnapshotId)
      || !Number.isFinite(Date.parse(entry.toObservedAt))
    ) throw new ProductError('VALIDATION_FAILED', '场景变更日志索引条目无效。', ['重新生成变更日志索引。'], 'STATIC_LOCAL');
    ids.add(entry.journalId);
  }
}

export function createSceneChangeJournalEntry(before: SceneSnapshot, after: SceneSnapshot): SceneChangeJournalEntry {
  const diff = diffSceneSnapshots(before, after);
  const counts = new Map<SceneChange['kind'], number>();
  for (const change of diff.changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind, 'en'));
  const value: Omit<SceneChangeJournalEntry, 'journalId'> = {
    schemaVersion: 1,
    bindingId: after.bindingId,
    role: after.role,
    adapterId: after.adapterId,
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    fromSourceSha256: before.sourceSha256,
    toSourceSha256: after.sourceSha256,
    fromObservedAt: before.observedAt,
    toObservedAt: after.observedAt,
    changeCount: diff.changes.length,
    summary,
  };
  return { ...value, journalId: journalId(value) };
}

function journalPath(root: string, id: string): string {
  if (!SHA256_PATTERN.test(id)) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志 ID 无效。', ['使用 list 返回的完整日志 ID。'], 'STATIC_LOCAL');
  }
  return join(root, '.yuanmeng-inspector', 'scene', 'journal', `${id}.json`);
}

export async function saveSceneChangeJournalEntry(
  root: string,
  entry: SceneChangeJournalEntry,
  io: FileIO,
  options: { signal?: AbortSignal; commitGuard?(): void } = {},
): Promise<void> {
  validateEntry(entry);
  const resolvedRoot = resolve(root);
  await sharedSceneRefreshScheduler.start(resolvedRoot, 'journal-write', async (generation) => {
    const guard = (): void => {
      if (generation.signal.aborted) throw generation.signal.reason;
      if (options.signal?.aborted === true) throw options.signal.reason;
      options.commitGuard?.();
    };
    await atomicWriteJson(io, journalPath(resolvedRoot, entry.journalId), entry, validateEntry, { commitGuard: guard });
    const path = join(resolvedRoot, '.yuanmeng-inspector', 'scene', 'journal', 'index.json');
    let index: SceneChangeJournalIndex = { schemaVersion: 1, entries: [] };
    try {
      const value: unknown = JSON.parse(await io.readFile(path, 'utf8'));
      validateIndex(value);
      index = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries = [indexEntry(entry), ...index.entries.filter((candidate) => candidate.journalId !== entry.journalId)]
      .sort((left, right) => right.toObservedAt.localeCompare(left.toObservedAt) || right.journalId.localeCompare(left.journalId, 'en'))
      .slice(0, JOURNAL_INDEX_LIMIT);
    await atomicWriteJson(io, path, { schemaVersion: 1, entries }, validateIndex, { commitGuard: guard });
  });
}

export async function loadSceneChangeJournalEntry(root: string, id: string, io: FileIO): Promise<SceneChangeJournalEntry> {
  const value: unknown = JSON.parse(await io.readFile(journalPath(root, id), 'utf8'));
  validateEntry(value);
  return value;
}

export async function listSceneChangeJournal(
  root: string,
  io: FileIO,
  options: SceneChangeJournalListOptions,
): Promise<SceneChangeJournalEntry[]> {
  return (await listSceneChangeJournalWithEvidence(root, io, options)).entries;
}

async function loadJournalIndexBounded(
  root: string,
  io: FileIO,
): Promise<{ index: SceneChangeJournalIndex; diagnostics: string[] }> {
  const path = join(root, '.yuanmeng-inspector', 'scene', 'journal', 'index.json');
  try {
    const value: unknown = JSON.parse(await io.readFile(path, 'utf8'));
    validateIndex(value);
    return { index: value, diagnostics: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { index: { schemaVersion: 1, entries: [] }, diagnostics: ['变更日志索引损坏，当前时间线证据不足。'] };
    }
  }
  const directory = join(root, '.yuanmeng-inspector', 'scene', 'journal');
  let names: string[];
  const diagnostics: string[] = [];
  try {
    const allNames = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
    names = allNames.slice(0, LEGACY_SCAN_LIMIT);
    if (allNames.length > LEGACY_SCAN_LIMIT) {
      diagnostics.push(`旧版变更日志超过 ${LEGACY_SCAN_LIMIT} 条有界扫描上限，当前时间线证据不足；请刷新场景以重建索引。`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { index: { schemaVersion: 1, entries: [] }, diagnostics: [] };
    throw error;
  }
  const entries: SceneChangeJournalIndexEntry[] = [];
  for (const name of names) {
    try {
      entries.push(indexEntry(await loadSceneChangeJournalEntry(root, name.slice(0, -5), io)));
    } catch {
      diagnostics.push(`日志 ${name.slice(0, 12)} 损坏，已隔离。`);
    }
  }
  return { index: { schemaVersion: 1, entries }, diagnostics };
}

export async function listSceneChangeJournalWithEvidence(
  root: string,
  io: FileIO,
  options: SceneChangeJournalListOptions,
): Promise<SceneChangeJournalEvidenceResult> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
    throw new ProductError('VALIDATION_FAILED', '场景变更日志 limit 必须是 1 到 200。', ['使用有界日志数量。'], 'STATIC_LOCAL');
  }
  if (options.currentSnapshotId !== undefined && !SHA256_PATTERN.test(options.currentSnapshotId)) {
    throw new ProductError('VALIDATION_FAILED', '当前场景快照 ID 无效。', ['刷新场景快照后重试。'], 'STATIC_LOCAL');
  }
  const loaded = await loadJournalIndexBounded(root, io);
  const candidates = loaded.index.entries.filter((entry) => (
    entry.bindingId === options.bindingId && entry.role === options.role && entry.adapterId === options.adapterId
  ));
  let selected: SceneChangeJournalIndexEntry[];
  if (options.currentSnapshotId === undefined) {
    selected = candidates.slice(0, options.limit);
  } else {
    const byTo = new Map<string, SceneChangeJournalIndexEntry[]>();
    for (const entry of candidates) byTo.set(entry.toSnapshotId, [...(byTo.get(entry.toSnapshotId) ?? []), entry]);
    selected = [];
    const visited = new Set<string>();
    let cursor = options.currentSnapshotId;
    while (selected.length < options.limit) {
      if (visited.has(cursor)) {
        loaded.diagnostics.push('当前场景变更时间线形成循环，已停止回溯。');
        break;
      }
      visited.add(cursor);
      const matches = byTo.get(cursor) ?? [];
      if (matches.length === 0) break;
      if (matches.length > 1) {
        loaded.diagnostics.push(`快照 ${cursor.slice(0, 12)} 存在多个前驱，当前时间线为 AMBIGUOUS。`);
        break;
      }
      selected.push(matches[0]!);
      cursor = matches[0]!.fromSnapshotId;
    }
    if (selected.length === 0 && candidates.length > 0) {
      loaded.diagnostics.push(`当前快照 ${options.currentSnapshotId.slice(0, 12)} 与已有变更日志不连续，拒绝显示旧支。`);
    }
  }
  const entries: SceneChangeJournalEntry[] = [];
  for (const metadata of selected) {
    try {
      const entry = await loadSceneChangeJournalEntry(root, metadata.journalId, io);
      if (stableJson(indexEntry(entry)) !== stableJson(metadata)) throw new Error('index mismatch');
      entries.push(entry);
    } catch {
      loaded.diagnostics.push(`日志 ${metadata.journalId.slice(0, 12)} 损坏或缺失，已隔离。`);
      break;
    }
  }
  return {
    entries,
    status: loaded.diagnostics.length === 0 ? 'complete' : 'evidence-insufficient',
    diagnostics: loaded.diagnostics,
  };
}
