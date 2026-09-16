import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';
import { sha256Hex } from '../hash.js';

export const FEEDBACK_KINDS = ['bug', 'friction', 'improvement'] as const;
export const FEEDBACK_STATUSES = ['open', 'resolved'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackContext {
  projectInstanceId: string;
  extensionVersion: string | null;
  uiSnapshotId: string | null;
  sceneSnapshotId: string | null;
}

export interface FeedbackEntry {
  schemaVersion: 1;
  feedbackId: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  title: string;
  message: string;
  source: 'ai' | 'user';
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  context: FeedbackContext;
}

export interface FeedbackListResult {
  summary: {
    total: number;
    open: number;
    resolved: number;
    byKind: Record<FeedbackKind, number>;
  };
  entries: FeedbackEntry[];
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invalid(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['缩短并清理反馈内容后重试。'], 'STATIC_LOCAL');
}

function validDate(value: string): boolean {
  return value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function validText(value: string, maximum: number, singleLine: boolean): boolean {
  const hasDisallowedControl = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
  if (value.trim().length < 1 || value.length > maximum || hasDisallowedControl) return false;
  return !singleLine || !/[\r\n]/u.test(value);
}

function validateContext(value: FeedbackContext): void {
  if (!UUID.test(value.projectInstanceId)
    || (value.extensionVersion !== null && (value.extensionVersion.length < 1 || value.extensionVersion.length > 64))
    || (value.uiSnapshotId !== null && !SHA256.test(value.uiSnapshotId))
    || (value.sceneSnapshotId !== null && !SHA256.test(value.sceneSnapshotId))) invalid('反馈上下文无效。');
}

function validateEntry(value: unknown): asserts value is FeedbackEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('反馈记录必须是对象。');
  const entry = value as Partial<FeedbackEntry>;
  if (entry.schemaVersion !== 1 || typeof entry.feedbackId !== 'string' || !SHA256.test(entry.feedbackId)
    || !FEEDBACK_KINDS.includes(entry.kind as FeedbackKind) || !FEEDBACK_STATUSES.includes(entry.status as FeedbackStatus)
    || typeof entry.title !== 'string' || !validText(entry.title, 120, true)
    || typeof entry.message !== 'string' || !validText(entry.message, 4000, false)
    || (entry.source !== 'ai' && entry.source !== 'user')
    || typeof entry.createdAt !== 'string' || !validDate(entry.createdAt)
    || (entry.resolvedAt !== null && (typeof entry.resolvedAt !== 'string' || !validDate(entry.resolvedAt)))
    || (entry.resolution !== null && (typeof entry.resolution !== 'string' || !validText(entry.resolution, 2000, false)))
    || typeof entry.context !== 'object' || entry.context === null) invalid('反馈记录字段无效。');
  validateContext(entry.context as FeedbackContext);
  if ((entry.status === 'open' && (entry.resolvedAt !== null || entry.resolution !== null))
    || (entry.status === 'resolved' && (entry.resolvedAt === null || entry.resolution === null))) invalid('反馈处理状态与处理说明不一致。');
}

function entryPath(root: string, feedbackId: string): string {
  if (!SHA256.test(feedbackId)) invalid('反馈 ID 无效。');
  return join(root, '.yuanmeng-inspector', 'feedback', 'entries', `${feedbackId}.json`);
}

export async function addFeedback(
  root: string,
  input: {
    kind: FeedbackKind;
    title: string;
    message: string;
    source: FeedbackEntry['source'];
    context: FeedbackContext;
    createdAt?: string;
  },
  io: FileIO,
): Promise<FeedbackEntry> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entry: FeedbackEntry = {
    schemaVersion: 1,
    feedbackId: sha256Hex(`ymai-feedback-v1\0${input.context.projectInstanceId}\0${createdAt}\0${randomUUID()}`),
    kind: input.kind,
    status: 'open',
    title: input.title.trim(),
    message: input.message.trim(),
    source: input.source,
    createdAt,
    resolvedAt: null,
    resolution: null,
    context: { ...input.context },
  };
  validateEntry(entry);
  await atomicWriteJson(io, entryPath(root, entry.feedbackId), entry, validateEntry);
  return entry;
}

async function readEntries(root: string, io: FileIO): Promise<FeedbackEntry[]> {
  const directory = join(root, '.yuanmeng-inspector', 'feedback', 'entries');
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = await Promise.all(names.map(async (name) => {
    const value: unknown = JSON.parse(await io.readFile(join(directory, name), 'utf8'));
    validateEntry(value);
    return value;
  }));
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.feedbackId.localeCompare(right.feedbackId, 'en'));
}

export async function listFeedback(
  root: string,
  filter: { status: FeedbackStatus | null; kind: FeedbackKind | null },
  io: FileIO,
): Promise<FeedbackListResult> {
  const all = await readEntries(root, io);
  const byKind: Record<FeedbackKind, number> = { bug: 0, friction: 0, improvement: 0 };
  for (const entry of all) byKind[entry.kind] += 1;
  return {
    summary: {
      total: all.length,
      open: all.filter((entry) => entry.status === 'open').length,
      resolved: all.filter((entry) => entry.status === 'resolved').length,
      byKind,
    },
    entries: all.filter((entry) => (filter.status === null || entry.status === filter.status)
      && (filter.kind === null || entry.kind === filter.kind)),
  };
}

export async function resolveFeedback(
  root: string,
  feedbackId: string,
  input: { resolution: string; resolvedAt?: string },
  io: FileIO,
): Promise<FeedbackEntry> {
  let value: unknown;
  try {
    value = JSON.parse(await io.readFile(entryPath(root, feedbackId), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProductError('NOT_FOUND', '没有找到指定反馈。', ['运行 feedback list --json 查看反馈 ID。'], 'STATIC_LOCAL');
    }
    throw error;
  }
  validateEntry(value);
  const resolved: FeedbackEntry = {
    ...value,
    status: 'resolved',
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
    resolution: input.resolution.trim(),
  };
  validateEntry(resolved);
  await atomicWriteJson(io, entryPath(root, feedbackId), resolved, validateEntry);
  return resolved;
}
