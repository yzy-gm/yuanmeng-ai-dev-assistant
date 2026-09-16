import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { parseCliArgs, type CliArgs } from './args.js';
import { renderCliResult, result, resultFromError, type CliRunResult } from './output.js';
import { resolveCliProject, type ResolvedCliProject } from './project.js';
import { systemClock, type Clock } from '../core/clock.js';
import { searchApiSymbols } from '../core/api/declaration-index.js';
import { loadDreamCodeApiCatalog, loadDreamCodeToolboxCatalog, searchBlockApiCatalog } from '../core/api/block-catalog.js';
import { resolveEventMetadata } from '../core/api/event-doc-index.js';
import { searchResourceCatalog } from '../core/api/resource-catalog.js';
import { ProductError } from '../core/errors.js';
import { stableJson } from '../core/hash.js';
import { diagnoseProjectEnvironment } from '../core/environment/health.js';
import { readProjectDisplayProfile, writeProjectDisplayProfile } from '../core/project/display-profile.js';
import { addFeedback, listFeedback, resolveFeedback, type FeedbackContext } from '../core/feedback/store.js';
import { atomicWriteJson, nodeFileIO } from '../core/fs.js';
import type { InspectorStatus, UiSnapshot } from '../core/model.js';
import { RegistryStore } from '../core/registry/store.js';
import { summarizeSceneCache } from '../core/scene/cache.js';
import { readLiveOfficialConnection } from '../core/status/live-connection.js';
import type { OfficialConnectionObservation } from '../core/logs/official-connection.js';
import {
  buildLuaSourceIndex,
  whereUsed,
  type LuaSourceFile,
} from '../core/lua/source-index.js';
import { diffUi } from '../core/ui/diff.js';
import { renderUiExport } from '../core/ui/export.js';
import { findUi, resolveUiByNameOrPath } from '../core/ui/index.js';
import {
  auditUiRuntimeGeometry,
  generateUiGeometryProbe,
  selectUiSubtree,
  validateUiRuntimeGeometryDocument,
  type UiRuntimeGeometryDocument,
} from '../core/ui/runtime-geometry.js';
import {
  createUiRuntimeWidgetProbeToken,
  createUiScreenPointProbeToken,
  generateUiRuntimeWidgetProbe,
  generateUiScreenPointProbe,
  validateUiRuntimeWidgetDocument,
  validateUiScreenPointDocument,
  type UiRuntimeWidgetDocument,
  type UiScreenPointDocument,
} from '../core/ui/runtime-inspection.js';
import { loadOfficialApiIndexFromEnvironment } from '../integrations/official/api-index-loader.js';
import { runOfficialReverseAudit, saveOfficialApiBaseline } from '../core/official/reverse-audit.js';
import { loadLocalEventDocumentation } from '../integrations/official/event-doc-source.js';
import { loadLocalResourceCatalog } from '../integrations/official/resource-doc-source.js';
import {
  createRefreshUiRequest,
  type QueueResult,
  type QueueSession,
  type RefreshUiRequest,
} from '../integrations/queue/protocol.js';
import { auditProject } from '../integrations/audit/project-audit.js';
import { buildSceneAiContext, renderSceneAiContext, renderSceneExport } from '../core/scene/export.js';
import {
  loadPreferredSceneSnapshot,
  runBindScene,
  runFieldInspect,
  runFindScene,
  runGroupMembers,
  runRefreshScene,
  runPropertyLocate,
  runSceneDiff,
  runSceneAudit,
  runSceneNear,
  runScenePlan,
  runSceneJournal,
  runSceneStatus,
  runSceneTypes,
  runSceneCapabilities,
  runSceneCapabilityProbe,
  runSceneGeometry,
  runSceneTree,
} from './scene.js';
import { runGameplayReview, runGameplayTest } from './gameplay.js';

