import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { parseCliArgs, type CliArgs } from './args.js';
import { renderCliResult, result, resultFromError, type CliRunResult } from './output.js';
import { resolveCliProject, type ResolvedCliProject } from './project.js';
import { systemClock, type Clock } from '../core/clock.js';
import {
  buildApiIndex,
  parseDeclarationFile,
  searchApi,
  type ApiIndex,
} from '../core/api/declaration-index.js';
import { analyzeProject } from '../core/diagnostics/analyzer.js';
import { ProductError } from '../core/errors.js';
import { atomicWriteJson, nodeFileIO } from '../core/fs.js';
import type { InspectorStatus, UiSnapshot } from '../core/model.js';
import { RegistryStore } from '../core/registry/store.js';
import {
  buildLuaSourceIndex,
  whereUsed,
  type LuaSourceFile,
} from '../core/lua/source-index.js';
import { diffUi } from '../core/ui/diff.js';
import { renderUiExport } from '../core/ui/export.js';
import { findUi } from '../core/ui/index.js';
import {
  discoverOfficialApiSource,
  type InstalledExtensionRecord,
} from '../integrations/official/api-source.js';
import {
  createRefreshUiRequest,
  type QueueResult,
  type QueueSession,
  type RefreshUiRequest,
} from '../integrations/queue/protocol.js';
import { buildAcceptanceChecklist, buildHandoffReport, buildHealthReport } from '../core/audit/report.js';

export interface CliDependencies {
  cwd: string;
  currentCliPath: string;
  clock: Clock;
}

export type OutputWriter = (message: string) => void;

const USAGE = '用法：ymai <命令> [选项]\n';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validation(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['在 VSCode 中重新刷新或初始化当前工程。'], 'STATIC_LOCAL');
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw error;
    }
    validation(`${label} JSON 已损坏。`);
  }
}

function validateStatus(value: unknown, project: ResolvedCliProject): InspectorStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validation('状态数据无效。');
  }
  const status = value as Partial<InspectorStatus>;
  if (
    status.schemaVersion !== 1
    || status.project?.projectInstanceId !== project.projectInstanceId
    || status.project.projectRootHash !== project.projectRootHash
    || (status.link?.state !== 'online' && status.link?.state !== 'offline' && status.link?.state !== 'unknown')
    || (status.ui?.freshness !== 'fresh' && status.ui?.freshness !== 'stale' && status.ui?.freshness !== 'missing')
  ) {
    validation('状态数据与当前工程不匹配。');
  }
  return value as InspectorStatus;
}

function validateSnapshot(value: unknown, project: ResolvedCliProject): UiSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validation('UI 快照无效。');
  }
  const snapshot = value as Partial<UiSnapshot>;
  if (
    snapshot.schemaVersion !== 1
    || typeof snapshot.snapshotId !== 'string'
    || !SHA256_PATTERN.test(snapshot.snapshotId)
    || snapshot.projectInstanceId !== project.projectInstanceId
    || !Array.isArray(snapshot.nodes)
    || !Array.isArray(snapshot.sources)
    || !Array.isArray(snapshot.duplicateNames)
  ) {
    validation('UI 快照与当前工程不匹配或字段无效。');
  }
  return value as UiSnapshot;
}

