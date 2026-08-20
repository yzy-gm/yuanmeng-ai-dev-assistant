import { ProductError } from '../errors.js';

export const EXTENSION_ID = 'bujianxingguang.yuanmeng-ai-dev-assistant' as const;

export interface CliLauncherManifest {
  schemaVersion: 1;
  extensionId: typeof EXTENSION_ID;
  extensionVersion: string;
  extensionRootHash: string;
  cliPath: string;
  cliSha256: string;
  projectInstanceId: string;
  projectRootHash: string;
  generatedAt: string;
}

export interface LauncherInvocation {
  extensionId: string;
  extensionVersion: string;
  extensionRootHash: string;
  cliPath: string;
  cliSha256: string;
  projectInstanceId: string;
  projectRootHash: string;
}

export interface LauncherBinding {
  cliPath: string;
  projectInstanceId: string;
  projectRootHash: string;
}

const MANIFEST_KEYS = [
  'schemaVersion',
  'extensionId',
  'extensionVersion',
  'extensionRootHash',
  'cliPath',
  'cliSha256',
  'projectInstanceId',
  'projectRootHash',
  'generatedAt',
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function fail(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['重新初始化当前工程的 CLI 启动器。'], 'STATIC_LOCAL');
}

export function validateCliLauncherManifest(value: unknown): asserts value is CliLauncherManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('CLI 启动器清单必须是对象。');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...MANIFEST_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('CLI 启动器清单字段不完整或包含未知字段。');
  }
  if (record.schemaVersion !== 1 || record.extensionId !== EXTENSION_ID) {
    fail('CLI 启动器清单版本或扩展身份无效。');
  }
  for (const key of ['extensionVersion', 'cliPath'] as const) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      fail(`CLI 启动器字段 ${key} 无效。`);
    }
  }
  for (const key of ['extensionRootHash', 'cliSha256', 'projectRootHash'] as const) {
    if (typeof record[key] !== 'string' || !SHA256_PATTERN.test(record[key])) {
      fail(`CLI 启动器字段 ${key} 必须是 SHA-256。`);
    }
  }
  if (typeof record.projectInstanceId !== 'string' || !UUID_PATTERN.test(record.projectInstanceId)) {
    fail('CLI 启动器工程身份无效。');
  }
  if (
    typeof record.generatedAt !== 'string'
    || !record.generatedAt.endsWith('Z')
    || !Number.isFinite(Date.parse(record.generatedAt))
  ) {
    fail('CLI 启动器生成时间无效。');
  }
}

export function validateLauncherBinding(
  manifest: CliLauncherManifest,
  invocation: LauncherInvocation,
): LauncherBinding {
  validateCliLauncherManifest(manifest);
  const fields = [
    'extensionId',
    'extensionVersion',
    'extensionRootHash',
    'cliPath',
    'cliSha256',
    'projectInstanceId',
    'projectRootHash',
  ] as const;
  for (const field of fields) {
    if (manifest[field] !== invocation[field]) {
      fail(`CLI 启动器绑定不匹配：${field}。`);
    }
  }
  return {
    cliPath: manifest.cliPath,
    projectInstanceId: manifest.projectInstanceId,
    projectRootHash: manifest.projectRootHash,
  };
}