export interface CliDependencies {
  cwd: string;
  currentCliPath: string;
  clock: Clock;
  signal?: AbortSignal;
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

function applyLiveOfficialConnection(
  status: InspectorStatus,
  observation: OfficialConnectionObservation | null,
): InspectorStatus {
  if (observation === null || observation.state === 'unknown' || observation.observedAt === null) return status;
  return {
    ...status,
    link: {
      ...status.link,
      state: observation.state,
      reasonCode: observation.state === 'online'
        ? 'OFFICIAL_OUTPUT_CONNECTED'
        : 'OFFICIAL_OUTPUT_DISCONNECTED',
      lastProbeAt: observation.observedAt,
    },
  };
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
  const [storedStatus, displayProfile, snapshot, sceneSnapshot, cache, liveConnection] = await Promise.all([
    loadStatus(project),
    readProjectDisplayProfile(project.root, project.projectInstanceId, nodeFileIO),
    loadCurrentSnapshot(project),
    loadPreferredSceneSnapshot(project).catch(() => null),
    summarizeSceneCache(project.root).catch(() => null),
    readLiveOfficialConnection(project.root, project.projectInstanceId, project.projectRootHash, nodeFileIO),
  ]);
  const status = storedStatus === null ? null : applyLiveOfficialConnection(storedStatus, liveConnection);
  const environment = await diagnoseProjectEnvironment({
    root: project.root,
    projectInstanceId: project.projectInstanceId,
    projectRootHash: project.projectRootHash,
    status,
    snapshot
  });
  const cacheOverBudget = cache?.warning === 'over-budget';
  if (status === null) {
    return offline('扩展联动离线或尚未生成状态数据。', {
      projectInstanceId: project.projectInstanceId,
      mapDisplayName: displayProfile?.mapDisplayName ?? null,
      link: 'offline',
      freshness: 'missing',
      cache,
      environment,
    });
  }
  const uiState = status.ui.freshness;
  const codeDeliveryUsable = environment.bridge.state === 'online' && environment.official.buildAvailable;
  const nextActions = [
    ...(uiState === 'stale'
      ? ['需要当前 UI 控件信息时运行 yuanmeng_ui_refresh；场景/Lua 等无关只读任务可继续。']
      : uiState === 'missing'
        ? ['需要 UI 控件信息时先在官方编辑器更新 VSCode 工程，再运行 yuanmeng_ui_refresh。']
        : []),
    ...(cacheOverBudget
      ? ['私有派生缓存已超过预算；运行“清理场景缓存”预览并确认安全清理。']
      : []),
  ];
  const data = {
    projectInstanceId: project.projectInstanceId,
    mapDisplayName: displayProfile?.mapDisplayName ?? null,
    mapName: status.project.mapName,
    currentLayerId: status.project.currentLayerId,
    linkEvidence: liveConnection === null ? 'persisted-status' : 'official-output-log-live',
    link: status.link,
    ui: status.ui,
    freshness: uiState,
    readiness: {
      ui: { state: uiState, usable: snapshot !== null },
      scene: {
        state: sceneSnapshot === null ? 'missing' : 'snapshot-available',
        usable: sceneSnapshot !== null,
        freshness: 'unknown',
        ...(sceneSnapshot === null ? {} : {
          snapshotId: sceneSnapshot.snapshotId,
          instances: sceneSnapshot.instances.length,
          groups: sceneSnapshot.groups.length,
          issues: sceneSnapshot.issues.length,
        }),
      },
      lua: { state: status.project.hasSrc && status.project.hasGameEntry ? 'ready' : 'missing', usable: status.project.hasSrc && status.project.hasGameEntry },
      api: { state: 'unknown', usable: false },
      codeDelivery: { state: codeDeliveryUsable ? 'ready' : 'blocked', usable: codeDeliveryUsable },
      gameplay: { state: 'unknown', usable: false },
    },
    nextActions,
    issueCounts: status.issueCounts,
    cache,
    environment,
  };
  if (status.link.state === 'offline') {
    return offline('官方联动当前离线。', data);
  }
  if (status.ui.freshness === 'stale' || cacheOverBudget) {
    return result(
      'OK',
      status.ui.freshness === 'stale' && cacheOverBudget
        ? '工程可用；UI 域数据陈旧，私有缓存超过预算。'
        : status.ui.freshness === 'stale'
          ? '工程可用；UI 域数据陈旧。'
          : '工程状态可用；私有缓存超过预算。',
      data,
      nextActions,
    );
  }
  return result('OK', '工程状态可用。', data);
}

async function runSetMapName(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'set-map-name' }>,
): Promise<CliRunResult> {
  const profile = await writeProjectDisplayProfile(
    project.root,
    project.projectInstanceId,
    args.mapDisplayName,
    nodeFileIO,
  );
  return result('OK', `当前地图显示名已设置为：${profile.mapDisplayName}`, {
    mapDisplayName: profile.mapDisplayName,
    projectInstanceId: project.projectInstanceId,
  });
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

async function requireCurrentUi(
  project: ResolvedCliProject,
  allowStale: boolean,
): Promise<{ snapshot: UiSnapshot; freshness: 'fresh' | 'stale'; warnings: string[] } | CliRunResult> {
  const [status, snapshot] = await Promise.all([loadStatus(project), loadCurrentSnapshot(project)]);
  if (snapshot === null) return offline('没有可读取的 UI 快照。');
  const freshness = status?.ui.freshness === 'fresh' ? 'fresh' : 'stale';
  const warnings = freshness === 'fresh' ? [] : ['UI 数据陈旧'];
  if (freshness !== 'fresh' && !allowStale) {
    return result('STALE', 'UI 数据陈旧；请刷新，或显式使用 --allow-stale 读取旧证据。', { freshness }, warnings);
  }
  return { snapshot, freshness, warnings };
}

async function runResolveUi(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'resolve-ui' }>): Promise<CliRunResult> {
  const current = await requireCurrentUi(project, args.allowStale);
  if ('exitCode' in current) return current;
  const match = resolveUiByNameOrPath(current.snapshot, args.query);
  if (match.kind === 'not-found') return result('NOT_FOUND', '未找到精确匹配的 UI 控件。', { freshness: current.freshness }, current.warnings);
  if (match.kind === 'ambiguous') return result('AMBIGUOUS', '控件名称不唯一；请使用完整路径或实例 ID。', {
    freshness: current.freshness, candidates: match.candidates,
  }, current.warnings);
  return result('OK', `已确定 UI 控件：${match.node.name}`, {
    reasonCode: 'UI_RESOLVED_EXACT', freshness: current.freshness, node: match.node,
  }, current.warnings);
}

