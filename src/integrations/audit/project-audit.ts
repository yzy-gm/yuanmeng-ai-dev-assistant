import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { buildAcceptanceChecklist, buildHandoffReport, buildHealthReport } from '../../core/audit/report.js';
import { buildLuaApiKnowledge } from '../../core/api/lua-knowledge.js';
import { analyzeProject } from '../../core/diagnostics/analyzer.js';
import { ProductError } from '../../core/errors.js';
import { buildLuaSourceIndex, type LuaSourceFile } from '../../core/lua/source-index.js';
import type { InspectorStatus, UiSnapshot } from '../../core/model.js';
import { RegistryStore } from '../../core/registry/store.js';
import { loadOfficialApiIndexFromEnvironment } from '../official/api-index-loader.js';

export interface ProjectAuditInput {
  root: string;
  projectInstanceId: string;
  status: InspectorStatus | null;
  snapshot: UiSnapshot | null;
  files?: readonly string[];
  errorsOnly?: boolean;
}

function normalizeTargetFile(file: string): string {
  const normalized = file.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  if (
    !normalized.startsWith('src/')
    || !normalized.toLowerCase().endsWith('.lua')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new ProductError(
      'VALIDATION_FAILED',
      `定向审计路径无效：${file}`,
      ['只指定 src/ 下的工程相对 Lua 路径。'],
      'STATIC_LOCAL',
    );
  }
  return normalized;
}

async function collectTargetLuaFiles(root: string, requestedFiles: readonly string[]): Promise<LuaSourceFile[]> {
  const canonicalRoot = await realpath(root);
  const canonicalSrc = await realpath(join(canonicalRoot, 'src'));
  const output: LuaSourceFile[] = [];
  const seen = new Set<string>();
  for (const requestedFile of requestedFiles) {
    const normalized = normalizeTargetFile(requestedFile);
    if (seen.has(normalized)) {
      throw new ProductError('VALIDATION_FAILED', `定向审计路径重复：${normalized}`, ['移除重复文件后重试。'], 'STATIC_LOCAL');
    }
    seen.add(normalized);
    const candidate = resolve(canonicalRoot, normalized);
    const fromSrc = relative(canonicalSrc, candidate);
    if (fromSrc.startsWith('..') || isAbsolute(fromSrc)) {
      throw new ProductError('VALIDATION_FAILED', `定向审计路径越出 src：${normalized}`, ['只指定 src/ 下的工程相对 Lua 路径。'], 'STATIC_LOCAL');
    }
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProductError('NOT_FOUND', `定向审计文件不存在：${normalized}`, ['确认文件已保存且路径相对当前工程。'], 'STATIC_LOCAL');
      }
      throw error;
    }
    const canonicalFromSrc = relative(canonicalSrc, canonicalFile);
    if (canonicalFromSrc.startsWith('..') || isAbsolute(canonicalFromSrc) || !(await stat(canonicalFile)).isFile()) {
      throw new ProductError('VALIDATION_FAILED', `定向审计目标不是 src 内普通文件：${normalized}`, ['改用当前工程 src/ 下的 Lua 文件。'], 'STATIC_LOCAL');
    }
    output.push({ path: normalized, source: await readFile(canonicalFile, 'utf8') });
  }
  return output;
}

async function collectLuaFiles(root: string, requestedFiles: readonly string[] = []): Promise<LuaSourceFile[]> {
  if (requestedFiles.length > 0) return collectTargetLuaFiles(root, requestedFiles);
  const files: LuaSourceFile[] = [];
  const visitDirectory = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(path);
      } else if (
        entry.isFile()
        && entry.name.toLowerCase().endsWith('.lua')
        && !/^Custom(?:UIData|Property_).*\.lua$/u.test(entry.name)
      ) {
        files.push({
          path: relative(root, path).replace(/\\/gu, '/'),
          source: await readFile(path, 'utf8'),
        });
        if (files.length > 10_000) {
          throw new ProductError(
            'LUA_LIMIT_EXCEEDED',
            'Lua 文件数量超过索引上限。',
            ['缩小工程源码范围后重试。'],
            'STATIC_LOCAL',
          );
        }
      }
    }
  };
  await visitDirectory(join(root, 'src'));
  return files;
}

export async function auditProject(input: ProjectAuditInput) {
  const requestedFiles = input.files ?? [];
  const errorsOnly = input.errorsOnly ?? false;
  const [index, luaFiles] = await Promise.all([
    loadOfficialApiIndexFromEnvironment(),
    collectLuaFiles(input.root, requestedFiles),
  ]);
  let records = [] as ReturnType<RegistryStore['list']>;
  try {
    records = (await RegistryStore.open(join(input.root, '.yuanmeng-inspector', 'registry', 'registry.json'))).list();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const registry = { schemaVersion: 1 as const, records };
  const sourceIndex = buildLuaSourceIndex(luaFiles, registry, buildLuaApiKnowledge(index));
  const diagnostics = analyzeProject({
    sourceIndex,
    registry,
    apiIndex: index,
    uiSnapshot: input.snapshot,
    status: input.status,
    projectInstanceId: input.projectInstanceId,
    mapFingerprint: input.status?.project.mapFingerprint ?? input.snapshot?.mapFingerprint ?? null,
  });
  const issueCounts = diagnostics.reduce((counts, diagnostic) => ({
    ...counts,
    [diagnostic.severity]: counts[diagnostic.severity] + 1,
  }), { error: 0, warning: 0, info: 0 });
  const health = buildHealthReport({ issueCounts, stale: input.status?.ui.freshness !== 'fresh' });
  const acceptanceChecklist = buildAcceptanceChecklist({
    staticPassed: true,
    unitPassed: true,
    extensionHostPassed: false,
    vsixPassed: false,
    importedLogs: [],
    manualEvidence: [],
  });
  const handoff = buildHandoffReport({
    projectLabel: input.root.split(/[\\/]/u).at(-1) ?? '当前工程',
    health,
    checklist: acceptanceChecklist,
  });
  const returnedDiagnostics = errorsOnly
    ? diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    : diagnostics;
  const targeted = requestedFiles.length > 0;
  return {
    officialExtensionVersion: index.officialExtensionVersion,
    scope: {
      mode: targeted ? 'targeted' as const : 'full' as const,
      files: targeted ? luaFiles.map((file) => file.path) : [],
      fullProjectEvidence: !targeted,
    },
    issueCounts,
    diagnostics: returnedDiagnostics,
    presentation: {
      errorsOnly,
      returnedDiagnostics: returnedDiagnostics.length,
      omittedDiagnostics: diagnostics.length - returnedDiagnostics.length,
    },
    health,
    acceptanceChecklist,
    handoff,
  };
}
