import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ProductError } from '../errors.js';
import { sha256Hex } from '../hash.js';

export interface BlockApiEntry {
  category: string;
  name: string;
  service: string;
  method: string;
  params: string;
  description: string;
}

export interface BlockApiCatalog {
  schemaVersion: 1;
  state: 'selected' | 'missing' | 'ambiguous' | 'invalid';
  extensionId: string | null;
  extensionVersion: string | null;
  source: { relativePath: 'api.json'; sha256: string } | null;
  entries: BlockApiEntry[];
  categories: string[];
  warnings: string[];
}

export interface BlockToolboxEntry {
  kind: 'event' | 'value' | 'binding';
  symbol: string;
  relativePath: string;
}

export interface BlockToolboxCatalog {
  schemaVersion: 1;
  state: 'selected' | 'missing' | 'ambiguous' | 'invalid';
  extensionId: string | null;
  extensionVersion: string | null;
  source: { sha256: string; files: number } | null;
  entries: BlockToolboxEntry[];
  warnings: string[];
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_TOOLBOX_FILES = 96;
const MAX_TOOLBOX_FILE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = 512, nullable = false): string {
  if (nullable && (value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value.length > max) {
    throw new ProductError('VALIDATION_FAILED', `编程元件 API 目录字段 ${field} 无效。`, ['检查 DreamCode api.json 的格式。'], 'STATIC_LOCAL');
  }
  return value.trim();
}

function parseEntries(value: unknown): BlockApiEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new ProductError('VALIDATION_FAILED', '编程元件 API 目录必须是有限数组。', ['检查 DreamCode api.json 的格式。'], 'STATIC_LOCAL');
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw new ProductError('VALIDATION_FAILED', '编程元件 API 目录包含无效条目。', ['检查 DreamCode api.json 的格式。'], 'STATIC_LOCAL');
    return {
      category: text(entry.category, 'category', 128),
      name: text(entry.name, 'name', 256),
      service: text(entry.service, 'service', 128),
      method: text(entry.method, 'method', 512),
      params: text(entry.params, 'params', 512, true),
      description: text(entry.desc, 'desc', 1_024, true),
    };
  }).sort((left, right) => `${left.category}\0${left.name}\0${left.method}`.localeCompare(`${right.category}\0${right.name}\0${right.method}`, 'zh-CN'));
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function candidatePaths(root: string): Promise<string[]> {
  if (!(await isDirectory(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^antoniozhou\.dreamcode(?:-|$)/u.test(entry.name))
    .map((entry) => join(root, entry.name, 'api.json'));
}

async function extensionCandidates(root: string): Promise<string[]> {
  if (!(await isDirectory(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^antoniozhou\.dreamcode(?:-|$)/u.test(entry.name))
    .map((entry) => join(root, entry.name));
}

async function collectToolboxFiles(directory: string, depth: number, output: string[]): Promise<void> {
  if (depth < 0 || output.length >= MAX_TOOLBOX_FILES) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (output.length >= MAX_TOOLBOX_FILES) return;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectToolboxFiles(path, depth - 1, output);
      continue;
    }
    if (entry.isFile() && /(?:toolbox|simple-toolbox).*\.js$/iu.test(entry.name)) output.push(path);
  }
}

function toolboxSymbols(source: string, relativePath: string): BlockToolboxEntry[] {
  const entries: BlockToolboxEntry[] = [];
  const seen = new Set<string>();
  const pattern = /\b(Event_[A-Za-z0-9_]+|GetValue_[A-Za-z0-9_]+|BIND_[A-Za-z0-9_]+)\b/gu;
  for (const match of source.matchAll(pattern)) {
    const symbol = match[1]!;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const kind = symbol.startsWith('Event_') ? 'event' : symbol.startsWith('BIND_') ? 'binding' : 'value';
    entries.push({ kind, symbol, relativePath });
  }
  return entries;
}

export async function loadDreamCodeToolboxCatalog(options: {
  extensionPath?: string | null;
  extensionsRoot?: string | null;
} = {}): Promise<BlockToolboxCatalog> {
  const explicit = options.extensionPath?.trim() || null;
  const paths = explicit === null
    ? await extensionCandidates(options.extensionsRoot ?? join(process.env.USERPROFILE ?? '', '.vscode', 'extensions'))
    : [explicit];
  if (paths.length === 0) return {
    schemaVersion: 1, state: 'missing', extensionId: null, extensionVersion: null, source: null, entries: [],
    warnings: ['未检测到 DreamCode 工具箱脚本。'],
  };
  if (paths.length > 1 && explicit === null) return {
    schemaVersion: 1, state: 'ambiguous', extensionId: null, extensionVersion: null, source: null, entries: [],
    warnings: ['检测到多个 DreamCode 工具箱版本，拒绝猜测版本。'],
  };
  const extensionRoot = paths[0]!;
  try {
    const files: string[] = [];
    await collectToolboxFiles(extensionRoot, 3, files);
    const entries: BlockToolboxEntry[] = [];
    const sourceParts: string[] = [];
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > MAX_TOOLBOX_FILE_BYTES) continue;
      const relativePath = path.slice(extensionRoot.length + 1).replace(/\\/gu, '/');
      sourceParts.push(`${relativePath}\0${source}`);
      entries.push(...toolboxSymbols(source, relativePath));
    }
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8')) as unknown;
    const extensionVersion = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : null;
    const unique = [...new Map(entries.map((entry) => [`${entry.kind}\0${entry.symbol}`, entry])).values()]
      .sort((left, right) => `${left.kind}\0${left.symbol}`.localeCompare(`${right.kind}\0${right.symbol}`, 'en'));
    return {
      schemaVersion: 1,
      state: 'selected',
      extensionId: 'antoniozhou.dreamcode',
      extensionVersion,
      source: { sha256: sha256Hex(sourceParts.sort().join('\n')), files: files.length },
      entries: unique.slice(0, 2_000),
      warnings: [
        '工具箱目录来自 DreamCode 静态脚本字面量；它证明官方工具箱符号，不证明当前地图已连接这些积木。',
        ...(files.length >= MAX_TOOLBOX_FILES ? ['工具箱脚本文件达到扫描上限，目录可能不完整。'] : []),
      ],
    };
  } catch {
    return {
      schemaVersion: 1, state: 'invalid', extensionId: 'antoniozhou.dreamcode', extensionVersion: null,
      source: null, entries: [], warnings: ['DreamCode 工具箱脚本无法解析。'],
    };
  }
}