async function loadUiScreenPointDocument(project: ResolvedCliProject, snapshot: UiSnapshot): Promise<UiScreenPointDocument | null> {
  try {
    const value = await readJson(join(project.root, '.yuanmeng-inspector', 'ui', 'screen-points', 'current.json'), 'UI 屏幕点证据');
    validateUiScreenPointDocument(value, { projectInstanceId: project.projectInstanceId, uiSnapshotId: snapshot.snapshotId });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ProductError && error.code === 'UI_RUNTIME_EVIDENCE_INSUFFICIENT') return null;
    throw error;
  }
}

async function loadUiRuntimeWidgetDocument(project: ResolvedCliProject, snapshot: UiSnapshot): Promise<UiRuntimeWidgetDocument | null> {
  try {
    const value = await readJson(join(project.root, '.yuanmeng-inspector', 'ui', 'runtime-widgets', 'current.json'), '运行时 UI 控件证据');
    validateUiRuntimeWidgetDocument(value, { projectInstanceId: project.projectInstanceId, uiSnapshotId: snapshot.snapshotId });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ProductError && error.code === 'UI_RUNTIME_EVIDENCE_INSUFFICIENT') return null;
    throw error;
  }
}

async function runUiInspectPoint(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'ui-inspect-point' }>): Promise<CliRunResult> {
  const current = await requireCurrentUi(project, args.allowStale);
  if ('exitCode' in current) return current;
  const context = { projectInstanceId: project.projectInstanceId, uiSnapshotId: current.snapshot.snapshotId };
  const token = createUiScreenPointProbeToken(context, args.request);
  const runtime = await loadUiScreenPointDocument(project, current.snapshot);
  if (runtime === null || runtime.token !== token || stableJson(runtime.request) !== stableJson(args.request)) {
    return result('EVIDENCE_INSUFFICIENT', '当前 UI 快照没有这个精确屏幕点的运行时命中证据。', {
      reasonCode: 'UI_SCREEN_POINT_RUNTIME_REQUIRED', evidence: 'STATIC_LOCAL', freshness: current.freshness,
      snapshotId: current.snapshot.snapshotId, request: args.request,
      probeLua: generateUiScreenPointProbe(current.snapshot, args.request),
      nextActions: ['把受控只读探针加入客户端测试代码并试玩一次。', '导入同一次试玩日志后重新调用本工具。'],
    }, current.warnings);
  }
  return result('OK', runtime.hitId === null ? '该屏幕点没有命中可见控件。' : `该屏幕点首先命中控件 ${runtime.hitId}。`, {
    reasonCode: 'UI_SCREEN_POINT_READY', evidence: runtime.evidence, freshness: current.freshness,
    snapshotId: current.snapshot.snapshotId, runtimeSnapshotId: runtime.runtimeSnapshotId,
    request: runtime.request, screenSize: runtime.screenSize, uiSystemSize: runtime.uiSystemSize,
    hitId: runtime.hitId, hit: runtime.hit,
  }, current.warnings);
}

function resolveRuntimeRoot(snapshot: UiSnapshot, query: string) {
  return resolveUiByNameOrPath(snapshot, query);
}

async function runUiRuntimeWidgets(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'ui-runtime-widgets' }>): Promise<CliRunResult> {
  const current = await requireCurrentUi(project, args.allowStale);
  if ('exitCode' in current) return current;
  const match = resolveRuntimeRoot(current.snapshot, args.query);
  if (match.kind === 'not-found') return result('NOT_FOUND', '未找到运行时 UI 根控件。', { freshness: current.freshness }, current.warnings);
  if (match.kind === 'ambiguous') return result('AMBIGUOUS', '根控件名称不唯一；请使用完整路径或实例 ID。', { candidates: match.candidates }, current.warnings);
  const context = { projectInstanceId: project.projectInstanceId, uiSnapshotId: current.snapshot.snapshotId };
  const token = createUiRuntimeWidgetProbeToken(context, match.node.id);
  const runtime = await loadUiRuntimeWidgetDocument(project, current.snapshot);
  if (runtime === null || runtime.rootId !== match.node.id || runtime.token !== token) {
    return result('EVIDENCE_INSUFFICIENT', '当前 UI 快照没有这个根控件的运行时动态控件证据。', {
      reasonCode: 'UI_RUNTIME_WIDGETS_REQUIRED', evidence: 'STATIC_LOCAL', freshness: current.freshness,
      snapshotId: current.snapshot.snapshotId, root: match.node,
      probeLua: generateUiRuntimeWidgetProbe(current.snapshot, match.node.id),
      nextActions: ['把受控树探针加入客户端测试代码并试玩一次。', '动态复制或列表映射可调用探针附带的结构化追踪函数。'],
    }, current.warnings);
  }
  const staticById = new Map(current.snapshot.nodes.map((node) => [node.id, node]));
  return result('OK', `已读取 ${runtime.entries.length} 条运行时控件证据。`, {
    reasonCode: 'UI_RUNTIME_WIDGETS_READY', evidence: runtime.evidence, freshness: current.freshness,
    snapshotId: current.snapshot.snapshotId, runtimeSnapshotId: runtime.runtimeSnapshotId,
    root: match.node,
    entries: runtime.entries.map((entry) => ({ ...entry, staticNode: staticById.get(entry.id) ?? null })),
  }, current.warnings);
}

