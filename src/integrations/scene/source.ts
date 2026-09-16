import { basename, dirname, join, relative } from 'node:path';

import { ProductError } from '../../core/errors.js';
import { atomicWriteJson, type FileIO } from '../../core/fs.js';
import { sha256Hex, stableJson } from '../../core/hash.js';
import type { SceneSourceRole } from '../../core/scene/container.js';

export interface SceneSourceBinding {
  schemaVersion: 1;
  bindingId: string;
  projectInstanceId: string;
  projectRootHash: string;
  role: SceneSourceRole;
  sourcePath: string;
  displayDirectory: string;
  directoryHash: string;
  createdAt: string;
}

export interface CreateSceneSourceBindingOptions {
  io: FileIO;
  projectInstanceId: string;
  projectRootHash: string;
  role: SceneSourceRole;
  sourcePath: string;
  now?: Date;
}

export interface StableSceneSourceOptions {
  io: FileIO;
  signal?: AbortSignal;
  sampleMilliseconds?: number;
  stableSampleCount?: number;
  totalTimeoutMilliseconds?: number;
}

export interface StableSceneSource {
  role: SceneSourceRole;
  bytes: Uint8Array;
  sha256: string;
  signature: string;
  elapsedMilliseconds: number;
}

export interface SaveSceneSourceBindingOptions {
  signal?: AbortSignal;
  commitGuard?(): void;
}

function validateBinding(value: unknown): asserts value is SceneSourceBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '场景来源绑定必须是对象。', ['重新绑定场景源。'], 'STATIC_LOCAL');
  }
  const binding = value as Partial<SceneSourceBinding>;
  if (
    binding.schemaVersion !== 1
    || typeof binding.bindingId !== 'string'
    || !/^[a-f0-9]{64}$/u.test(binding.bindingId)
    || typeof binding.projectInstanceId !== 'string'
    || typeof binding.projectRootHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(binding.projectRootHash)
    || (binding.role !== 'manual-dat' && binding.role !== 'auto-dat' && binding.role !== 'raw-pbin')
    || typeof binding.sourcePath !== 'string'
    || typeof binding.displayDirectory !== 'string'
    || typeof binding.directoryHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(binding.directoryHash)
    || typeof binding.createdAt !== 'string'
  ) throw new ProductError('VALIDATION_FAILED', '场景来源绑定字段无效。', ['重新绑定场景源。'], 'STATIC_LOCAL');
}

const SOURCE_NAMES: Readonly<Record<SceneSourceRole, string>> = {
  'manual-dat': 'LayerData.dat',
  'auto-dat': 'LayerData-Auto.dat',
  'raw-pbin': 'LayerData.pbin',
};

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('场景刷新已取消。');
  error.name = 'AbortError';
  throw error;
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProductError('VALIDATION_FAILED', `${name} 必须是正整数。`, ['检查场景监听设置。'], 'STATIC_LOCAL');
  }
  return value;
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return /^[A-Za-z]:/u.test(normalized) ? `${normalized[0]!.toLowerCase()}${normalized.slice(1)}` : normalized;
}

function insideDirectory(directory: string, target: string): boolean {
  const rel = relative(directory, target);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/u.test(rel);
}

