import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { CliArgs } from './args.js';
import { result, type CliRunResult } from './output.js';
import { loadPreferredSceneSnapshot } from './scene.js';
import type { ResolvedCliProject } from './project.js';
import { ProductError } from '../core/errors.js';
import { nodeFileIO } from '../core/fs.js';
import type { ApiIndex } from '../core/api/declaration-index.js';
import { buildLuaApiKnowledge } from '../core/api/lua-knowledge.js';
import { analyzeProject, type ProjectDiagnostic } from '../core/diagnostics/analyzer.js';
import { stableJson } from '../core/hash.js';
import {
  refreshGameplayEvidence,
  reviewGameplayEventDocumentation,
  reviewGameplaySceneEventBindings,
} from '../core/gameplay/model.js';
import {
  createGameplayCodexReviewPackage,
  renderGameplayCodexReviewMarkdown,
} from '../core/gameplay/report.js';
import { parseGameplayModel, parseGameplayScenario } from '../core/gameplay/scenario-schema.js';
import type { GameplayScenario } from '../core/gameplay/types.js';
import { runGameplayWorkflow } from '../core/gameplay/workflow.js';
import { buildGameplaySourceContext } from '../core/gameplay/source-context.js';
import type { LuaSourceFile } from '../core/lua/source-index.js';
import { RegistryStore } from '../core/registry/store.js';
import type { RegistryDocument, UiSnapshot } from '../core/model.js';
import { loadStoredCapabilityEvidenceIndex } from '../core/scene/probe-evidence.js';
import { loadOfficialApiIndexFromEnvironment } from '../integrations/official/api-index-loader.js';
import { loadLocalEventMetadata } from '../integrations/official/event-doc-source.js';

const EMPTY_API_INDEX: ApiIndex = {
  schemaVersion: 2,
  officialExtensionVersion: 'unavailable',
  declarations: [],
  constants: [],
  enums: [],
};

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProductError('VALIDATION_FAILED', '玩法 JSON 语法无效。', ['修复 JSON 后重新运行静态审查。'], 'STATIC_LOCAL', error);
    throw error;
  }
}

function inputPath(project: ResolvedCliProject, cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(value.startsWith('.') ? cwd : project.root, value);
}

async function readModel(project: ResolvedCliProject, cwd: string, path: string) {
  const value = await readJson(inputPath(project, cwd, path));
  return parseGameplayModel(value);
}

async function readScenarios(project: ResolvedCliProject, cwd: string, directory: string): Promise<GameplayScenario[]> {
  const root = inputPath(project, cwd, directory);
  const filenames = (await readdir(root)).filter((name) => name.endsWith('.json')).sort((left, right) => left.localeCompare(right, 'en'));
  if (filenames.length > 32) throw new Error('玩法场景文件超过 32 个上限。');
  return Promise.all(filenames.map(async (filename) => {
    const value = await readJson(join(root, filename));
    return parseGameplayScenario(value);
  }));
}

async function collectLuaFiles(root: string): Promise<LuaSourceFile[]> {
  const files: LuaSourceFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.lua') && !/^Custom(?:UIData|Property_).*\.lua$/u.test(entry.name)) {
        files.push({ path: relative(root, path).replace(/\\/gu, '/'), source: await readFile(path, 'utf8') });
        if (files.length > 10_000) throw new ProductError('LUA_LIMIT_EXCEEDED', 'Lua 文件数量超过索引上限。', ['缩小工程源码范围。'], 'STATIC_LOCAL');
      }
    }
  };
  await visit(join(root, 'src'));
  return files;
}