async function runControlledRuntimeProbe(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'runtime-probe' }>): Promise<CliRunResult> {
  if (args.kind === 'scene-capability') return runSceneCapabilityProbe(project, args.instanceId);
  const current = await requireCurrentUi(project, args.allowStale);
  if ('exitCode' in current) return current;
  if (args.kind === 'ui-screen-point') {
    return result('OK', '已生成指定屏幕点的受控只读探针。', {
      reasonCode: 'RUNTIME_PROBE_GENERATED', kind: args.kind, snapshotId: current.snapshot.snapshotId,
      request: args.request, probeLua: generateUiScreenPointProbe(current.snapshot, args.request), evidence: 'STATIC_LOCAL',
    }, current.warnings);
  }
  const match = resolveRuntimeRoot(current.snapshot, args.query);
  if (match.kind === 'not-found') return result('NOT_FOUND', '未找到运行时 UI 根控件。', {}, current.warnings);
  if (match.kind === 'ambiguous') return result('AMBIGUOUS', '根控件名称不唯一；请使用完整路径或实例 ID。', { candidates: match.candidates }, current.warnings);
  return result('OK', '已生成运行时 UI 树的受控只读探针。', {
    reasonCode: 'RUNTIME_PROBE_GENERATED', kind: args.kind, snapshotId: current.snapshot.snapshotId,
    rootId: match.node.id, root: match.node, probeLua: generateUiRuntimeWidgetProbe(current.snapshot, match.node.id), evidence: 'STATIC_LOCAL',
  }, current.warnings);
}

async function loadCurrentUiRuntimeGeometry(
  project: ResolvedCliProject,
  snapshot: UiSnapshot,
): Promise<UiRuntimeGeometryDocument | null> {
  try {
    const value = await readJson(
      join(project.root, '.yuanmeng-inspector', 'ui', 'runtime', 'current.json'),
      'UI 运行时几何证据',
    );
    validateUiRuntimeGeometryDocument(value, {
      projectInstanceId: project.projectInstanceId,
      uiSnapshotId: snapshot.snapshotId,
    });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ProductError && error.code === 'UI_GEOMETRY_EVIDENCE_INSUFFICIENT') return null;
    throw error;
  }
}

function resolveUiGeometrySelection(
  snapshot: UiSnapshot,
  query: string,
  searchMode: Extract<CliArgs, { command: 'ui-screen-snapshot' }>['searchMode'],
  tree: boolean,
): { kind: 'unique'; nodes: UiSnapshot['nodes'] } | { kind: 'ambiguous'; candidates: UiSnapshot['nodes'] } | { kind: 'not-found' } {
  const match = findUi(snapshot, query, { mode: searchMode });
  if (match.kind !== 'unique') return match;
  const nodes = tree
    ? selectUiSubtree(snapshot, match.node.id)
    : [match.node];
  return { kind: 'unique', nodes };
}

