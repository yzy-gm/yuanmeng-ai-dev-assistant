import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { loadDreamCodeToolboxCatalog, type BlockToolboxCatalog } from '../api/block-catalog.js';
import { diffApiIndexes, type ApiIndex } from '../api/declaration-index.js';
import { ProductError } from '../errors.js';
import { atomicWriteJson, nodeFileIO } from '../fs.js';
import { sha256Hex } from '../hash.js';
import { enumerateInstalledExtensions, loadOfficialApiIndexFromExtensions } from '../../integrations/official/api-index-loader.js';
import { discoverOfficialApiSource } from '../../integrations/official/api-source.js';
import { readZipDirectory, readZipEntry } from './zip-reader.js';

const MAX_ARCHIVES = 32;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const TEMPLATE_FILES = [
  'src/.vscode/settings.json',
  'src/Client/GameClient.lua',
  'src/Common/NetMsg.lua',
  'src/GameEntry.lua',
  'src/Server/GameServer.lua',
] as const;

export interface ZipEntrySummary {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface OfficialReverseAudit {
  schemaVersion: 1;
  evidence: 'STATIC_LOCAL';
  officialExtension: {
    state: 'selected' | 'missing' | 'ambiguous' | 'invalid';
    id: string | null;
    version: string | null;
  };
  api: {
    state: 'current' | 'missing' | 'invalid';
    currentVersion: string | null;
    currentCount: number;
    baselineState: 'present' | 'missing' | 'invalid';
    baselineVersion: string | null;
    baselinePath: '.yuanmeng-inspector/official/api-index-baseline.json';
    diff: {
      added: string[];
      removed: string[];
      changed: string[];
      categories: Record<'declarations' | 'constants' | 'enums', {
        added: string[]; removed: string[]; changed: string[];
        totals: { added: number; removed: number; changed: number };
        truncated: boolean;
      }>;
      totals: { added: number; removed: number; changed: number };
      truncated: boolean;
    } | null;
  };
  dreamcode: BlockToolboxCatalog;
  template: {
    state: 'matched' | 'different' | 'partial' | 'missing' | 'invalid' | 'not-configured';
    source: string | null;
    expectedFiles: string[];
    presentFiles: string[];
    missingFiles: string[];
    comparison: 'bytes';
    files: Array<{
      path: string;
      state: 'identical' | 'different' | 'project-missing' | 'template-missing' | 'unreadable';
      templateSha256: string | null;
      projectSha256: string | null;
    }>;
  };
  scripts: {
    state: 'indexed' | 'missing' | 'invalid' | 'not-configured';
    archiveCount: number;
    discoveredArchiveCount: number;
    scannedDirectoryCount: number;
    complete: boolean;
    truncated: boolean;
    skippedCount: number;
    skipped: Array<{ path: string; reason: string }>;
    scope: { maxDepth: number; maxDirectories: number; maxEntries: number; maxArchives: number; maxArchiveBytes: number };
    archives: Array<{
      name: string;
      entryCount: number;
      luaFileCount: number;
      scriptLikeEntries: string[];
      scriptLikeEntryCount: number;
      entriesTruncated: boolean;
      sha256: string;
    }>;
  };
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiIndex(value: unknown): value is ApiIndex {
  return isRecord(value)
    && value.schemaVersion === 2
    && typeof value.officialExtensionVersion === 'string'
    && Array.isArray(value.declarations)
    && Array.isArray(value.constants)
    && Array.isArray(value.enums);
}

export function listZipEntries(bytes: Uint8Array): ZipEntrySummary[] {
  return readZipDirectory(bytes).map(({ name, compressedSize, uncompressedSize }) => ({ name, compressedSize, uncompressedSize }));
}

async function existingDirectory(path: string | null | undefined): Promise<string | null> {
  if (path === undefined || path === null || path.trim() === '') return null;
  try { return (await stat(path)).isDirectory() ? path : null; } catch { return null; }
}

async function inspectTemplate(extensionRoot: string | null, projectRoot: string): Promise<OfficialReverseAudit['template']> {
  const report: OfficialReverseAudit['template'] = {
    state: 'not-configured', source: null, expectedFiles: [...TEMPLATE_FILES], presentFiles: [],
    missingFiles: [...TEMPLATE_FILES], comparison: 'bytes', files: [],
  };
  if (extensionRoot === null) return report;
  const source = join(extensionRoot, 'res', 'template', 'template.zip');
  report.source = 'res/template/template.zip';
  try {
    const bytes = await readBoundedFile(source, MAX_ARCHIVE_BYTES);
    const entries = readZipDirectory(bytes);
    for (const path of TEMPLATE_FILES) {
      const file: OfficialReverseAudit['template']['files'][number] = {
        path, state: 'template-missing', templateSha256: null, projectSha256: null,
      };
      const entry = entries.find((candidate) => candidate.name === path);
      if (entry !== undefined) {
        try {
          const template = readZipEntry(bytes, entry, MAX_TEMPLATE_BYTES);
          file.templateSha256 = sha256Hex(template);
          const project = await readBoundedFile(join(projectRoot, path), MAX_TEMPLATE_BYTES);
          file.projectSha256 = sha256Hex(project);
          file.state = file.templateSha256 === file.projectSha256 ? 'identical' : 'different';
        } catch (error) {
          file.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'project-missing' : 'unreadable';
        }
      }
      report.files.push(file);
    }
    report.presentFiles = report.files.filter((file) => file.projectSha256 !== null).map((file) => file.path);
    report.missingFiles = report.files.filter((file) => file.state === 'project-missing' || file.state === 'template-missing').map((file) => file.path);
    report.state = report.files.some((file) => file.state === 'unreadable') ? 'invalid'
      : report.missingFiles.length === TEMPLATE_FILES.length ? 'missing'
        : report.missingFiles.length > 0 ? 'partial'
          : report.files.some((file) => file.state === 'different') ? 'different' : 'matched';
  } catch {
    report.state = 'invalid';
  }
  return report;
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new Error('file-size-limit');
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (length !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
      throw new Error('file-changed-during-read');
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

async function inspectScripts(rootValue: string | null | undefined): Promise<OfficialReverseAudit['scripts']> {
  const report: OfficialReverseAudit['scripts'] = {
    state: 'not-configured', archiveCount: 0, archives: [], discoveredArchiveCount: 0,
    scannedDirectoryCount: 0, complete: false, truncated: false, skippedCount: 0, skipped: [],
    scope: { maxDepth: 4, maxDirectories: 65, maxEntries: 2_000, maxArchives: MAX_ARCHIVES, maxArchiveBytes: MAX_ARCHIVE_BYTES },
  };
  if (rootValue === undefined || rootValue === null || rootValue.trim() === '') return report;
  const root = await existingDirectory(rootValue);
  if (root === null) return { ...report, state: 'invalid' };
  const skip = (path: string, reason: string, truncated = false) => {
    report.skippedCount += 1;
    report.truncated ||= truncated;
    if (report.skipped.length < 128) report.skipped.push({ path: relative(root, path).replace(/\\/gu, '/') || '.', reason });
  };
  const directories = [{ path: root, depth: 0 }];
  const archives: string[] = [];
  let visitedEntries = 0;
  // Stable breadth-first enumeration within the configured root; never follow links.
  for (const directory of directories) {
    try {
      if (visitedEntries >= report.scope.maxEntries) { skip(directory.path, 'entry-limit', true); continue; }
      const entries = (await readdir(directory.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      report.scannedDirectoryCount += 1;
      for (const entry of entries) {
        if (visitedEntries >= report.scope.maxEntries) { skip(directory.path, 'entry-limit', true); break; }
        visitedEntries += 1;
        const path = join(directory.path, entry.name);
        if (entry.isSymbolicLink()) { skip(path, 'symbolic-link'); continue; }
        if (entry.isDirectory()) {
          if (directory.depth >= report.scope.maxDepth) skip(path, 'depth-limit', true);
          else if (directories.length >= report.scope.maxDirectories) skip(path, 'directory-limit', true);
          else directories.push({ path, depth: directory.depth + 1 });
        } else if (entry.isFile() && /^script[^/]*\.zip$/iu.test(entry.name)) archives.push(path);
      }
    } catch { skip(directory.path, 'directory-unreadable'); }
  }
  report.discoveredArchiveCount = archives.length;
  for (const path of archives.slice(MAX_ARCHIVES)) skip(path, 'archive-limit', true);
  for (const path of archives.slice(0, MAX_ARCHIVES)) {
    try {
      const bytes = await readBoundedFile(path, MAX_ARCHIVE_BYTES);
      const entries = listZipEntries(bytes);
      const scriptLikeEntries = entries.map((entry) => entry.name).filter((name) => /(?:script|\.lua$)/iu.test(name));
      report.archives.push({
        name: relative(root, path).replace(/\\/gu, '/'),
        entryCount: entries.length,
        luaFileCount: entries.filter((entry) => entry.name.toLowerCase().endsWith('.lua')).length,
        scriptLikeEntries: scriptLikeEntries.slice(0, 128),
        scriptLikeEntryCount: scriptLikeEntries.length,
        entriesTruncated: scriptLikeEntries.length > 128,
        sha256: sha256Hex(bytes),
      });
    } catch (error) {
      const reason = error instanceof Error && ['file-size-limit', 'file-changed-during-read'].includes(error.message)
        ? error.message : 'archive-unreadable-or-invalid';
      skip(path, reason);
    }
  }
  report.archiveCount = report.archives.length;
  report.complete = report.skippedCount === 0;
  report.state = report.archiveCount > 0 ? 'indexed' : report.complete ? 'missing' : 'invalid';
  return report;
}

function apiDiffSummary(before: ApiIndex, after: ApiIndex): NonNullable<OfficialReverseAudit['api']['diff']> {
  const diff = diffApiIndexes(before, after);
  const summarize = (source: { added: { key: string }[]; removed: { key: string }[]; changed: { key: string }[] }) => ({
    added: source.added.map((entry) => entry.key).slice(0, 500),
    removed: source.removed.map((entry) => entry.key).slice(0, 500),
    changed: source.changed.map((entry) => entry.key).slice(0, 500),
    totals: { added: source.added.length, removed: source.removed.length, changed: source.changed.length },
    truncated: [source.added, source.removed, source.changed].some((entries) => entries.length > 500),
  });
  const combined = summarize({
    added: [...diff.added, ...diff.constants.added, ...diff.enums.added],
    removed: [...diff.removed, ...diff.constants.removed, ...diff.enums.removed],
    changed: [...diff.changed, ...diff.constants.changed, ...diff.enums.changed],
  });
  return {
    ...combined,
    categories: { declarations: summarize(diff), constants: summarize(diff.constants), enums: summarize(diff.enums) },
  };
}

export async function saveOfficialApiBaseline(projectRoot: string, index: ApiIndex): Promise<void> {
  await atomicWriteJson(nodeFileIO, join(projectRoot, '.yuanmeng-inspector', 'official', 'api-index-baseline.json'), index, (value): asserts value is ApiIndex => {
    if (!isApiIndex(value)) throw new ProductError('VALIDATION_FAILED', '官方 API 基线无效。', ['重新读取官方 API 后重试。'], 'STATIC_LOCAL');
  });
}

export async function runOfficialReverseAudit(input: {
  projectRoot: string;
  extensionsRoot?: string | null;
  officialExtensionPath?: string | null;
  dreamCodeExtensionPath?: string | null;
  ugcDataPath?: string | null;
}): Promise<{ report: OfficialReverseAudit; currentApi: ApiIndex | null }> {
  const extensionsRoot = input.extensionsRoot ?? join(process.env.USERPROFILE ?? '', '.vscode', 'extensions');
  const extensions = await enumerateInstalledExtensions(extensionsRoot);
  const selection = await discoverOfficialApiSource(extensions, input.officialExtensionPath?.trim() || null);
  const currentApi = selection.state === 'selected'
    ? await loadOfficialApiIndexFromExtensions(extensions, selection.extensionRoot)
    : null;
  let baselineState: OfficialReverseAudit['api']['baselineState'] = 'missing';
  let baselineVersion: string | null = null;
  let diff: OfficialReverseAudit['api']['diff'] = null;
  if (currentApi !== null) {
    try {
      const value: unknown = JSON.parse(await readFile(join(input.projectRoot, '.yuanmeng-inspector', 'official', 'api-index-baseline.json'), 'utf8'));
      if (!isApiIndex(value)) throw new Error('invalid');
      baselineState = 'present';
      baselineVersion = value.officialExtensionVersion;
      diff = apiDiffSummary(value, currentApi);
    } catch (error) {
      baselineState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
    }
  }
  const dreamcode = await loadDreamCodeToolboxCatalog({
    extensionPath: input.dreamCodeExtensionPath ?? process.env.YMAI_DREAMCODE_EXTENSION_PATH ?? null,
    extensionsRoot,
  });
  const template = await inspectTemplate(selection.state === 'selected' ? selection.extensionRoot : null, input.projectRoot);
  const scripts = await inspectScripts(input.ugcDataPath ?? process.env.YMAI_UGC_DATA_PATH ?? null);
  const warnings = [
    ...(selection.state === 'ambiguous' ? ['检测到多个官方扩展来源，API 差异和模板审查拒绝猜测版本。'] : []),
    ...(baselineState !== 'present' && currentApi !== null ? ['尚未保存当前官方 API 基线；本次只能报告当前版本，不能报告跨版本变化。'] : []),
    ...(template.state === 'partial' || template.state === 'missing' ? ['模板差异只做工程结构提示，不自动复制或覆盖地图文件。'] : []),
    ...(template.state === 'different' ? ['标准文件与官方模板字节内容不同；这是差异提示，不代表业务代码有误，不自动覆盖文件。'] : []),
    ...(template.state === 'invalid' ? ['模板内容比较未完成；检查包格式、文件大小与读取状态，不能报告内容一致。'] : []),
    ...(scripts.state === 'not-configured' ? ['未配置 UGC 数据目录，暂时无法读取官方脚本 ZIP 使用痕迹。'] : []),
    ...(scripts.state !== 'not-configured' && !scripts.complete ? ['脚本包扫描不完整；请查看 scope、skippedCount、skipped 和 truncated，不能据零结果判断不存在脚本。'] : []),
    ...(diff?.truncated ? ['API 差异摘要达到数量上限；totals 为完整数量，categories 按函数、常量和枚举列出有界明细。'] : []),
  ];
  return {
    currentApi,
    report: {
      schemaVersion: 1,
      evidence: 'STATIC_LOCAL',
      officialExtension: {
        state: selection.state,
        id: selection.state === 'selected' ? selection.extensionId : null,
        version: selection.state === 'selected' ? selection.officialExtensionVersion : null,
      },
      api: {
        state: currentApi === null ? 'missing' : 'current',
        currentVersion: currentApi?.officialExtensionVersion ?? null,
        currentCount: currentApi?.declarations.length ?? 0,
        baselineState,
        baselineVersion,
        baselinePath: '.yuanmeng-inspector/official/api-index-baseline.json',
        diff,
      },
      dreamcode,
      template,
      scripts,
      warnings: [...warnings, ...dreamcode.warnings],
    },
  };
}
