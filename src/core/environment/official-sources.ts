import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { enumerateInstalledExtensions } from '../../integrations/official/api-index-loader.js';
import { discoverOfficialApiSource } from '../../integrations/official/api-source.js';

export interface OfficialSourceIndexOptions {
  extensionsRoot?: string | null;
  officialExtensionPath?: string | null;
  gameInstallPath?: string | null;
  ugcDataPath?: string | null;
}

export interface OfficialExtensionSourceIndex {
  state: 'selected' | 'missing' | 'ambiguous' | 'invalid' | 'not-configured';
  id: string | null;
  version: string | null;
  declarationCount: number;
  hasEventsDeclaration: boolean;
  commands: string[];
}

export interface OfficialGameSourceIndex {
  state: 'indexed' | 'missing' | 'invalid' | 'not-configured';
  version: string | null;
  versionSource: string | null;
  staticConfig: {
    fileCount: number;
    archiveCount: number;
    names: string[];
  };
}

export interface OfficialUgcSourceIndex {
  state: 'indexed' | 'missing' | 'invalid' | 'not-configured';
  projectRecordCount: number | null;
  usedBlockKeys: string[];
  scriptArchiveCount: number;
}

export interface OfficialSourceIndex {
  schemaVersion: 1;
  extension: OfficialExtensionSourceIndex;
  game: OfficialGameSourceIndex;
  ugc: OfficialUgcSourceIndex;
  warnings: string[];
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_STATIC_NAMES = 256;
const MAX_UGC_SCAN_ENTRIES = 2_000;
const VERSION_FILES = [
  'LetsGo/Content/Flag/versionJson.json',
  'Content/Flag/versionJson.json',
  'versionJson.json',
] as const;
const STATIC_DIRECTORIES = [
  'PersistentDownloadDir',
  'LetsGo/GameData/Saved/PersistentDownloadDir',
  'LetsGo/Content/PersistentDownloadDir',
  'Content/PersistentDownloadDir',
] as const;
const UGC_FILE_NAMES = ['UGCPDeviceInfo.json', 'UGCScriptProjectInfo.ini'] as const;
const STATIC_EXTENSIONS = new Set(['.zip', '.pbin', '.ldata', '.db']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notConfiguredExtension(): OfficialExtensionSourceIndex {
  return { state: 'not-configured', id: null, version: null, declarationCount: 0, hasEventsDeclaration: false, commands: [] };
}

function contributedCommands(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.contributes) || !Array.isArray(value.contributes.commands)) return [];
  return value.contributes.commands
    .map((entry) => isRecord(entry) && typeof entry.command === 'string' ? entry.command : null)
    .filter((entry): entry is string => entry !== null && entry.length <= 128)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

async function existingDirectory(path: string | null | undefined): Promise<string | null> {
  if (path === undefined || path === null || path.trim() === '') return null;
  try {
    return (await stat(path)).isDirectory() ? path : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function inspectExtension(options: OfficialSourceIndexOptions): Promise<OfficialExtensionSourceIndex> {
  const extensionsRoot = await existingDirectory(options.extensionsRoot);
  if (extensionsRoot === null) return notConfiguredExtension();
  try {
    const extensions = await enumerateInstalledExtensions(extensionsRoot);
    const selection = await discoverOfficialApiSource(extensions, options.officialExtensionPath?.trim() || null);
    if (selection.state === 'missing') return { state: 'missing', id: null, version: null, declarationCount: 0, hasEventsDeclaration: false, commands: [] };
    if (selection.state === 'ambiguous') return { state: 'ambiguous', id: null, version: null, declarationCount: selection.candidates.reduce((total, candidate) => total + candidate.declarationCount, 0), hasEventsDeclaration: false, commands: [] };
    const selected = extensions.find((extension) => extension.id === selection.extensionId);
    return {
      state: 'selected',
      id: selection.extensionId,
      version: selection.officialExtensionVersion,
      declarationCount: selection.declarationCount,
      hasEventsDeclaration: selection.declarationPaths.some((path) => path.endsWith('/Events.d.lua')),
      commands: contributedCommands(selected?.packageJSON),
    };
  } catch {
    return { state: 'invalid', id: null, version: null, declarationCount: 0, hasEventsDeclaration: false, commands: [] };
  }
}

async function readSmallText(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_TEXT_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function versionFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ['version', 'Version', 'clientVersion', 'gameVersion', 'versionName']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate.length <= 128) return candidate.trim();
  }
  return null;
}

interface StaticInventory {
  fileCount: number;
  archiveCount: number;
  names: Set<string>;
}

async function collectStaticNames(directory: string, depth: number, inventory: StaticInventory, visited: { count: number }): Promise<void> {
  if (depth < 0 || visited.count >= MAX_UGC_SCAN_ENTRIES) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (visited.count >= MAX_UGC_SCAN_ENTRIES) return;
    visited.count += 1;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectStaticNames(path, depth - 1, inventory, visited);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (!STATIC_EXTENSIONS.has(extension)) continue;
    inventory.fileCount += 1;
    if (extension === '.zip') inventory.archiveCount += 1;
    if (inventory.names.size < MAX_STATIC_NAMES) inventory.names.add(basename(entry.name));
  }
}