export async function loadDreamCodeApiCatalog(options: {
  extensionPath?: string | null;
  extensionsRoot?: string | null;
} = {}): Promise<BlockApiCatalog> {
  const explicit = options.extensionPath?.trim() || null;
  let paths: string[] = [];
  if (explicit !== null) paths = [join(explicit, 'api.json')];
  else if (options.extensionsRoot !== null) {
    paths = await candidatePaths(options.extensionsRoot ?? join(process.env.USERPROFILE ?? '', '.vscode', 'extensions'));
  }
  if (paths.length === 0) return { schemaVersion: 1, state: 'missing', extensionId: null, extensionVersion: null, source: null, entries: [], categories: [], warnings: ['未检测到 DreamCode api.json。'] };
  if (paths.length > 1 && explicit === null) return { schemaVersion: 1, state: 'ambiguous', extensionId: null, extensionVersion: null, source: null, entries: [], categories: [], warnings: ['检测到多个 DreamCode api.json，拒绝猜测版本。'] };
  const path = paths[0]!;
  try {
    const source = await readFile(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) throw new ProductError('VALIDATION_FAILED', 'DreamCode api.json 超过大小上限。', ['检查编程元件扩展文件。'], 'STATIC_LOCAL');
    const entries = parseEntries(JSON.parse(source) as unknown);
    const extensionRoot = path.replace(/[\\/]api\.json$/u, '');
    let extensionVersion: string | null = null;
    try {
      const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8')) as unknown;
      extensionVersion = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : null;
    } catch { /* api.json remains useful without package metadata */ }
    return {
      schemaVersion: 1,
      state: 'selected',
      extensionId: 'antoniozhou.dreamcode',
      extensionVersion,
      source: { relativePath: 'api.json', sha256: sha256Hex(source) },
      entries,
      categories: [...new Set(entries.map((entry) => entry.category))].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      warnings: ['目录来自编程元件扩展；它证明 API 目录条目，不证明当前地图存在完整积木连接图。'],
    };
  } catch (error) {
    if (error instanceof ProductError) throw error;
    return { schemaVersion: 1, state: 'invalid', extensionId: 'antoniozhou.dreamcode', extensionVersion: null, source: null, entries: [], categories: [], warnings: ['DreamCode api.json 无法解析。'] };
  }
}

export function searchBlockApiCatalog(catalog: BlockApiCatalog, query: string, limit = 200): BlockApiEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [];
  return catalog.entries.filter((entry) => [entry.category, entry.name, entry.service, entry.method, entry.params, entry.description]
    .join('\n').toLocaleLowerCase().includes(needle)).slice(0, limit);
}