async function loadStatus(project: ResolvedCliProject): Promise<InspectorStatus | null> {
  try {
    return validateStatus(
      await readJson(join(project.root, '.yuanmeng-inspector', 'status.json'), '状态'),
      project,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function loadCurrentSnapshot(project: ResolvedCliProject): Promise<UiSnapshot | null> {
  try {
    return validateSnapshot(
      await readJson(join(project.root, '.yuanmeng-inspector', 'ui', 'current.json'), 'UI 快照'),
      project,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function offline(message: string, data: unknown = null): CliRunResult {
  return result('OFFLINE', message, data);
}

async function runStatus(project: ResolvedCliProject): Promise<CliRunResult> {
  const status = await loadStatus(project);
  if (status === null) {
    return offline('扩展联动离线或尚未生成状态数据。', {
      projectInstanceId: project.projectInstanceId,
      link: 'offline',
      freshness: 'missing',
    });
  }
  const data = {
    projectInstanceId: project.projectInstanceId,
    mapName: status.project.mapName,
    currentLayerId: status.project.currentLayerId,
    link: status.link,
    ui: status.ui,
    issueCounts: status.issueCounts,
  };
  if (status.link.state === 'offline') {
    return offline('官方联动当前离线。', data);
  }
  if (status.ui.freshness === 'stale') {
    return result('STALE', 'UI 数据陈旧。', data, ['UI 数据陈旧']);
  }
  return result('OK', '工程状态可用。', data);
}

async function runFindUi(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'find-ui' }>): Promise<CliRunResult> {
  const [status, snapshot] = await Promise.all([loadStatus(project), loadCurrentSnapshot(project)]);
  if (snapshot === null) {
    return offline('没有可读取的 UI 快照。');
  }
  const match = findUi(snapshot, args.query, { mode: args.searchMode });
  const freshness = status?.ui.freshness ?? 'stale';
  if (freshness !== 'fresh' && !args.allowStale) {
    return result('STALE', 'UI 数据陈旧；如需只读旧数据，请显式使用 --allow-stale。', {
      freshness: 'stale',
    }, ['UI 数据陈旧']);
  }
  const warnings = freshness === 'fresh' ? [] : ['UI 数据陈旧'];
  if (match.kind === 'not-found') {
    return result('NOT_FOUND', '未找到匹配的 UI 控件。', { freshness }, warnings);
  }
  if (match.kind === 'ambiguous') {
    return result('AMBIGUOUS', '存在同名或多项候选，请按完整路径消歧。', {
      freshness,
      candidates: match.candidates,
    }, warnings);
  }
  return result('OK', `已找到 UI 控件：${match.node.name}`, {
    freshness,
    node: match.node,
  }, warnings);
}

async function runListIds(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'list-ids' }>): Promise<CliRunResult> {
  const status = await loadStatus(project);
  const freshness = status?.ui.freshness ?? 'stale';
  if (freshness !== 'fresh' && !args.allowStale) {
    return result('STALE', '注册中心可能基于陈旧数据；如需只读旧数据，请显式使用 --allow-stale。', {
      freshness: 'stale',
    }, ['注册中心数据可能陈旧']);
  }
  const path = join(project.root, '.yuanmeng-inspector', 'registry', 'registry.json');
  let store: RegistryStore;
  try {
    store = await RegistryStore.open(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return result('OK', '注册中心尚无记录。', { freshness, records: [] }, freshness === 'fresh' ? [] : ['注册中心数据可能陈旧']);
    }
    throw error;
  }
  const records = store.list({
    ...(args.kind === null ? {} : { kind: args.kind }),
    ...(args.environment === null ? {} : { environment: args.environment }),
    ...(args.validity === null ? {} : { validity: args.validity }),
  }).filter((record) => record.projectInstanceId === project.projectInstanceId);
  return result('OK', `注册中心返回 ${records.length} 条记录。`, { freshness, records }, freshness === 'fresh' ? [] : ['注册中心数据可能陈旧']);
}

async function collectLuaFiles(root: string): Promise<LuaSourceFile[]> {
  const sourceRoot = join(root, 'src');
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
          validation('Lua 文件数量超过索引上限。');
        }
      }
    }
  };
  await visitDirectory(sourceRoot);
  return files;
}

