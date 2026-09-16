import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ProductError } from './errors.js';
import { stableJson } from './hash.js';

export interface WritableFile {
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface FileIO {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: 'wx'): Promise<WritableFile>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readBytes(path: string, maxBytes?: number): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number; size: number }>;
  unlink(path: string): Promise<void>;
}

export interface AtomicWriteOptions {
  commitGuard?(): void;
}

export const nodeFileIO: FileIO = {
  mkdir: async (path, options) => mkdir(path, options),
  open: async (path, flags) => open(path, flags) as Promise<FileHandle>,
  readFile,
  readBytes: async (path, maxBytes) => {
    if (maxBytes === undefined) return readFile(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('maxBytes must be a non-negative safe integer.');
    }
    const handle = await open(path, 'r');
    try {
      const fileStat = await handle.stat();
      const capacity = Math.min(maxBytes + 1, fileStat.size + 1);
      const bytes = new Uint8Array(capacity);
      let offset = 0;
      while (offset < capacity) {
        const result = await handle.read(bytes, offset, capacity - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  },
  realpath,
  rename,
  stat,
  unlink,
};

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const WINDOWS_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validationError(message: string, cause: unknown): ProductError {
  if (cause instanceof ProductError) {
    return cause;
  }
  return new ProductError('VALIDATION_FAILED', message, ['检查数据格式后重试。'], 'STATIC_LOCAL', cause);
}

async function removeTemporaryFile(io: FileIO, path: string): Promise<void> {
  try {
    await io.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function renameWithRetry(io: FileIO, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryDelay = RENAME_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || code === undefined || !WINDOWS_RETRY_CODES.has(code)) {
        throw error;
      }
      await delay(retryDelay);
    }
  }
}

export async function atomicWriteJson<T>(
  io: FileIO,
  target: string,
  value: T,
  validate: (value: unknown) => asserts value is T,
  options: AtomicWriteOptions = {},
): Promise<void> {
  try {
    validate(value);
  } catch (error) {
    throw validationError('待写入 JSON 未通过校验。', error);
  }

  const directory = dirname(target);
  await io.mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: WritableFile | undefined;

  try {
    handle = await io.open(temporaryPath, 'wx');
    await handle.writeFile(stableJson(value), { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    options.commitGuard?.();
    await renameWithRetry(io, temporaryPath, target);
    options.commitGuard?.();
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The original write error is more actionable than a secondary close failure.
      }
    }
    try {
      await removeTemporaryFile(io, temporaryPath);
    } catch {
      // Preserve the write failure; privacy audits detect any orphaned temporary file.
    }
    if (error instanceof ProductError || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    throw new ProductError(
      'ATOMIC_WRITE_FAILED',
      '无法原子写入工作区数据。',
      ['确认文件未被占用并重试。'],
      'STATIC_LOCAL',
      error,
    );
  }
}

export async function atomicWriteText(io: FileIO, target: string, content: string): Promise<void> {
  const directory = dirname(target);
  await io.mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: WritableFile | undefined;
  try {
    handle = await io.open(temporaryPath, 'wx');
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(io, temporaryPath, target);
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary write error.
      }
    }
    try {
      await removeTemporaryFile(io, temporaryPath);
    } catch {
      // Preserve the primary write error.
    }
    if (error instanceof ProductError) throw error;
    throw new ProductError(
      'ATOMIC_WRITE_FAILED',
      '无法原子写入工作区文件。',
      ['确认文件未被占用并重试。'],
      'STATIC_LOCAL',
      error,
    );
  }
}

export async function readJsonValidated<T>(
  io: FileIO,
  target: string,
  validate: (value: unknown) => asserts value is T,
): Promise<T> {
  try {
    const value: unknown = JSON.parse(await io.readFile(target, 'utf8'));
    validate(value);
    return value;
  } catch (error) {
    throw validationError('JSON 文件损坏或不符合 Schema。', error);
  }
}