async function runUiRuntimeGeometry(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'ui-screen-snapshot' | 'ui-tree-screen-snapshot' | 'ui-layout-audit' }>,
): Promise<CliRunResult> {
  const [status, snapshot] = await Promise.all([loadStatus(project), loadCurrentSnapshot(project)]);
  if (snapshot === null) return offline('没有可读取的 UI 快照。');
  const freshness = status?.ui.freshness ?? 'stale';
  const warnings = freshness === 'fresh' ? [] : ['UI 数据陈旧'];
  if (freshness !== 'fresh' && !args.allowStale) {
    return result('STALE', 'UI 数据陈旧；屏幕坐标查询前请刷新，或显式使用 --allow-stale。', { freshness }, warnings);
  }
  const effectiveSearchMode = args.searchMode === 'exact-name' && /^\d{1,20}$/u.test(args.query)
    ? 'exact-id'
    : args.searchMode;
  const selection = resolveUiGeometrySelection(snapshot, args.query, effectiveSearchMode, args.command !== 'ui-screen-snapshot');
  if (selection.kind === 'not-found') return result('NOT_FOUND', '未找到匹配的 UI 控件。', { freshness }, warnings);
  if (selection.kind === 'ambiguous') {
    return result('AMBIGUOUS', '存在多项候选，请使用完整 UI 路径。', { freshness, candidates: selection.candidates }, warnings);
  }
  const selectedIds = selection.nodes.map((node) => node.id).sort((left, right) => left.localeCompare(right, 'en'));
  const runtime = await loadCurrentUiRuntimeGeometry(project, snapshot);
  const hasAllEvidence = runtime !== null && selectedIds.every((id) => runtime.selectedIds.includes(id));
  if (!hasAllEvidence) {
    return result('EVIDENCE_INSUFFICIENT', '当前 UI 快照没有覆盖所选控件的运行时屏幕几何证据。', {
      status: 'EVIDENCE_INSUFFICIENT',
      reasonCode: 'UI_RUNTIME_GEOMETRY_REQUIRED',
      evidence: 'STATIC_LOCAL',
      freshness,
      snapshotId: snapshot.snapshotId,
      selectedIds,
      nodes: selection.nodes,
      probeLua: generateUiGeometryProbe(snapshot, selectedIds),
      nextActions: ['把返回的只读探针加入当前地图客户端测试代码并试玩一次。', '导入同一次试玩日志后重新调用本工具。'],
    }, warnings);
  }
  const entries = runtime.entries.filter((entry) => selectedIds.includes(entry.id));
  if (args.command === 'ui-layout-audit') {
    const scopedRuntime = { ...runtime, selectedIds, entries };
    return result('OK', 'UI 运行时布局审计完成。', {
      status: 'READY',
      evidence: runtime.evidence,
      freshness,
      snapshotId: snapshot.snapshotId,
      runtimeSnapshotId: runtime.runtimeSnapshotId,
      nodes: selection.nodes,
      report: auditUiRuntimeGeometry(scopedRuntime, snapshot, {
        includePotentialSiblingOverlap: args.includePotentialSiblingOverlap,
      }),
    }, warnings);
  }
  return result('OK', args.command === 'ui-screen-snapshot' ? '已读取控件运行时屏幕几何。' : '已读取控件树运行时屏幕几何。', {
    status: 'READY',
    evidence: runtime.evidence,
    freshness,
    snapshotId: snapshot.snapshotId,
    runtimeSnapshotId: runtime.runtimeSnapshotId,
    screenSize: runtime.screenSize,
    uiSystemSize: runtime.uiSystemSize,
    controls: selection.nodes.map((node) => ({ node, geometry: entries.find((entry) => entry.id === node.id) ?? null })),
  }, warnings);
}

async function feedbackContext(project: ResolvedCliProject): Promise<FeedbackContext> {
  const [uiSnapshot, sceneSnapshot] = await Promise.all([
    loadCurrentSnapshot(project).catch(() => null),
    loadPreferredSceneSnapshot(project).catch(() => null),
  ]);
  let extensionVersion: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(
      join(project.root, '.yuanmeng-inspector', 'bin', 'cli-launcher.json'),
      'utf8',
    )) as Record<string, unknown>;
    if (manifest.projectInstanceId === project.projectInstanceId
      && typeof manifest.extensionVersion === 'string'
      && manifest.extensionVersion.length <= 64) extensionVersion = manifest.extensionVersion;
  } catch {
    // 反馈箱在启动器尚未生成或清单损坏时也必须可用；版本保持未知。
  }
  return {
    projectInstanceId: project.projectInstanceId,
    extensionVersion,
    uiSnapshotId: uiSnapshot?.snapshotId ?? null,
    sceneSnapshotId: sceneSnapshot?.snapshotId ?? null,
  };
}

async function runFeedback(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'feedback' }>,
): Promise<CliRunResult> {
  if (args.action === 'add') {
    const entry = await addFeedback(project.root, {
      kind: args.kind,
      title: args.title,
      message: args.message,
      source: 'ai',
      context: await feedbackContext(project),
    }, nodeFileIO);
    return result('OK', `反馈已写入本机反馈箱：${entry.feedbackId.slice(0, 12)}`, { entry });
  }
  if (args.action === 'resolve') {
    const entry = await resolveFeedback(project.root, args.feedbackId, { resolution: args.resolution }, nodeFileIO);
    return result('OK', `反馈已标记为已处理：${entry.feedbackId.slice(0, 12)}`, { entry });
  }
  const listed = await listFeedback(project.root, { status: args.status, kind: args.kind }, nodeFileIO);
  return result('OK', `反馈箱共 ${listed.summary.total} 条，未处理 ${listed.summary.open} 条；本次返回 ${listed.entries.length} 条。`, listed);
}