async function currentProjectBinding(project: ResolvedCliProject) {
  let mapFingerprint: string | null = null;
  try {
    const status = await readJson(join(project.root, '.yuanmeng-inspector', 'status.json'));
    if (typeof status === 'object' && status !== null && !Array.isArray(status)) {
      const projectValue = (status as { project?: unknown }).project;
      if (typeof projectValue === 'object' && projectValue !== null && !Array.isArray(projectValue)) {
        const candidate = (projectValue as { mapFingerprint?: unknown }).mapFingerprint;
        if (candidate === null || (typeof candidate === 'string' && /^[a-f0-9]{64}$/u.test(candidate))) mapFingerprint = candidate;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const snapshot = await loadPreferredSceneSnapshot(project);
  let registry: RegistryDocument = { schemaVersion: 1, records: [] };
  try {
    registry = { schemaVersion: 1, records: (await RegistryStore.open(join(project.root, '.yuanmeng-inspector', 'registry', 'registry.json'))).list() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let uiSnapshot: UiSnapshot | null = null;
  try {
    const candidate = await readJson(join(project.root, '.yuanmeng-inspector', 'ui', 'current.json'));
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || (candidate as Partial<UiSnapshot>).schemaVersion !== 1
      || (candidate as Partial<UiSnapshot>).projectInstanceId !== project.projectInstanceId
      || typeof (candidate as Partial<UiSnapshot>).snapshotId !== 'string') {
      throw new ProductError('VALIDATION_FAILED', '当前 UI 快照无效。', ['刷新 UI 快照后重试。'], 'STATIC_LOCAL');
    }
    uiSnapshot = candidate as UiSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const luaFiles = await collectLuaFiles(project.root);
  let apiIndex = EMPTY_API_INDEX;
  const apiDiagnostics: ProjectDiagnostic[] = [];
  try {
    apiIndex = await loadOfficialApiIndexFromEnvironment();
  } catch {
    apiDiagnostics.push({
      code: 'OFFICIAL_API_UNAVAILABLE',
      severity: 'warning',
      message: '当前 CLI 未能加载官方 API 声明，API 调用检查证据不足。',
      nextAction: '安装/启用官方元梦开发扩展，或设置 YMAI_OFFICIAL_EXTENSION_PATH 后重试。',
      path: null,
      range: null,
      evidence: 'STATIC_LOCAL',
      runtimeVerified: false,
    });
  }
  const projectBase = { projectInstanceId: project.projectInstanceId, mapFingerprint, sceneSnapshotId: snapshot?.snapshotId ?? null };
  const runtimeCapabilities = snapshot === null ? new Map() : await loadStoredCapabilityEvidenceIndex(project.root, {
    projectInstanceId: project.projectInstanceId,
    bindingId: snapshot.bindingId,
    snapshotId: snapshot.snapshotId,
    sceneSourceSha256: snapshot.sourceSha256,
  }, nodeFileIO);
  const sourceContext = buildGameplaySourceContext({
    project: projectBase,
    luaFiles,
    registry,
    apiKnowledge: buildLuaApiKnowledge(apiIndex),
    uiSnapshot,
    sceneSnapshot: snapshot,
    runtimeCapabilities,
  });
  const diagnostics = [
    ...apiDiagnostics,
    ...sourceContext.syntaxDiagnostics,
    ...analyzeProject({
      sourceIndex: sourceContext.sourceIndex,
      registry,
      apiIndex,
      uiSnapshot,
      status: null,
      projectInstanceId: project.projectInstanceId,
      mapFingerprint,
    }),
  ];
  const eventMetadata = await loadLocalEventMetadata(apiIndex, process.env.YMAI_EVENTS_DOC_PATH?.trim() || null);
  return {
    diagnostics,
    luaFiles,
    sourceIndex: sourceContext.sourceIndex,
    registry,
    uiSnapshot,
    sceneSnapshot: snapshot,
    runtimeCapabilities,
    eventMetadata,
    currentProject: sourceContext.currentProject,
  };
}

async function writeReview(outputRoot: string, review: ReturnType<typeof createGameplayCodexReviewPackage>): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(join(outputRoot, 'codex-review.json'), stableJson(review), 'utf8'),
    writeFile(join(outputRoot, 'codex-review.md'), renderGameplayCodexReviewMarkdown(review), 'utf8'),
  ]);
}

export async function runGameplayReview(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'gameplay-review' }>,
  cwd: string,
): Promise<CliRunResult> {
  const model = await readModel(project, cwd, args.modelPath);
  if (model.project.projectInstanceId !== project.projectInstanceId) {
    return result('VALIDATION_FAILED', '玩法模型属于另一个工程；拒绝生成可能串图的审查包。', { reasonCode: 'CURRENT_PROJECT_BINDING_MISMATCH', evidence: 'STATIC_LOCAL' });
  }
  const context = await currentProjectBinding(project);
  const evidence = refreshGameplayEvidence(model, context.currentProject);
  const currentModel = evidence.model;
  const gameplayDiagnostics = [
    ...context.diagnostics,
    ...reviewGameplaySceneEventBindings(currentModel, context.sceneSnapshot, context.runtimeCapabilities, context.sourceIndex),
    ...reviewGameplayEventDocumentation(currentModel, context.eventMetadata),
  ];
  const review = createGameplayCodexReviewPackage(currentModel, gameplayDiagnostics, currentModel.project, context.eventMetadata);
  const outputRoot = resolve(cwd, args.out);
  await writeReview(outputRoot, review);
  const code = review.staticGate.status === 'blocked' ? 'VALIDATION_FAILED' : 'OK';
  return result(code, review.staticGate.status === 'blocked' ? '静态门存在阻断错误；未进入玩法模拟。' : 'Codex 脱敏审查包已生成；尚未运行玩法模拟。', {
    reviewPackageId: review.packageId,
    staticGate: review.staticGate.status,
    outputs: ['codex-review.json', 'codex-review.md'],
    evidence: 'STATIC_LOCAL',
    evidenceRefreshed: evidence.refreshed,
    refreshedEvidenceFields: evidence.changedKeys,
  }, evidence.refreshed ? ['已自动刷新当前 Lua/UI/场景证据元数据；玩法语义仍来自已确认 spec.json。'] : []);
}

export async function runGameplayTest(
  project: ResolvedCliProject,
  args: Extract<CliArgs, { command: 'gameplay-test' }>,
  cwd: string,
  signal?: AbortSignal,
): Promise<CliRunResult> {
  const context = await currentProjectBinding(project);
  const manual = args.mode === 'manual'
    ? {
      model: await readModel(project, cwd, args.modelPath),
      scenarios: await readScenarios(project, cwd, args.scenarioDirectory),
      outputRoot: resolve(cwd, args.out),
    }
    : undefined;
  const workflow = await runGameplayWorkflow({
    root: project.root,
    mode: args.mode,
    currentProject: context.currentProject,
    luaFiles: context.luaFiles,
    strictDiagnostics: context.diagnostics,
    strictPreparationFindings: [],
    sourceIndex: context.sourceIndex,
    eventMetadata: context.eventMetadata,
    registry: context.registry,
    uiSnapshot: context.uiSnapshot,
    sceneSnapshot: context.sceneSnapshot,
    runtimeCapabilities: context.runtimeCapabilities,
    ...(manual === undefined ? {} : { manual }),
    ...(args.mode === 'auto' ? { focus: { text: args.focus, changedFiles: [...args.changedFiles] } } : {}),
    ...(args.mode === 'auto' ? { persist: args.preview !== true } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  const success = workflow.classification === 'model-pass' || workflow.classification === 'partial-needs-editor';
  const report = workflow.report;
  const runId = workflow.run?.manifest.runId ?? null;
  const outputs = args.mode === 'auto'
    ? (runId === null ? [] : [`.yuanmeng-inspector/gameplay/runs/${runId}`])
    : report === null
      ? ['codex-review.json', 'codex-review.md']
      : ['codex-review.json', 'codex-review.md', 'gameplay-report.json', 'gameplay-report.md'];
  return result(
    success ? 'OK' : 'VALIDATION_FAILED',
    workflow.classification === 'not-run-fatal'
      ? '自动准备或手工输入存在致命问题；未执行玩法模型。'
      : `玩法模型运行完成：${workflow.classification}；真实引擎与多人房间仍需官方编辑器验证。`,
    {
      mode: args.mode,
      preview: args.mode === 'auto' && args.preview === true,
      runId,
      classification: workflow.classification,
      status: report?.status ?? 'blocked',
      reportId: report?.reportId ?? null,
      populations: report?.populations.map((population) => ({
      playerCount: population.playerCount,
      status: population.status,
      schedulesExplored: population.schedulesExplored,
      truncated: population.truncated,
      })) ?? [],
      outputs,
      evidence: report === null
        ? ['STATIC_LOCAL']
        : ['STATIC_LOCAL', 'UNIT_E2E', `SCENE_EVIDENCE:${report.evidence.sceneEvidence}`, 'OFFICIAL_EDITOR_MULTI_REQUIRED'],
      strictStaticGate: workflow.strictReview.staticGate.status,
      simulationGate: workflow.simulationGate.status,
      latestUpdated: args.mode === 'auto' && runId !== null,
      modelFingerprint: workflow.modelFingerprint,
      scenarioFingerprint: workflow.scenarioFingerprint,
      skippedFlows: workflow.skippedFlows,
    },
    [
      ...(workflow.classification === 'partial-needs-editor' ? ['模型模拟未替代官方编辑器多人实测；部分流程或引擎证据仍需补测。'] : []),
      ...(workflow.strictReview.staticGate.status === 'blocked' && workflow.simulationGate.status === 'pass'
        ? ['严格静态审查仍保留全工程问题；本次只执行可安全建模的生产流程。'] : []),
    ],
  );
}
