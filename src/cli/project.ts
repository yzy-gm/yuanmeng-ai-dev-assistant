import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { ProductError } from '../core/errors.js';
import { sha256Hex } from '../core/hash.js';
import {
  EXTENSION_ID,
  validateCliLauncherManifest,
  validateLauncherBinding,
  type CliLauncherManifest,
} from '../core/launcher/manifest.js';

export interface ResolvedCliProject {
  root: string;
  projectInstanceId: string;
  projectRootHash: string;
}

export interface ResolveProjectInput {
  project: string | null;
  launcherManifest: string | null;
  cwd: string;
  currentCliPath: string;
}

interface ProjectMetadata {
  schemaVersion: 1;
  projectInstanceId: string;
  projectRootHash: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function fail(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['重新从当前工程的向导初始化 CLI。'], 'STATIC_LOCAL');
}

function usage(message: string): never {
  throw new ProductError('USAGE_ERROR', message, ['指定唯一包含 src/GameEntry.lua 的工程。'], 'STATIC_LOCAL');
}

export function normalizeCanonicalRoot(root: string): string {
  let normalized = root.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (/^[A-Za-z]:/u.test(normalized)) {
    normalized = `${normalized[0]!.toLowerCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readMetadata(root: string): Promise<ProjectMetadata> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, '.yuanmeng-inspector', 'meta.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('工程尚未初始化，请先在 VSCode 中运行元梦 AI 开发助手向导。');
    }
    fail('工程元数据损坏。');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('工程元数据无效。');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || typeof record.projectInstanceId !== 'string'
    || !UUID_PATTERN.test(record.projectInstanceId)
    || typeof record.projectRootHash !== 'string'
    || !SHA256_PATTERN.test(record.projectRootHash)
  ) {
    fail('工程元数据身份无效。');
  }
  return value as ProjectMetadata;
}

async function findProjectRoot(start: string): Promise<string> {
  let current: string;
  try {
    current = await realpath(resolve(start));
    if (!(await stat(current)).isDirectory()) {
      current = dirname(current);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      usage('指定的工程路径不存在。');
    }
    throw error;
  }
  const candidates: string[] = [];
  while (true) {
    if (await isFile(join(current, 'src', 'GameEntry.lua'))) {
      candidates.push(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (candidates.length !== 1) {
    usage(candidates.length === 0 ? '未找到元梦工程。' : '找到多个嵌套元梦工程，拒绝猜测。');
  }
  return candidates[0]!;
}

async function loadManifest(path: string): Promise<CliLauncherManifest> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    validateCliLauncherManifest(value);
    return value;
  } catch (error) {
    if (error instanceof ProductError) {
      throw error;
    }
    fail('CLI 启动器清单不存在或已损坏。');
  }
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

async function resolveLauncherProject(input: ResolveProjectInput): Promise<ResolvedCliProject> {
  let manifestPath: string;
  try {
    manifestPath = await realpath(resolve(input.cwd, input.launcherManifest!));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('CLI 启动器清单不存在。');
    }
    throw error;
  }
  const manifest = await loadManifest(manifestPath);
  const currentCliPath = await realpath(input.currentCliPath);
  const recordedCliPath = await realpath(manifest.cliPath);
  const extensionRoot = await realpath(dirname(dirname(recordedCliPath)));
  if (!pathInside(extensionRoot, recordedCliPath)) {
    fail('CLI 目标不在扩展安装目录内。');
  }
  const cliBytes = await readFile(recordedCliPath);
  const packageValue = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  validateLauncherBinding(manifest, {
    extensionId: EXTENSION_ID,
    extensionVersion: typeof packageValue.version === 'string' ? packageValue.version : '',
    extensionRootHash: sha256Hex(normalizeCanonicalRoot(extensionRoot)),
    cliPath: currentCliPath,
    cliSha256: sha256Hex(cliBytes),
    projectInstanceId: manifest.projectInstanceId,
    projectRootHash: manifest.projectRootHash,
  });
  if (recordedCliPath !== currentCliPath) {
    fail('当前 CLI 与启动器绑定目标不一致。');
  }

  const root = await realpath(dirname(dirname(dirname(manifestPath))));
  if (input.project !== null) {
    const explicitRoot = await findProjectRoot(resolve(input.cwd, input.project));
    if (normalizeCanonicalRoot(await realpath(explicitRoot)) !== normalizeCanonicalRoot(root)) {
      fail('--project 与启动器绑定工程冲突。');
    }
  }
  const metadata = await readMetadata(root);
  const rootHash = sha256Hex(normalizeCanonicalRoot(root));
  if (
    metadata.projectInstanceId !== manifest.projectInstanceId
    || metadata.projectRootHash !== manifest.projectRootHash
    || rootHash !== manifest.projectRootHash
  ) {
    fail('启动器工程身份与当前工程不匹配。');
  }
  return { root, projectInstanceId: metadata.projectInstanceId, projectRootHash: rootHash };
}

export async function resolveCliProject(input: ResolveProjectInput): Promise<ResolvedCliProject> {
  if (input.launcherManifest !== null) {
    return resolveLauncherProject(input);
  }
  const root = await findProjectRoot(input.project ?? input.cwd);
  const canonicalRoot = await realpath(root);
  const metadata = await readMetadata(canonicalRoot);
  const rootHash = sha256Hex(normalizeCanonicalRoot(canonicalRoot));
  if (metadata.projectRootHash !== rootHash) {
    fail('工程路径指纹与元数据不匹配。');
  }
  return {
    root: canonicalRoot,
    projectInstanceId: metadata.projectInstanceId,
    projectRootHash: rootHash,
  };
}