async function runListIds(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'list-ids' }>): Promise<CliRunResult> {
  const status = await loadStatus(project);
  const freshness = status?.ui.freshness ?? 'stale';
  const ignoresUiFreshness = args.kind === 'scene-instance'
    || args.kind === 'element-type'
    || args.kind === 'scene-layer';
  if (!ignoresUiFreshness && freshness !== 'fresh' && !args.allowStale) {
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
      return result('OK', '注册中心尚无记录。', { freshness, records: [] }, freshness === 'fresh' || ignoresUiFreshness ? [] : ['注册中心数据可能陈旧']);
    }
    throw error;
  }
  const records = store.list({
    ...(args.kind === null ? {} : { kind: args.kind }),
    ...(args.environment === null ? {} : { environment: args.environment }),
    ...(args.validity === null ? {} : { validity: args.validity }),
  }).filter((record) => record.projectInstanceId === project.projectInstanceId);
  return result('OK', `注册中心返回 ${records.length} 条记录。`, { freshness, records }, freshness === 'fresh' || ignoresUiFreshness ? [] : ['注册中心数据可能陈旧']);
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
  const [uiSnapshot, sceneSnapshot] = await Promise.all([
    loadCurrentSnapshot(project).catch(() => null),
    loadPreferredSceneSnapshot(project).catch(() => null),
  ]);
  const resolvedUi = uiSnapshot === null ? { kind: 'not-found' as const } : resolveUiByNameOrPath(uiSnapshot, args.query);
  const uiMatches = resolvedUi.kind === 'unique' ? [resolvedUi.node]
    : resolvedUi.kind === 'ambiguous' ? resolvedUi.candidates : [];
  const registryMatches = records.filter((record) => record.value === args.query || record.name === args.query);
  const sceneMatches = sceneSnapshot?.instances.filter((instance) => (
    instance.instanceId === args.query || instance.elementTypeId === args.query || instance.ownerId === args.query
    || (instance.signals.state === 'observed' && instance.signals.value.some((signal) => signal.name === args.query))
  )) ?? [];
  const linkedValues = new Set([args.query, ...uiMatches.map((node) => node.id), ...registryMatches.map((record) => record.value)]);
  const matchesByLocation = new Map<string, ReturnType<typeof whereUsed>[number]>();
  for (const value of linkedValues) {
    for (const match of whereUsed(index, { value, ...(args.kind === null ? {} : { kind: args.kind }) })) {
      matchesByLocation.set(`${match.path}:${match.line}:${match.column}:${match.kind}:${match.value}`, match);
    }
  }
  const matches = [...matchesByLocation.values()].sort((left, right) => left.path.localeCompare(right.path, 'en') || left.line - right.line || left.column - right.column);
  const affectedFiles = [...new Set(matches.map((match) => match.path))];
  const sides = [...new Set(index.files.filter((file) => affectedFiles.includes(file.path)).map((file) => file.side.value))].sort();
  const impact = {
    evidence: 'STATIC_LOCAL',
    scope: 'direct-references-only',
    uiResolution: resolvedUi.kind,
    ui: uiMatches.slice(0, 20).map(({ id, name, path, parentId }) => ({ id, name, path, parentId })),
    scene: sceneMatches.slice(0, 20).map(({ instanceId, elementTypeId, ownerId }) => ({ instanceId, elementTypeId, ownerId })),
    registry: registryMatches.slice(0, 20).map(({ kind, name, value, validity }) => ({ kind, name, value, validity })),
    counts: { ui: uiMatches.length, scene: sceneMatches.length, registry: registryMatches.length, luaReferences: matches.length },
    affectedFiles,
    sides,
    checks: [
      ...(sides.some((side) => side === 'server' || side === 'shared') ? ['修改后检查玩家身份、共享状态和多人隔离。'] : []),
      ...(uiMatches.length > 0 || sceneMatches.length > 0 ? ['涉及对象表现时需要官方编辑器验证。'] : []),
      ...(resolvedUi.kind === 'ambiguous' || sceneMatches.length > 1 ? ['存在多个候选；先消歧再修改，不能按第一个结果执行。'] : []),
    ],
  };
  if (matches.length === 0 && uiMatches.length === 0 && sceneMatches.length === 0 && registryMatches.length === 0) {
    return result('NOT_FOUND', '未找到匹配的 Lua 引用。', {
      query: args.query,
      kind: args.kind,
      results: [],
      impact,
    });
  }
  return result('OK', `找到 ${matches.length} 处 Lua 引用。`, {
    query: args.query,
    kind: args.kind,
    results: matches,
    impact,
  });
}

