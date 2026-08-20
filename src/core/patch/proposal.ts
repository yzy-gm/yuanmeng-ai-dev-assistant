import { readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, atomicWriteText, nodeFileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';

export interface PatchProposal {
  schemaVersion: 1;
  proposalId: string;
  projectInstanceId: string;
  targetPath: string;
  originalContent: string | null;
  newContent: string;
  originalSha256: string | null;
  newSha256: string;
  summary: string;
  createdAt: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  proposalId: string;
  projectInstanceId: string;
  targetPath: string;
  originalSha256: string | null;
  newSha256: string;
  originalExisted: boolean;
  backupPath: string | null;
  createdAt: string;
}

export interface AppliedProposal {
  manifestPath: string;
  backupPath: string | null;
}

function validation(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['检查补丁目标和当前文件后重试。'], 'STATIC_LOCAL');
}

function normalizedRelativePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/');
  if (
    normalized.length === 0
    || isAbsolute(path)
    || /^[a-z]:\//iu.test(normalized)
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    validation('补丁目标必须是工程内的安全相对路径。');
  }
  return normalized;
}

export function validateTarget(path: string): string {
  const normalized = normalizedRelativePath(path);
  const lower = normalized.toLocaleLowerCase('en-US');
  if (
    lower === 'dist/play.lua'
    || lower === 'dist/play.min.lua'
    || lower.startsWith('.yuanmeng-inspector/')
    || lower.startsWith('node_modules/')
  ) {
    throw new ProductError(
      'GENERATED_FILE_PROTECTED',
      `禁止修改受保护文件：${normalized}`,
      ['请选择 src 下的用户 Lua 源文件。'],
      'STATIC_LOCAL',
    );
  }
  if (!lower.endsWith('.lua')) {
    validation('补丁目标必须是 .lua 源文件。');
  }
  return normalized;
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  const back = relative(resolvedRoot, target);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) {
    validation('补丁目标越过了工程边界。');
  }
  return target;
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || Number.isNaN(Date.parse(value))) {
    validation('补丁时间必须是 UTC ISO 8601。');
  }
}

export function validatePatchProposal(value: unknown): asserts value is PatchProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation('补丁提案必须是对象。');
  const proposal = value as Partial<PatchProposal>;
  if (
    proposal.schemaVersion !== 1
    || typeof proposal.proposalId !== 'string'
    || typeof proposal.projectInstanceId !== 'string'
    || typeof proposal.targetPath !== 'string'
    || (proposal.originalContent !== null && typeof proposal.originalContent !== 'string')
    || typeof proposal.newContent !== 'string'
    || (proposal.originalSha256 !== null && typeof proposal.originalSha256 !== 'string')
    || typeof proposal.newSha256 !== 'string'
    || typeof proposal.summary !== 'string'
    || typeof proposal.createdAt !== 'string'
  ) validation('补丁提案字段无效。');
  const targetPath = validateTarget(proposal.targetPath);
  assertIsoDate(proposal.createdAt);
  if (!/^[0-9a-f-]{36}$/iu.test(proposal.projectInstanceId) || proposal.summary.trim() === '') {
    validation('补丁提案的工程实例或摘要无效。');
  }
  const originalSha256 = proposal.originalContent === null ? null : sha256Hex(proposal.originalContent);
  const newSha256 = sha256Hex(proposal.newContent);
  if (originalSha256 !== proposal.originalSha256 || newSha256 !== proposal.newSha256) {
    validation('补丁提案内容与哈希不一致。');
  }
  const expectedId = sha256Hex(stableJson({
    projectInstanceId: proposal.projectInstanceId,
    targetPath,
    originalSha256,
    newSha256,
    summary: proposal.summary.trim(),
    createdAt: proposal.createdAt,
  }));
  if (expectedId !== proposal.proposalId) validation('补丁提案身份哈希无效。');
}