export async function createSceneSourceBinding(options: CreateSceneSourceBindingOptions): Promise<SceneSourceBinding> {
  const expectedName = SOURCE_NAMES[options.role];
  if (basename(options.sourcePath) !== expectedName) {
    throw new ProductError('VALIDATION_FAILED', `${options.role} 只能绑定 ${expectedName}。`, ['选择对应来源角色的精确文件名。'], 'STATIC_LOCAL');
  }
  const sourcePath = await options.io.realpath(options.sourcePath);
  const sourceDirectory = await options.io.realpath(dirname(sourcePath));
  const expectedPath = await options.io.realpath(join(sourceDirectory, expectedName));
  if (normalizedPath(expectedPath) !== normalizedPath(sourcePath) || !insideDirectory(sourceDirectory, sourcePath)) {
    throw new ProductError('VALIDATION_FAILED', '场景源 realpath 越出已选择目录。', ['重新选择真实场景文件。'], 'STATIC_LOCAL');
  }
  const stat = await options.io.stat(sourcePath);
  if (!stat.isFile() || stat.size < 1) {
    throw new ProductError('VALIDATION_FAILED', '场景源不是非空文件。', ['等待编辑器完成保存后重试。'], 'STATIC_LOCAL');
  }
  const directoryHash = sha256Hex(normalizedPath(sourceDirectory));
  return {
    schemaVersion: 1,
    bindingId: sha256Hex(`scene-binding-v1\0${options.projectInstanceId}\0${options.role}\0${directoryHash}`),
    projectInstanceId: options.projectInstanceId,
    projectRootHash: options.projectRootHash,
    role: options.role,
    sourcePath,
    displayDirectory: basename(sourceDirectory),
    directoryHash,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}

function bindingPath(projectRoot: string, role: SceneSourceRole): string {
  return join(projectRoot, '.yuanmeng-inspector', 'scene', 'bindings', `${role}.json`);
}

async function loadSceneSourceBinding(
  projectRoot: string,
  role: SceneSourceRole,
  io: FileIO,
): Promise<SceneSourceBinding | null> {
  try {
    const value: unknown = JSON.parse(await io.readFile(bindingPath(projectRoot, role), 'utf8'));
    validateBinding(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertBindingCommit(options: SaveSceneSourceBindingOptions): void {
  throwIfAborted(options.signal);
  options.commitGuard?.();
}

export async function restoreSceneSourceBindingIfCurrent(
  projectRoot: string,
  attempted: SceneSourceBinding,
  previous: SceneSourceBinding | null,
  io: FileIO,
): Promise<boolean> {
  const current = await loadSceneSourceBinding(projectRoot, attempted.role, io);
  if (current === null || stableJson(current) !== stableJson(attempted)) return false;
  if (previous === null) await deleteSceneSourceBinding(projectRoot, attempted.role, io);
  else await atomicWriteJson(io, bindingPath(projectRoot, previous.role), previous, validateBinding);
  return true;
}

export async function saveSceneSourceBinding(
  projectRoot: string,
  binding: SceneSourceBinding,
  io: FileIO,
  options: SaveSceneSourceBindingOptions = {},
): Promise<void> {
  validateBinding(binding);
  const previous = await loadSceneSourceBinding(projectRoot, binding.role, io);
  assertBindingCommit(options);
  try {
    await atomicWriteJson(io, bindingPath(projectRoot, binding.role), binding, validateBinding, {
      commitGuard: () => assertBindingCommit(options),
    });
    assertBindingCommit(options);
  } catch (error) {
    await restoreSceneSourceBindingIfCurrent(projectRoot, binding, previous, io);
    throw error;
  }
}

export async function deleteSceneSourceBinding(
  projectRoot: string,
  role: SceneSourceRole,
  io: FileIO,
): Promise<void> {
  try {
    await io.unlink(bindingPath(projectRoot, role));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function loadSceneSourceBindings(projectRoot: string, io: FileIO): Promise<SceneSourceBinding[]> {
  const bindings: SceneSourceBinding[] = [];
  for (const role of ['manual-dat', 'auto-dat', 'raw-pbin'] as const) {
    try {
      const value = await loadSceneSourceBinding(projectRoot, role, io);
      if (value !== null) bindings.push(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return bindings;
}

interface SourceSignature {
  value: string;
  size: number;
}

async function signature(io: FileIO, path: string, signal?: AbortSignal): Promise<SourceSignature | null> {
  throwIfAborted(signal);
  try {
    const value = await io.stat(path);
    throwIfAborted(signal);
    return value.isFile() ? { value: `${value.size}:${value.mtimeMs}`, size: value.size } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readStableSceneSource(
  binding: SceneSourceBinding,
  options: StableSceneSourceOptions,
): Promise<StableSceneSource> {
  const sampleMilliseconds = positiveInteger(options.sampleMilliseconds ?? 200, 'sampleMilliseconds');
  const stableSampleCount = positiveInteger(options.stableSampleCount ?? 3, 'stableSampleCount');
  const totalTimeoutMilliseconds = positiveInteger(options.totalTimeoutMilliseconds ?? 15_000, 'totalTimeoutMilliseconds');
  throwIfAborted(options.signal);
  const expectedRealPath = await options.io.realpath(binding.sourcePath);
  throwIfAborted(options.signal);
  if (normalizedPath(expectedRealPath) !== normalizedPath(binding.sourcePath)) {
    throw new ProductError('SCENE_SOURCE_CONFLICT', '场景源 realpath 已改变。', ['重新绑定场景源。'], 'STATIC_LOCAL');
  }
  const startedAt = Date.now();
  let previousSignature: string | null = null;
  let equalSamples = 0;
  while (Date.now() - startedAt <= totalTimeoutMilliseconds) {
    throwIfAborted(options.signal);
    const current = await signature(options.io, binding.sourcePath, options.signal);
    if (current !== null && current.size > MAX_SOURCE_BYTES) {
      throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景源超过 256 MiB 输入上限。', ['确认绑定的是正确的场景文件。'], 'STATIC_LOCAL');
    }
    const currentSignature = current?.value ?? null;
    if (currentSignature !== null && currentSignature === previousSignature) equalSamples += 1;
    else equalSamples = currentSignature === null ? 0 : 1;
    previousSignature = currentSignature;
    if (current !== null && equalSamples >= stableSampleCount) {
      throwIfAborted(options.signal);
      const beforeRead = await signature(options.io, binding.sourcePath, options.signal);
      if (beforeRead !== null && beforeRead.size > MAX_SOURCE_BYTES) {
        throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景源超过 256 MiB 输入上限。', ['确认绑定的是正确的场景文件。'], 'STATIC_LOCAL');
      }
      if (beforeRead?.value !== currentSignature) {
        previousSignature = beforeRead?.value ?? null;
        equalSamples = beforeRead === null ? 0 : 1;
        await delay(sampleMilliseconds, options.signal);
        continue;
      }
      const bytes = await options.io.readBytes(binding.sourcePath, MAX_SOURCE_BYTES);
      throwIfAborted(options.signal);
      const afterRead = await signature(options.io, binding.sourcePath, options.signal);
      if (bytes.byteLength > MAX_SOURCE_BYTES || (afterRead !== null && afterRead.size > MAX_SOURCE_BYTES)) {
        throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景源超过 256 MiB 输入上限。', ['确认绑定的是正确的场景文件。'], 'STATIC_LOCAL');
      }
      if (afterRead?.value === currentSignature && bytes.byteLength === beforeRead.size) {
        const stableBytes = Uint8Array.from(bytes);
        return {
          role: binding.role,
          bytes: stableBytes,
          sha256: sha256Hex(stableBytes),
          signature: currentSignature,
          elapsedMilliseconds: Date.now() - startedAt,
        };
      }
      previousSignature = afterRead?.value ?? null;
      equalSamples = 0;
    }
    await delay(sampleMilliseconds, options.signal);
  }
  throw new ProductError('SCENE_SOURCE_UNSTABLE', '场景源在超时前未达到稳定状态。', ['等待编辑器保存完成后重新刷新。'], 'STATIC_LOCAL');
}