async function runApiSearch(args: Extract<CliArgs, { command: 'api-search' }>): Promise<CliRunResult> {
  const [index, resourceCatalog, blockCatalog, toolboxCatalog] = await Promise.all([
    loadOfficialApiIndexFromEnvironment(),
    loadLocalResourceCatalog(process.env.YMAI_RESOURCE_DOC_PATH?.trim() || null),
    loadDreamCodeApiCatalog({
      extensionsRoot: process.env.VSCODE_EXTENSIONS
        ?? (process.env.USERPROFILE === undefined ? null : join(process.env.USERPROFILE, '.vscode', 'extensions')),
      extensionPath: process.env.YMAI_DREAMCODE_EXTENSION_PATH?.trim() || null,
    }),
    loadDreamCodeToolboxCatalog({
      extensionsRoot: process.env.VSCODE_EXTENSIONS
        ?? (process.env.USERPROFILE === undefined ? null : join(process.env.USERPROFILE, '.vscode', 'extensions')),
      extensionPath: process.env.YMAI_DREAMCODE_EXTENSION_PATH?.trim() || null,
    }),
  ]);
  const allResults = searchApiSymbols(index, args.query, 1_000);
  const allResources = resourceCatalog === null ? [] : searchResourceCatalog(resourceCatalog, args.query);
  const results = allResults.slice(0, args.limit);
  const resources = allResources.slice(0, args.limit);
  const allBlockResults = searchBlockApiCatalog(blockCatalog, args.query, 1_000);
  const blockResults = allBlockResults.slice(0, args.limit);
  const allToolboxResults = toolboxCatalog.entries.filter((entry) => entry.symbol.toLocaleLowerCase().includes(args.query.trim().toLocaleLowerCase()));
  const toolboxResults = allToolboxResults.slice(0, args.limit);
  const eventDocumentation = await loadLocalEventDocumentation(process.env.YMAI_EVENTS_DOC_PATH?.trim() || null);
  const events = new Map(resolveEventMetadata(index, eventDocumentation).map((event) => [event.name, event]));
  const enrichedResults = results.map((symbol) => symbol.kind === 'constant' && symbol.module === 'Events'
    ? { ...symbol, eventMetadata: events.get(symbol.name) ?? null }
    : symbol);
  if (allResults.length === 0 && allResources.length === 0 && allBlockResults.length === 0 && allToolboxResults.length === 0) {
    return result('NOT_FOUND', '当前官方 API 声明和本地通用数据定义中未找到匹配项。', {
      officialExtensionVersion: index.officialExtensionVersion,
      eventDocumentationState: eventDocumentation === null ? 'missing' : 'loaded-unversioned-local-doc',
      results: [],
      resources: [],
      blockApiCatalogState: blockCatalog.state,
      blockApiExtensionVersion: blockCatalog.extensionVersion,
      blockResults: [],
      blockToolboxCatalogState: toolboxCatalog.state,
      blockToolboxExtensionVersion: toolboxCatalog.extensionVersion,
      blockToolboxResults: [],
    });
  }
  const truncated = allResults.length > results.length || allResources.length > resources.length || allBlockResults.length > blockResults.length || allToolboxResults.length > toolboxResults.length;
  return result('OK', `找到 ${results.length} 个官方 API 声明、${resources.length} 个通用资源条目、${blockResults.length} 个编程元件 API 条目、${toolboxResults.length} 个工具箱符号。`, {
    officialExtensionVersion: index.officialExtensionVersion,
    eventDocumentationState: eventDocumentation === null ? 'missing' : 'loaded-unversioned-local-doc',
    results: enrichedResults,
    resourceDocumentationState: resourceCatalog === null ? 'missing' : 'loaded-unversioned-local-doc',
    resourceIssues: resourceCatalog?.issues ?? [],
    resources,
    blockApiCatalogState: blockCatalog.state,
    blockApiExtensionVersion: blockCatalog.extensionVersion,
    blockApiSource: blockCatalog.source,
    blockApiCategories: blockCatalog.categories,
    blockResults,
    blockToolboxCatalogState: toolboxCatalog.state,
    blockToolboxExtensionVersion: toolboxCatalog.extensionVersion,
    blockToolboxSource: toolboxCatalog.source,
    blockToolboxResults: toolboxResults,
    resultLimit: args.limit,
    truncated,
  }, truncated ? [`结果已限制为每类最多 ${args.limit} 条；缩小查询或提高 --limit 可查看更多。`] : []);
}

async function runOfficialAudit(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'official-audit' }>): Promise<CliRunResult> {
  const audit = await runOfficialReverseAudit({
    projectRoot: project.root,
    officialExtensionPath: process.env.YMAI_OFFICIAL_EXTENSION_PATH ?? null,
    dreamCodeExtensionPath: process.env.YMAI_DREAMCODE_EXTENSION_PATH ?? null,
    ugcDataPath: process.env.YMAI_UGC_DATA_PATH ?? null,
  });
  if (args.saveBaseline) {
    if (audit.currentApi === null) return offline('未检测到可保存的官方 API，基线未写入。', { report: audit.report });
    await saveOfficialApiBaseline(project.root, audit.currentApi);
    return result('OK', '官方 API 基线已保存到插件私有目录；地图工程文件未修改。', {
      ...audit.report,
      baselineSaved: true,
    });
  }
  return result('OK', '官方来源静态审查完成；未修改地图工程文件。', audit.report);
}

