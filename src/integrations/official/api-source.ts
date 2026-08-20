import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { ProductError } from '../../core/errors.js';

export interface InstalledExtensionRecord {
  id: string;
  extensionPath: string;
  packageJSON: unknown;
}

interface ApiSourceSummary {
  extensionId: string;
  officialExtensionVersion: string;
  declarationCount: number;
}

export type OfficialApiSource =
  | { state: 'missing' }
  | { state: 'ambiguous'; candidates: ApiSourceSummary[] }
  | (ApiSourceSummary & {
    state: 'selected';
    extensionRoot: string;
    declarationPaths: string[];
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contributesOfficialCommand(packageJSON: unknown): boolean {
  if (!isRecord(packageJSON) || !isRecord(packageJSON.contributes) || !Array.isArray(packageJSON.contributes.commands)) {
    return false;
  }
  return packageJSON.contributes.commands.some((command) => (
    isRecord(command) && command.command === 'dreamhelper.GetCustomUIData'
  ));
}

async function candidate(extension: InstalledExtensionRecord): Promise<(ApiSourceSummary & {
  extensionRoot: string;
  declarationPaths: string[];
}) | null> {
  if (!contributesOfficialCommand(extension.packageJSON) || !isRecord(extension.packageJSON)) {
    return null;
  }
  const version = extension.packageJSON.version;
  if (typeof version !== 'string' || version.trim() === '') {
    return null;
  }
  let root: string;
  let entries;
  try {
    root = await realpath(extension.extensionPath);
    entries = await readdir(join(root, 'res', 'lib'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const declarationPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.d.lua'))
    .map((entry) => `res/lib/${entry.name}`)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (declarationPaths.length === 0) return null;
  return {
    extensionId: extension.id,
    officialExtensionVersion: version,
    declarationCount: declarationPaths.length,
    extensionRoot: root,
    declarationPaths,
  };
}

function invalidOverride(): never {
  throw new ProductError(
    'VALIDATION_FAILED',
    '指定的官方扩展路径不是当前检测到的命令提供者。',
    ['清除覆盖路径，或选择贡献 dreamhelper.GetCustomUIData 的扩展目录。'],
    'STATIC_LOCAL',
  );
}

export async function discoverOfficialApiSource(
  extensions: readonly InstalledExtensionRecord[],
  overridePath: string | null,
): Promise<OfficialApiSource> {
  const matches = (await Promise.all(extensions.map(candidate)))
    .filter((value): value is NonNullable<Awaited<ReturnType<typeof candidate>>> => value !== null)
    .sort((left, right) => left.extensionId.localeCompare(right.extensionId, 'en'));
  if (overridePath !== null) {
    let overrideRoot: string;
    try {
      overrideRoot = await realpath(overridePath);
    } catch {
      invalidOverride();
    }
    const selected = matches.find((value) => value.extensionRoot.toLocaleLowerCase() === overrideRoot.toLocaleLowerCase());
    if (selected === undefined) invalidOverride();
    return { state: 'selected', ...selected };
  }
  if (matches.length === 0) return { state: 'missing' };
  if (matches.length > 1) {
    return {
      state: 'ambiguous',
      candidates: matches.map(({ extensionId, officialExtensionVersion, declarationCount }) => ({
        extensionId,
        officialExtensionVersion,
        declarationCount,
      })),
    };
  }
  return { state: 'selected', ...matches[0]! };
}