async function runWhereUsed(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'where-used' }>,
): Promise<CliRunResult> {
  const registryPath = join(project.root, '.yuanmeng-inspector', 'registry', 'registry.json');
  let records = [] as ReturnType<RegistryStore['list']>;
  try {
    records = (await RegistryStore.open(registryPath)).list().filter((record) => (
      record.projectInstanceId === project.projectInstanceId
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const index = buildLuaSourceIndex(
    await collectLuaFiles(project.root),
    { schemaVersion: 1, records },
    { calls: [], configuredIdFields: [] },
  );
  const matches = whereUsed(index, {
    value: args.query,
    ...(args.kind === null ? {} : { kind: args.kind }),
  });
  if (matches.length === 0) {
    return result('NOT_FOUND', '未找到匹配的 Lua 引用。', {
      query: args.query,
      kind: args.kind,
      results: [],
    });
  }
  return result('OK', `找到 ${matches.length} 处 Lua 引用。`, {
    query: args.query,
    kind: args.kind,
    results: matches,
  });
}

async function installedExtensions(root: string): Promise<InstalledExtensionRecord[]> {
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

async function runApiSearch(args: Extract<CliArgs, { command: 'api-search' }>): Promise<CliRunResult> {
  const index = await loadOfficialApiIndex();
  const results = searchApi(index, args.query);
  if (results.length === 0) {
    return result('NOT_FOUND', '当前官方 API 声明中未找到匹配项。', {
      officialExtensionVersion: index.officialExtensionVersion,
      results: [],
    });
  }
  return result('OK', `找到 ${results.length} 个官方 API 声明。`, {
    officialExtensionVersion: index.officialExtensionVersion,
    results,
  });
}

async function loadOfficialApiIndex(): Promise<ApiIndex> {
  const userProfile = process.env.USERPROFILE;
  const extensionsRoot = process.env.VSCODE_EXTENSIONS
    ?? (userProfile === undefined ? '' : join(userProfile, '.vscode', 'extensions'));
  if (extensionsRoot === '') {
    throw new ProductError('OFFLINE', '无法定位本机 VSCode 扩展目录。', ['安装或启用官方扩展后重试。'], 'STATIC_LOCAL');
  }
  const selection = await discoverOfficialApiSource(
    await installedExtensions(extensionsRoot),
    process.env.YMAI_OFFICIAL_EXTENSION_PATH?.trim() || null,
  );
  if (selection.state === 'missing') {
    throw new ProductError('OFFLINE', '未检测到同时提供官方 UI 命令与 res/lib 声明的扩展。', ['安装或启用官方扩展后重试。'], 'STATIC_LOCAL');
  }
  if (selection.state === 'ambiguous') {
    throw new ProductError(
      'VALIDATION_FAILED',
      '检测到多个官方命令提供者，拒绝猜测 API 来源。',
      ['通过 YMAI_OFFICIAL_EXTENSION_PATH 选择已检测到的扩展目录。'],
      'STATIC_LOCAL',
    );
  }
  if (selection.declarationPaths.length > 1_000) {
    validation('官方 API 声明文件数量超过安全上限。');
  }
  const parsed = await Promise.all(selection.declarationPaths.map(async (relativePath) => {
    const source = await readFile(join(selection.extensionRoot, ...relativePath.split('/')), 'utf8');
    if (Buffer.byteLength(source, 'utf8') > 4 * 1024 * 1024) {
      validation('单个官方 API 声明文件超过安全上限。');
    }
    return parseDeclarationFile({ relativePath, source });
  }));
  return buildApiIndex(parsed, {
    officialExtensionVersion: selection.officialExtensionVersion,
  });
}

function apiKnowledge(index: ApiIndex) {
  return {
    calls: index.declarations.map((declaration) => ({
      qualifiedName: `${declaration.module}${declaration.callStyle === 'colon' ? ':' : '.'}${declaration.name}`,
      idParameterIndexes: declaration.params.flatMap((parameter, parameterIndex) => (
        /(?:id|uid)$/iu.test(parameter.name) && !/(?:signal|event)/iu.test(parameter.name) ? [parameterIndex] : []
      )),
      signalParameterIndexes: declaration.params.flatMap((parameter, parameterIndex) => (
        /(?:signal|event)/iu.test(parameter.name) ? [parameterIndex] : []
      )),
    })),
    configuredIdFields: [],
  };
}

async function runAudit(project: ResolvedCliProject): Promise<CliRunResult> {
  const [status, snapshot, index] = await Promise.all([
    loadStatus(project),
    loadCurrentSnapshot(project),
    loadOfficialApiIndex(),
  ]);
  let records = [] as ReturnType<RegistryStore['list']>;
  try {
    records = (await RegistryStore.open(join(project.root, '.yuanmeng-inspector', 'registry', 'registry.json'))).list();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const registry = { schemaVersion: 1 as const, records };
  const sourceIndex = buildLuaSourceIndex(await collectLuaFiles(project.root), registry, apiKnowledge(index));
  const diagnostics = analyzeProject({
    sourceIndex,
    registry,
    apiIndex: index,
    uiSnapshot: snapshot,
    status,
    projectInstanceId: project.projectInstanceId,
    mapFingerprint: status?.project.mapFingerprint ?? snapshot?.mapFingerprint ?? null,
  });
  const issueCounts = diagnostics.reduce((counts, diagnostic) => ({
    ...counts,
    [diagnostic.severity]: counts[diagnostic.severity] + 1,
  }), { error: 0, warning: 0, info: 0 });
  const health = buildHealthReport({ issueCounts, stale: status?.ui.freshness !== 'fresh' });
  const acceptanceChecklist = buildAcceptanceChecklist({
    staticPassed: true,
    unitPassed: true,
    extensionHostPassed: false,
    vsixPassed: false,
    importedLogs: [],
    manualEvidence: [],
  });
  const handoff = buildHandoffReport({
    projectLabel: project.root.split(/[\\/]/u).at(-1) ?? '当前工程',
    health,
    checklist: acceptanceChecklist,
  });
  return result('OK', `工程审计完成：${issueCounts.error} 个错误，${issueCounts.warning} 个警告。`, {
    officialExtensionVersion: index.officialExtensionVersion,
    issueCounts,
    diagnostics,
    health,
    acceptanceChecklist,
    handoff,
  });
}

async function loadSnapshotById(project: ResolvedCliProject, snapshotId: string): Promise<UiSnapshot> {
  if (!SHA256_PATTERN.test(snapshotId)) {
    validation('UI 快照 ID 无效。');
  }
  try {
    return validateSnapshot(await readJson(
      join(project.root, '.yuanmeng-inspector', 'ui', 'snapshots', `${snapshotId}.json`),
      'UI 快照',
    ), project);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProductError('NOT_FOUND', '指定的 UI 快照不存在。', ['运行 refresh-ui 生成新快照。'], 'STATIC_LOCAL');
    }
    throw error;
  }
}

async function defaultDiffIds(project: ResolvedCliProject): Promise<[string, string]> {
  const directory = join(project.root, '.yuanmeng-inspector', 'ui', 'snapshots');
  let filenames: string[];
  try {
    filenames = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProductError('NOT_FOUND', '没有足够的 UI 快照可供比较。', ['至少刷新两次 UI。'], 'STATIC_LOCAL');
    }
    throw error;
  }
  const snapshots = await Promise.all(filenames.map(async (name) => loadSnapshotById(project, name.slice(0, -5))));
  snapshots.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (snapshots.length < 2) {
    throw new ProductError('NOT_FOUND', '没有足够的 UI 快照可供比较。', ['至少刷新两次 UI。'], 'STATIC_LOCAL');
  }
  return [snapshots.at(-2)!.snapshotId, snapshots.at(-1)!.snapshotId];
}

async function runDiffUi(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'diff-ui' }>): Promise<CliRunResult> {
  let from = args.from;
  let to = args.to;
  if ((from === null) !== (to === null)) {
    throw new ProductError('USAGE_ERROR', '--from 与 --to 必须同时提供。', ['同时提供两个快照 ID。'], 'STATIC_LOCAL');
  }
  if (from === null || to === null) {
    [from, to] = await defaultDiffIds(project);
  }
  const [oldSnapshot, newSnapshot] = await Promise.all([
    loadSnapshotById(project, from),
    loadSnapshotById(project, to),
  ]);
  return result('OK', 'UI 快照差异已生成。', diffUi(oldSnapshot, newSnapshot));
}

function safeReportedPath(projectRoot: string, outputPath: string): string {
  const projectRelative = relative(projectRoot, outputPath);
  if (projectRelative !== '' && !projectRelative.startsWith('..') && !isAbsolute(projectRelative)) {
    return projectRelative.replace(/\\/gu, '/');
  }
  return outputPath.split(/[\\/]/u).at(-1) ?? 'export';
}

async function runExport(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'export' }>, cwd: string): Promise<CliRunResult> {
  const snapshot = await loadCurrentSnapshot(project);
  if (snapshot === null) {
    return offline('没有可导出的 UI 快照。');
  }
  const outputPath = resolve(cwd, args.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderUiExport(snapshot, args.format), 'utf8');
  return result('OK', 'UI 清单已导出。', {
    format: args.format,
    out: safeReportedPath(project.root, outputPath),
    snapshotId: snapshot.snapshotId,
  });
}

function validateQueueSession(value: unknown, project: ResolvedCliProject, now: Date): QueueSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validation('扩展刷新会话无效。');
  }
  const session = value as Partial<QueueSession>;
  if (
    session.schemaVersion !== 1
    || typeof session.token !== 'string'
    || !SHA256_PATTERN.test(session.token)
    || session.projectInstanceId !== project.projectInstanceId
    || typeof session.createdAt !== 'string'
    || typeof session.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(session.expiresAt))
    || now.getTime() > Date.parse(session.expiresAt)
  ) {
    validation('扩展刷新会话已过期或与当前工程不匹配。');
  }
  return value as QueueSession;
}