export function createPatchProposal(input: {
  projectInstanceId: string;
  targetPath: string;
  originalContent: string | null;
  newContent: string;
  summary: string;
  createdAt: string;
}): PatchProposal {
  const targetPath = validateTarget(input.targetPath);
  assertIsoDate(input.createdAt);
  if (input.projectInstanceId.trim() === '' || input.summary.trim() === '') {
    validation('补丁必须包含工程实例和摘要。');
  }
  const identity = {
    projectInstanceId: input.projectInstanceId,
    targetPath,
    originalSha256: input.originalContent === null ? null : sha256Hex(input.originalContent),
    newSha256: sha256Hex(input.newContent),
    summary: input.summary.trim(),
    createdAt: input.createdAt,
  };
  return {
    schemaVersion: 1,
    proposalId: sha256Hex(stableJson(identity)),
    ...identity,
    originalContent: input.originalContent,
    newContent: input.newContent,
  };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertCurrentMatches(current: string | null, expectedSha256: string | null): void {
  const actual = current === null ? null : sha256Hex(current);
  if (actual !== expectedSha256) {
    throw new ProductError(
      'HASH_CONFLICT',
      '文件在预览后已发生变化，已停止写入或撤销。',
      ['重新生成差异预览后再确认。'],
      'STATIC_LOCAL',
    );
  }
}

function assertManifest(value: unknown): asserts value is BackupManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation('备份清单必须是对象。');
  const manifest = value as Partial<BackupManifest>;
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.proposalId !== 'string'
    || typeof manifest.projectInstanceId !== 'string'
    || typeof manifest.targetPath !== 'string'
    || (manifest.originalSha256 !== null && typeof manifest.originalSha256 !== 'string')
    || typeof manifest.newSha256 !== 'string'
    || typeof manifest.originalExisted !== 'boolean'
    || (manifest.backupPath !== null && typeof manifest.backupPath !== 'string')
    || typeof manifest.createdAt !== 'string'
  ) validation('备份清单字段无效。');
  validateTarget(manifest.targetPath);
}

export async function createBackup(root: string, proposal: PatchProposal): Promise<AppliedProposal> {
  validatePatchProposal(proposal);
  const targetPath = validateTarget(proposal.targetPath);
  const target = resolveInside(root, targetPath);
  const current = await readOptional(target);
  assertCurrentMatches(current, proposal.originalSha256);
  if (sha256Hex(proposal.newContent) !== proposal.newSha256) validation('补丁新内容哈希无效。');

  const timestamp = proposal.createdAt.replace(/[:.]/gu, '-');
  const backupDirectory = join(resolve(root), '.yuanmeng-inspector', 'backups', `${timestamp}-${proposal.proposalId.slice(0, 12)}`);
  const backupRelative = current === null ? null : `${targetPath}.bak`;
  const backupPath = backupRelative === null ? null : join(backupDirectory, ...backupRelative.split('/'));
  if (backupPath !== null && current !== null) await atomicWriteText(nodeFileIO, backupPath, current);
  const manifest: BackupManifest = {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    projectInstanceId: proposal.projectInstanceId,
    targetPath,
    originalSha256: proposal.originalSha256,
    newSha256: proposal.newSha256,
    originalExisted: current !== null,
    backupPath: backupRelative,
    createdAt: proposal.createdAt,
  };
  const manifestPath = join(backupDirectory, 'manifest.json');
  await atomicWriteJson(nodeFileIO, manifestPath, manifest, assertManifest);
  return { manifestPath, backupPath };
}

export async function applyProposal(root: string, proposal: PatchProposal, confirmed: boolean): Promise<AppliedProposal> {
  if (!confirmed) {
    throw new ProductError(
      'CONFIRMATION_REQUIRED',
      '尚未确认差异，未写入文件。',
      ['在差异视图中确认后再应用。'],
      'STATIC_LOCAL',
    );
  }
  const target = resolveInside(root, validateTarget(proposal.targetPath));
  const applied = await createBackup(root, proposal);
  assertCurrentMatches(await readOptional(target), proposal.originalSha256);
  await atomicWriteText(nodeFileIO, target, proposal.newContent);
  return applied;
}

export async function undoBackup(root: string, manifestPath: string): Promise<void> {
  const backupRoot = resolve(root, '.yuanmeng-inspector', 'backups');
  const resolvedManifest = resolve(manifestPath);
  const manifestRelative = relative(backupRoot, resolvedManifest);
  if (manifestRelative.startsWith('..') || isAbsolute(manifestRelative) || manifestRelative === '') {
    validation('撤销清单不在当前工程备份目录内。');
  }
  const manifestValue: unknown = JSON.parse(await readFile(resolvedManifest, 'utf8'));
  assertManifest(manifestValue);
  const manifest = manifestValue;
  const target = resolveInside(root, manifest.targetPath);
  const current = await readOptional(target);
  assertCurrentMatches(current, manifest.newSha256);
  if (!manifest.originalExisted) {
    await unlink(target);
    return;
  }
  if (manifest.backupPath === null) validation('已有文件的备份清单缺少备份路径。');
  const backupPath = resolveInside(resolve(manifestPath, '..'), manifest.backupPath);
  const original = await readFile(backupPath, 'utf8');
  if (sha256Hex(original) !== manifest.originalSha256) validation('备份内容哈希与清单不一致。');
  await atomicWriteText(nodeFileIO, target, original);
}
