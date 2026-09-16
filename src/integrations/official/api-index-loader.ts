import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildApiIndex, parseDeclarationFile, type ApiIndex } from '../../core/api/declaration-index.js';
import { ProductError } from '../../core/errors.js';
import { discoverOfficialApiSource, type InstalledExtensionRecord } from './api-source.js';

const MAX_DECLARATION_FILES = 1_000;
const MAX_DECLARATION_BYTES = 4 * 1024 * 1024;

export async function enumerateInstalledExtensions(root: string): Promise<InstalledExtensionRecord[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const extensions: InstalledExtensionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extensionPath = join(root, entry.name);
    let packageJSON: unknown;
    try {
      packageJSON = JSON.parse(await readFile(join(extensionPath, 'package.json'), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    const manifest = typeof packageJSON === 'object' && packageJSON !== null && !Array.isArray(packageJSON)
      ? packageJSON as Record<string, unknown>
      : {};
    const id = typeof manifest.publisher === 'string' && typeof manifest.name === 'string'
      ? `${manifest.publisher}.${manifest.name}`
      : entry.name;
    extensions.push({ id, extensionPath, packageJSON });
  }
  return extensions;
}

export async function loadOfficialApiIndexFromExtensions(
  extensions: readonly InstalledExtensionRecord[],
  overridePath: string | null,
): Promise<ApiIndex> {
  const selection = await discoverOfficialApiSource(extensions, overridePath);
  if (selection.state === 'missing') {
    throw new ProductError('OFFLINE', '未检测到同时提供官方 UI 命令与 res/lib 声明的扩展。', ['安装或启用官方扩展后重试。'], 'STATIC_LOCAL');
  }
  if (selection.state === 'ambiguous') {
    throw new ProductError('VALIDATION_FAILED', '检测到多个官方命令提供者，拒绝猜测 API 来源。', ['通过 YMAI_OFFICIAL_EXTENSION_PATH 选择已检测到的扩展目录。'], 'STATIC_LOCAL');
  }
  if (selection.declarationPaths.length > MAX_DECLARATION_FILES) {
    throw new ProductError('VALIDATION_FAILED', '官方 API 声明文件数量超过安全上限。', ['检查官方扩展内容。'], 'STATIC_LOCAL');
  }
  const parsed = await Promise.all(selection.declarationPaths.map(async (relativePath) => {
    const source = await readFile(join(selection.extensionRoot, ...relativePath.split('/')), 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_DECLARATION_BYTES) {
      throw new ProductError('VALIDATION_FAILED', '单个官方 API 声明文件超过安全上限。', ['检查官方扩展内容。'], 'STATIC_LOCAL');
    }
    return parseDeclarationFile({ relativePath, source });
  }));
  return buildApiIndex(parsed, { officialExtensionVersion: selection.officialExtensionVersion });
}

export async function loadOfficialApiIndexFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ApiIndex> {
  const userProfile = environment.USERPROFILE;
  const extensionsRoot = environment.VSCODE_EXTENSIONS
    ?? (userProfile === undefined ? '' : join(userProfile, '.vscode', 'extensions'));
  if (extensionsRoot === '') {
    throw new ProductError('OFFLINE', '无法定位本机 VSCode 扩展目录。', ['安装或启用官方扩展后重试。'], 'STATIC_LOCAL');
  }
  return loadOfficialApiIndexFromExtensions(
    await enumerateInstalledExtensions(extensionsRoot),
    environment.YMAI_OFFICIAL_EXTENSION_PATH?.trim() || null,
  );
}