function validateQueueResult(value: unknown, requestId: string): QueueResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validation('刷新结果无效。');
  }
  const queueResult = value as Partial<QueueResult>;
  if (
    queueResult.schemaVersion !== 1
    || queueResult.requestId !== requestId
    || (queueResult.status !== 'completed' && queueResult.status !== 'rejected' && queueResult.status !== 'failed')
    || typeof queueResult.code !== 'string'
    || typeof queueResult.message !== 'string'
  ) {
    validation('刷新结果与请求不匹配。');
  }
  return value as QueueResult;
}

function validateRefreshRequest(value: unknown): asserts value is RefreshUiRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validation('刷新请求无效。');
  }
  const request = value as Partial<RefreshUiRequest>;
  if (
    request.schemaVersion !== 1
    || typeof request.requestId !== 'string'
    || !UUID_PATTERN.test(request.requestId)
    || typeof request.token !== 'string'
    || !SHA256_PATTERN.test(request.token)
    || typeof request.projectInstanceId !== 'string'
    || request.action !== 'refresh-ui'
    || typeof request.createdAt !== 'string'
    || typeof request.expiresAt !== 'string'
  ) {
    validation('刷新请求字段无效。');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runRefreshUi(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'refresh-ui' }>,
  clock: Clock,
): Promise<CliRunResult> {
  const runtimeRoot = join(project.root, '.yuanmeng-inspector', 'runtime');
  let sessionValue: unknown;
  try {
    sessionValue = await readJson(join(runtimeRoot, 'session.json'), '刷新会话');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return offline('VSCode 扩展未运行，无法请求最新 UI。');
    }
    throw error;
  }
  const session = validateQueueSession(sessionValue, project, clock.now());
  const request = createRefreshUiRequest(session, clock);
  const pendingPath = join(runtimeRoot, 'requests', 'pending', `${request.requestId}.json`);
  await atomicWriteJson(nodeFileIO, pendingPath, request, validateRefreshRequest);
  const resultPath = join(runtimeRoot, 'requests', 'results', `${request.requestId}.json`);
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    try {
      const queueResult = validateQueueResult(await readJson(resultPath, '刷新结果'), request.requestId);
      if (queueResult.status === 'completed' && queueResult.code === 'OK') {
        return result('OK', queueResult.message, { requestId: request.requestId });
      }
      return offline(queueResult.message, { requestId: request.requestId, queueCode: queueResult.code });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(100);
  }
  return offline('UI 刷新超时；扩展可能离线或官方联动未响应。', { requestId: request.requestId });
}