async function runAudit(project: ResolvedCliProject, args: Extract<CliArgs, { command: 'audit' }>): Promise<CliRunResult> {
  const [status, snapshot] = await Promise.all([
    loadStatus(project),
    loadCurrentSnapshot(project),
  ]);
  const audit = await auditProject({
    root: project.root,
    projectInstanceId: project.projectInstanceId,
    status,
    snapshot,
    files: args.files,
    errorsOnly: args.errorsOnly,
  });
  const scopeLabel = audit.scope.mode === 'targeted' ? '定向工程审计' : '全量工程审计';
  const evidenceLabel = audit.scope.fullProjectEvidence ? '' : '（仅限所列文件，不代表全项目通过）';
  return result('OK', `${scopeLabel}完成${evidenceLabel}：${audit.issueCounts.error} 个错误，${audit.issueCounts.warning} 个警告。`, audit);
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
  if (args.subject === 'scene' || args.subject === 'scene-ai') {
    const sceneSnapshot = await loadPreferredSceneSnapshot(project);
    if (sceneSnapshot === null) return offline('没有可导出的场景快照。');
    const outputPath = resolve(cwd, args.out);
    await mkdir(dirname(outputPath), { recursive: true });
    if (args.subject === 'scene-ai') {
      if (args.format === 'csv') throw new ProductError('USAGE_ERROR', 'scene-ai 只支持 json 或 md。', ['改用 --format json 或 md。'], 'STATIC_LOCAL');
      const context = buildSceneAiContext({
        projectFingerprint: project.projectRootHash,
        snapshot: sceneSnapshot,
        query: { kind: 'all-scene', value: sceneSnapshot.snapshotId },
        matches: sceneSnapshot.instances,
        nextActions: ['按 query/result 指纹在本机插件中继续消歧；需要画面结论时进入官方编辑器复核。'],
      });
      await writeFile(outputPath, renderSceneAiContext(context, args.format), 'utf8');
    } else {
      await writeFile(outputPath, renderSceneExport(sceneSnapshot, args.format), 'utf8');
    }
    return result('OK', args.subject === 'scene-ai' ? '场景 AI 脱敏上下文已导出。' : '场景清单已导出。', {
      format: args.format,
      out: safeReportedPath(project.root, outputPath),
      snapshotId: sceneSnapshot.snapshotId,
      subject: args.subject,
    });
  }
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
      case 'set-map-name':
        return runSetMapName(project, args);
      case 'refresh-ui':
        return runRefreshUi(project, args, dependencies.clock ?? systemClock);
      case 'find-ui':
        return runFindUi(project, args);
      case 'resolve-ui':
        return runResolveUi(project, args);
      case 'ui-inspect-point':
        return runUiInspectPoint(project, args);
      case 'ui-runtime-widgets':
        return runUiRuntimeWidgets(project, args);
      case 'runtime-probe':
        return runControlledRuntimeProbe(project, args);
      case 'ui-screen-snapshot':
      case 'ui-tree-screen-snapshot':
      case 'ui-layout-audit':
        return await runUiRuntimeGeometry(project, args);
      case 'list-ids':
        return runListIds(project, args);
      case 'where-used':
        return runWhereUsed(project, args);
      case 'api-search':
        return runApiSearch(args);
      case 'official-audit':
        return runOfficialAudit(project, args);
      case 'audit':
        return await runAudit(project, args);
      case 'gameplay-review':
        return await runGameplayReview(project, args, cwd);
      case 'gameplay-test':
        return await runGameplayTest(project, args, cwd, dependencies.signal);
      case 'feedback':
        return await runFeedback(project, args);
      case 'scene-status':
        return await runSceneStatus(project);
      case 'bind-scene':
        return await runBindScene(project, args, cwd);
      case 'refresh-scene':
        return await runRefreshScene(project, args);
      case 'find-scene':
        return await runFindScene(project, args);
      case 'scene-tree':
        return await runSceneTree(project, args);
      case 'field-inspect':
        return await runFieldInspect(project, args);
      case 'group-members':
        return await runGroupMembers(project, args);
      case 'scene-diff':
        return await runSceneDiff(project, args);
      case 'scene-near':
        return await runSceneNear(project, args);
      case 'scene-audit':
        return await runSceneAudit(project, args);
      case 'scene-types':
        return await runSceneTypes(project);
      case 'scene-capabilities':
        return await runSceneCapabilities(project, args);
      case 'scene-geometry':
        return await runSceneGeometry(project, args);
      case 'scene-plan':
        return await runScenePlan(project, args);
      case 'scene-journal':
        return await runSceneJournal(project, args);
      case 'property-locate':
        return await runPropertyLocate(project, args);
      case 'diff-ui':
        return runDiffUi(project, args);
      case 'export':
        return runExport(project, args, cwd);
    }
  } catch (error) {
    if (error instanceof ProductError && error.code === 'NOT_FOUND') {
      return result('NOT_FOUND', error.message, { reasonCode: error.code, nextActions: [...error.nextActions] });
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

if (
  typeof require !== 'undefined'
  && require.main === module
  && basename(process.argv[1] ?? '').toLowerCase() === 'cli.cjs'
) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