async function inspectGame(gameInstallPath: string | null | undefined): Promise<{ value: OfficialGameSourceIndex; warnings: string[] }> {
  const root = await existingDirectory(gameInstallPath);
  if (gameInstallPath === undefined || gameInstallPath === null || gameInstallPath.trim() === '') {
    return {
      value: { state: 'not-configured', version: null, versionSource: null, staticConfig: { fileCount: 0, archiveCount: 0, names: [] } },
      warnings: [],
    };
  }
  if (root === null) {
    return {
      value: { state: 'invalid', version: null, versionSource: null, staticConfig: { fileCount: 0, archiveCount: 0, names: [] } },
      warnings: ['配置的元梦游戏目录不存在或不是目录。'],
    };
  }

  let version: string | null = null;
  let versionSource: string | null = null;
  for (const relativePath of VERSION_FILES) {
    const source = await readSmallText(join(root, ...relativePath.split('/')));
    if (source === null) continue;
    try {
      version = versionFrom(JSON.parse(source) as unknown);
      if (version !== null) {
        versionSource = relativePath;
        break;
      }
    } catch {
      // Try the next known version path; malformed files are reported below.
    }
  }

  const inventory: StaticInventory = { fileCount: 0, archiveCount: 0, names: new Set<string>() };
  const visited = { count: 0 };
  for (const relativePath of STATIC_DIRECTORIES) {
    await collectStaticNames(join(root, ...relativePath.split('/')), 2, inventory, visited);
  }
  const orderedNames = [...inventory.names].sort((left, right) => left.localeCompare(right, 'en'));
  return {
    value: {
      state: 'indexed',
      version,
      versionSource,
      staticConfig: {
        fileCount: inventory.fileCount,
        archiveCount: inventory.archiveCount,
        names: orderedNames,
      },
    },
    warnings: version === null ? ['已读取配置目录，但未在有限候选路径中找到可识别版本文本。'] : [],
  };
}

async function knownUgcFiles(root: string): Promise<{ jsonPath: string | null; iniPath: string | null; scriptArchiveCount: number }> {
  const candidates: string[] = [root];
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch {
    return { jsonPath: null, iniPath: null, scriptArchiveCount: 0 };
  }
  for (const child of children.filter((entry) => entry.isDirectory()).slice(0, 64)) candidates.push(join(root, child.name));
  let jsonPath: string | null = null;
  let iniPath: string | null = null;
  let scriptArchiveCount = 0;
  for (const directory of candidates) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === UGC_FILE_NAMES[0]) jsonPath ??= join(directory, entry.name);
      if (entry.name === UGC_FILE_NAMES[1]) iniPath ??= join(directory, entry.name);
      if (/^script[^/]*\.zip$/iu.test(entry.name)) scriptArchiveCount += 1;
    }
  }
  return { jsonPath, iniPath, scriptArchiveCount };
}

async function inspectUgc(ugcDataPath: string | null | undefined): Promise<{ value: OfficialUgcSourceIndex; warnings: string[] }> {
  if (ugcDataPath === undefined || ugcDataPath === null || ugcDataPath.trim() === '') {
    return { value: { state: 'not-configured', projectRecordCount: null, usedBlockKeys: [], scriptArchiveCount: 0 }, warnings: [] };
  }
  const root = await existingDirectory(ugcDataPath);
  if (root === null) {
    return { value: { state: 'invalid', projectRecordCount: null, usedBlockKeys: [], scriptArchiveCount: 0 }, warnings: ['配置的 UGC 数据目录不存在或不是目录。'] };
  }
  const files = await knownUgcFiles(root);
  if (files.jsonPath === null && files.iniPath === null) {
    return { value: { state: 'missing', projectRecordCount: null, usedBlockKeys: [], scriptArchiveCount: files.scriptArchiveCount }, warnings: ['UGC 目录中没有找到受支持的使用台账文件。'] };
  }
  const warnings: string[] = [];
  let usedBlockKeys: string[] = [];
  let projectRecordCount: number | null = null;
  let invalid = false;
  if (files.jsonPath !== null) {
    const source = await readSmallText(files.jsonPath);
    try {
      const value = source === null ? null : JSON.parse(source) as unknown;
      if (!isRecord(value)) throw new Error('invalid');
      usedBlockKeys = Object.keys(value)
        .flatMap((key) => {
          const match = /^undefined_BLOCK_USED_(.+)$/u.exec(key);
          return match === null ? [] : [match[1]!];
        })
        .sort((left, right) => left.localeCompare(right, 'en'))
        .slice(0, 100);
    } catch {
      invalid = true;
      warnings.push('UGCPDeviceInfo.json 不是可解析的 JSON。');
    }
  }
  if (files.iniPath !== null) {
    const source = await readSmallText(files.iniPath);
    if (source === null) {
      invalid = true;
      warnings.push('UGCScriptProjectInfo.ini 无法读取或超过大小上限。');
    } else {
      projectRecordCount = [...source.matchAll(/^\s*\[[^\]\r\n]+\]\s*$/gmu)].length;
    }
  }
  return {
    value: { state: invalid ? 'invalid' : 'indexed', projectRecordCount, usedBlockKeys, scriptArchiveCount: files.scriptArchiveCount },
    warnings,
  };
}

export async function inspectOfficialSources(options: OfficialSourceIndexOptions = {}): Promise<OfficialSourceIndex> {
  const effectiveOptions: OfficialSourceIndexOptions = options.extensionsRoot === undefined
    ? {
      ...options,
      extensionsRoot: process.env.VSCODE_EXTENSIONS
        ?? (process.env.USERPROFILE === undefined ? null : join(process.env.USERPROFILE, '.vscode', 'extensions')),
    }
    : options;
  const [extension, game, ugc] = await Promise.all([
    inspectExtension(effectiveOptions),
    inspectGame(effectiveOptions.gameInstallPath),
    inspectUgc(effectiveOptions.ugcDataPath),
  ]);
  return {
    schemaVersion: 1,
    extension,
    game: game.value,
    ugc: ugc.value,
    warnings: [...game.warnings, ...ugc.warnings],
  };
}
