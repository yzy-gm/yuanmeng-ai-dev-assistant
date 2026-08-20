import { ProductError } from '../../core/errors.js';
import type { FileIO } from '../../core/fs.js';
import { sha256Hex } from '../../core/hash.js';
import { decodeLuaUtf8 } from '../../core/lua/literal-parser.js';

export const DEFAULT_STABLE_EXPORT_OPTIONS = Object.freeze({
  sampleMilliseconds: 150,
  stableSampleCount: 3,
  splitCollectionMilliseconds: 2_000,
  totalTimeoutMilliseconds: 15_000,
});

export interface StableExportFile {
  path: string;
  content: string;
  sha256: string;
}

export interface StableExportResult {
  files: StableExportFile[];
  elapsedMilliseconds: number;
  collectedAllPaths: boolean;
  reasonCode: 'REFRESH_SUCCEEDED' | 'REFRESH_SUCCEEDED_UNCHANGED';
  observedSignatureChange: boolean;
}

export interface WaitForStableExportOptions {
  io: FileIO;
  paths: readonly string[];
  baselineHashes: Readonly<Record<string, string | null>>;
  baselineSignatures?: Readonly<Record<string, string | null>>;
  acceptUnchangedStableFiles?: boolean;
  sampleMilliseconds?: number;
  stableSampleCount?: number;
  splitCollectionMilliseconds?: number;
  totalTimeoutMilliseconds?: number;
  validateContent?: (path: string, content: string) => void;
}

interface SampleState {
  signature: string;
  equalSamples: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sampleSignature(io: FileIO, path: string): Promise<string | null> {
  try {
    const value = await io.stat(path);
    return value.isFile() ? `${value.size}:${value.mtimeMs}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProductError('VALIDATION_FAILED', `${name} 必须是正整数。`, ['检查文件监听设置。'], 'STATIC_LOCAL');
  }
  return value;
}

export async function waitForStableExport(options: WaitForStableExportOptions): Promise<StableExportResult> {
  const sampleMilliseconds = positiveInteger(
    options.sampleMilliseconds ?? DEFAULT_STABLE_EXPORT_OPTIONS.sampleMilliseconds,
    'sampleMilliseconds',
  );
  const stableSampleCount = positiveInteger(
    options.stableSampleCount ?? DEFAULT_STABLE_EXPORT_OPTIONS.stableSampleCount,
    'stableSampleCount',
  );
  const splitCollectionMilliseconds = positiveInteger(
    options.splitCollectionMilliseconds ?? DEFAULT_STABLE_EXPORT_OPTIONS.splitCollectionMilliseconds,
    'splitCollectionMilliseconds',
  );
  const totalTimeoutMilliseconds = positiveInteger(
    options.totalTimeoutMilliseconds ?? DEFAULT_STABLE_EXPORT_OPTIONS.totalTimeoutMilliseconds,
    'totalTimeoutMilliseconds',
  );
  const startedAt = Date.now();
  const samples = new Map<string, SampleState>();
  const accepted = new Map<string, StableExportFile>();
  let firstAcceptedAt: number | null = null;
  let observedContentChange = false;
  let observedSignatureChange = false;

  while (Date.now() - startedAt <= totalTimeoutMilliseconds) {
    for (const path of options.paths) {
      if (accepted.has(path)) {
        continue;
      }
      const signature = await sampleSignature(options.io, path);
      if (signature === null) {
        samples.delete(path);
        continue;
      }
      const previous = samples.get(path);
      const current: SampleState = previous?.signature === signature
        ? { signature, equalSamples: previous.equalSamples + 1 }
        : { signature, equalSamples: 1 };
      samples.set(path, current);
      if (current.equalSamples < stableSampleCount) {
        continue;
      }
      const bytes = await options.io.readBytes(path);
      const content = decodeLuaUtf8(bytes);
      const hash = sha256Hex(bytes);
      const afterReadSignature = await sampleSignature(options.io, path);
      if (afterReadSignature !== signature) {
        samples.set(path, { signature: afterReadSignature ?? '', equalSamples: 0 });
        continue;
      }
      options.validateContent?.(path, content);
      const baselineHash = options.baselineHashes[path] ?? null;
      const contentChanged = hash !== baselineHash;
      if (contentChanged) {
        observedContentChange = true;
      }
      if (!contentChanged && options.acceptUnchangedStableFiles !== true) {
        continue;
      }
      const hasBaselineSignature = options.baselineSignatures !== undefined
        && Object.prototype.hasOwnProperty.call(options.baselineSignatures, path);
      if (hasBaselineSignature && afterReadSignature !== (options.baselineSignatures?.[path] ?? null)) {
        observedSignatureChange = true;
      }
      accepted.set(path, { path, content, sha256: hash });
      firstAcceptedAt ??= Date.now();
    }

    if (accepted.size === options.paths.length) {
      break;
    }
    if (firstAcceptedAt !== null && Date.now() - firstAcceptedAt >= splitCollectionMilliseconds) {
      break;
    }
    await delay(sampleMilliseconds);
  }

  if (accepted.size === 0) {
    throw new ProductError(
      'EXPORT_TIMEOUT',
      '等待官方“获取自定义界面结构”更新超时。',
      ['确认当前工程已激活且官方联动在线，并检查 CustomUIData.lua/CustomUIData2.lua 是否存在后重试。'],
      'UNIT_E2E',
    );
  }
  return {
    files: options.paths.flatMap((path) => {
      const value = accepted.get(path);
      return value === undefined ? [] : [value];
    }),
    elapsedMilliseconds: Date.now() - startedAt,
    collectedAllPaths: accepted.size === options.paths.length,
    reasonCode: observedContentChange ? 'REFRESH_SUCCEEDED' : 'REFRESH_SUCCEEDED_UNCHANGED',
    observedSignatureChange,
  };
}