export async function runCli(
  argv: readonly string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<CliRunResult> {
  try {
    const args = parseCliArgs(argv);
    const cwd = dependencies.cwd ?? process.cwd();
    const project = await resolveCliProject({
      project: args.project,
      launcherManifest: args.launcherManifest,
      cwd,
      currentCliPath: dependencies.currentCliPath ?? process.argv[1] ?? '',
    });
    switch (args.command) {
      case 'status':
        return runStatus(project);
      case 'refresh-ui':
        return runRefreshUi(project, args, dependencies.clock ?? systemClock);
      case 'find-ui':
        return runFindUi(project, args);
      case 'list-ids':
        return runListIds(project, args);
      case 'where-used':
        return runWhereUsed(project, args);
      case 'api-search':
        return runApiSearch(args);
      case 'audit':
        return runAudit(project);
      case 'diff-ui':
        return runDiffUi(project, args);
      case 'export':
        return runExport(project, args, cwd);
    }
  } catch (error) {
    if (error instanceof ProductError && error.code === 'NOT_FOUND') {
      return result('NOT_FOUND', error.message, { nextActions: [...error.nextActions] });
    }
    return resultFromError(error);
  }
}

export async function main(
  argv: readonly string[],
  writeError: OutputWriter = (message) => process.stderr.write(message),
  writeOutput: OutputWriter = (message) => process.stdout.write(message),
): Promise<number> {
  if (argv.length === 0) {
    writeError(USAGE);
    return 7;
  }
  const runResult = await runCli(argv);
  const rendered = renderCliResult(runResult, argv.includes('--json'));
  if (rendered.stdout !== '') {
    writeOutput(rendered.stdout);
  }
  if (rendered.stderr !== '') {
    writeError(rendered.stderr);
  }
  return runResult.exitCode;
}

if (typeof require !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
