import { basename, join, relative } from 'node:path';
import { readdir } from 'node:fs/promises';

import * as vscode from 'vscode';

import { analyzeProject } from '../core/diagnostics/analyzer.js';
import { ProductError } from '../core/errors.js';
import { atomicWriteJson, nodeFileIO } from '../core/fs.js';
import {
  buildGameplayKnowledgeDraft,
  gameplayModelFingerprint,
  isGameplayEvidenceSatisfied,
  refreshGameplayEvidence,
  reviewGameplayEventDocumentation,
  reviewGameplaySceneEventBindings,
} from '../core/gameplay/model.js';
import {
  createGameplayCodexReviewPackage,
} from '../core/gameplay/report.js';
import { gameplayClassificationLabel } from '../core/gameplay/display.js';
import { parseGameplayModel, parseGameplayScenario } from '../core/gameplay/scenario-schema.js';
import { createNodeGameplayRunStoreIO, GameplayRunStore } from '../core/gameplay/run-store.js';
import { buildGameplaySourceContext } from '../core/gameplay/source-context.js';
import type { GameplayKnowledgeDraft, GameplayModel, GameplayRunClassification, GameplayScenario, GameplayTestReport } from '../core/gameplay/types.js';
import { runGameplayWorkflow } from '../core/gameplay/workflow.js';
import { stableJson } from '../core/hash.js';
import type { buildLuaSourceIndex, LuaSourceFile } from '../core/lua/source-index.js';
import type { RegistryDocument } from '../core/model.js';
import type { SceneController } from './scene-controller.js';
import type { WorkspaceContextManager } from './workspaces.js';
import { apiKnowledge, loadApiIndex } from './language-features.js';
import { loadLocalEventDocumentation } from '../integrations/official/event-doc-source.js';
import { resolveEventMetadata } from '../core/api/event-doc-index.js';
const POPULATIONS = [1, 2, 4, 8] as const;

function textFor(error: unknown): string {
  if (error instanceof ProductError) return `${error.message}${error.nextActions[0] === undefined ? '' : `\n下一步：${error.nextActions[0]}`}`;
  return error instanceof Error ? error.message : '未知玩法测试错误';
}

function assertGameplayModel(value: unknown): asserts value is GameplayModel {
  parseGameplayModel(value);
}

function assertGameplayScenario(value: unknown): asserts value is GameplayScenario {
  parseGameplayScenario(value);
}

function assertKnowledgeDraft(value: unknown): asserts value is GameplayKnowledgeDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Partial<GameplayKnowledgeDraft>).schemaVersion !== 1) {
    throw new ProductError('VALIDATION_FAILED', '玩法知识草案无效。', ['重新生成玩法草案。'], 'STATIC_LOCAL');
  }
}

function assertGameplayReport(value: unknown): asserts value is GameplayTestReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Partial<GameplayTestReport>).schemaVersion !== 1) {
    throw new ProductError('VALIDATION_FAILED', '玩法测试报告无效。', ['重新运行玩法矩阵。'], 'STATIC_LOCAL');
  }
}

async function collectLuaFiles(root: string): Promise<LuaSourceFile[]> {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'src/**/*.lua'), undefined, 10_001);
  if (uris.length > 10_000) throw new ProductError('LUA_LIMIT_EXCEEDED', 'Lua 文件数量超过 10000 个上限。', ['缩小工程源码范围。'], 'STATIC_LOCAL');
  const files: LuaSourceFile[] = [];
  for (const uri of uris.sort((left, right) => left.fsPath.localeCompare(right.fsPath, 'en'))) {
    if (/^Custom(?:UIData|Property_).*\.lua$/u.test(basename(uri.fsPath))) continue;
    files.push({
      path: relative(root, uri.fsPath).replace(/\\/gu, '/'),
      source: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
    });
  }
  return files;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await nodeFileIO.readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProductError('VALIDATION_FAILED', '玩法 JSON 语法无效。', ['修复 JSON 后重试。'], 'STATIC_LOCAL', error);
    throw error;
  }
}

async function readConfirmedInputs(root: string): Promise<{ model: GameplayModel; scenarios: GameplayScenario[] }> {
  const gameplayRoot = join(root, '.yuanmeng-inspector', 'gameplay');
  const model = parseGameplayModel(await readJson(join(gameplayRoot, 'spec.json')));
  const scenarioRoot = join(gameplayRoot, 'scenarios');
  let filenames: string[];
  try {
    filenames = (await readdir(scenarioRoot)).filter((name) => name.endsWith('.json')).sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ProductError('NOT_FOUND', '尚未创建已确认的玩法场景目录。', ['从 scenario-drafts 复制、补全并确认 1/2/4/8 人场景。'], 'STATIC_LOCAL');
    throw error;
  }
  if (filenames.length > 32) throw new ProductError('VALIDATION_FAILED', '玩法场景文件超过 32 个上限。', ['删除无关场景。'], 'STATIC_LOCAL');
  const scenarios = await Promise.all(filenames.map(async (filename) => parseGameplayScenario(await readJson(join(scenarioRoot, filename)))));
  return { model, scenarios };
}

async function openText(path: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(document, { preview: true });
}

async function projectAnalysis(
  manager: WorkspaceContextManager,
  root: string,
  sourceIndex: ReturnType<typeof buildLuaSourceIndex>,
  apiIndex: Awaited<ReturnType<typeof loadApiIndex>>,
) {
  const context = manager.get(root);
  const registry: RegistryDocument = { schemaVersion: 1, records: await manager.listRegistry(root) };
  return analyzeProject({
    sourceIndex, registry, apiIndex, uiSnapshot: context.snapshot, status: context.status,
    projectInstanceId: context.project.projectInstanceId, mapFingerprint: context.project.mapFingerprint,
  });
}

async function currentGameplayContext(
  manager: WorkspaceContextManager,
  sceneController: SceneController,
  root: string,
) {
  const managed = manager.get(root);
  const registry: RegistryDocument = { schemaVersion: 1, records: await manager.listRegistry(root) };
  const luaFiles = await collectLuaFiles(root);
  const apiIndex = await loadApiIndex();
  const eventDocumentation = await loadLocalEventDocumentation(
    vscode.workspace.getConfiguration('yuanmengAi').get<string>('eventsDocumentationPath', '').trim() || null,
  );
  const eventMetadata = new Map(resolveEventMetadata(apiIndex, eventDocumentation).map((event) => [event.name, event]));
  const sceneState = sceneController.get(root);
  const sceneSnapshot = sceneState.snapshot;
  const runtimeCapabilities = sceneState.runtimeCapabilities;
  const projectBase = {
    projectInstanceId: managed.project.projectInstanceId,
    mapFingerprint: managed.project.mapFingerprint,
    sceneSnapshotId: sceneSnapshot?.snapshotId ?? null,
  };
  const sourceContext = buildGameplaySourceContext({
    project: projectBase,
    luaFiles,
    registry,
    apiKnowledge: apiKnowledge(apiIndex),
    uiSnapshot: managed.snapshot,
    sceneSnapshot,
    runtimeCapabilities,
  });
  const diagnostics = [
    ...sourceContext.syntaxDiagnostics,
    ...await projectAnalysis(manager, root, sourceContext.sourceIndex, apiIndex),
  ];
  return {
    managed, registry, luaFiles, sourceIndex: sourceContext.sourceIndex, diagnostics, sceneSnapshot, runtimeCapabilities, eventMetadata,
    projectBase, currentProject: sourceContext.currentProject,
  };
}

export interface GameplayViewSummary {
  mode: 'auto' | 'manual' | 'none';
  classification: GameplayRunClassification | null;
  latestCurrent: boolean;
  latestState: 'current' | 'stale' | 'missing';
  strictStaticGate: 'pass' | 'blocked' | 'not-run';
  simulationGate: 'pass' | 'blocked' | 'not-run';
  history: { count: number; bytes: number };
  specStatus: 'missing' | 'draft-only' | 'invalid' | 'fresh' | 'stale' | 'blocked';
  knowledgeFresh: boolean | null;
  staticGate: 'pass' | 'blocked' | 'not-run';
  populations: Array<{ playerCount: number; status: 'not-run' | 'stale' | GameplayTestReport['status'] }>;
  coverageRatio: number | null;
  truncated: boolean;
  firstMultiplayerFailure: { playerCount: number; code: string; stepIndex: number } | null;
  officialEditorRequirementKinds: string[];
  reportAvailable: boolean;
}

function emptyGameplaySummary(
  specStatus: GameplayViewSummary['specStatus'],
  history: GameplayViewSummary['history'] = { count: 0, bytes: 0 },
): GameplayViewSummary {
  return {
    mode: 'none',
    classification: null,
    latestCurrent: false,
    latestState: 'missing',
    strictStaticGate: 'not-run',
    simulationGate: 'not-run',
    history,
    specStatus,
    knowledgeFresh: null,
    staticGate: 'not-run',
    populations: POPULATIONS.map((playerCount) => ({ playerCount, status: 'not-run' })),
    coverageRatio: null,
    truncated: false,
    firstMultiplayerFailure: null,
    officialEditorRequirementKinds: [],
    reportAvailable: false,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await nodeFileIO.readFile(path, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Returns only aggregate, path-free state suitable for the persistent view/API. */
export async function inspectGameplayWorkspace(
  manager: WorkspaceContextManager,
  sceneController: SceneController,
  root: string,
): Promise<GameplayViewSummary> {
  manager.get(root);
  const gameplayRoot = join(root, '.yuanmeng-inspector', 'gameplay');
  const store = new GameplayRunStore({ io: createNodeGameplayRunStoreIO(nodeFileIO) });
  const history = await store.summarizeHistory(root);
  const specPath = join(gameplayRoot, 'spec.json');
  const specExists = await fileExists(specPath);
  const draftExists = await fileExists(join(gameplayRoot, 'spec.draft.json'));
  const latestExists = await fileExists(join(gameplayRoot, 'latest.json'));
  if (latestExists) {
    const current = await currentGameplayContext(manager, sceneController, root);
    const stored = await store.readCurrent(root, current.currentProject);
    if (stored !== null) {
      const model = parseGameplayModel(stored.artifacts['generated-spec.json']);
      const reportValue = stored.artifacts['simulation-report.json'];
      const report = reportValue === null ? null : reportValue;
      if (report !== null) assertGameplayReport(report);
      const populations = POPULATIONS.map((playerCount) => ({
        playerCount,
        status: report?.populations.find((entry) => entry.playerCount === playerCount)?.status ?? 'not-run' as const,
      }));
      const firstMultiplayerFailure = report?.populations
        .filter((entry) => entry.mode === 'multiplayer' && entry.firstFailure !== null)
        .sort((left, right) => left.playerCount - right.playerCount)
        .map((entry) => ({ playerCount: entry.playerCount, code: entry.firstFailure!.code, stepIndex: entry.firstFailure!.stepIndex }))[0] ?? null;
      return {
        mode: 'auto',
        classification: stored.manifest.classification,
        latestCurrent: true,
        latestState: 'current',
        strictStaticGate: stored.manifest.strictStaticGate,
        simulationGate: stored.manifest.simulationGate,
        history,
        specStatus: specExists ? 'fresh' : draftExists ? 'draft-only' : 'missing',
        knowledgeFresh: true,
        staticGate: stored.manifest.strictStaticGate,
        populations,
        coverageRatio: report?.coverage.ratio ?? null,
        truncated: report?.populations.some((entry) => entry.truncated) ?? false,
        firstMultiplayerFailure,
        officialEditorRequirementKinds: [...new Set(model.evidenceRequirements
          .filter((requirement) => !isGameplayEvidenceSatisfied(requirement))
          .map((requirement) => requirement.kind))].sort((left, right) => left.localeCompare(right, 'en')),
        reportAvailable: report !== null,
      };
    }
  }
  if (!specExists) {
    return emptyGameplaySummary(draftExists ? 'draft-only' : 'missing', history);
  }
  let model: GameplayModel;
  try {
    model = parseGameplayModel(await readJson(specPath));
  } catch {
    return emptyGameplaySummary('invalid', history);
  }
  const current = await currentGameplayContext(manager, sceneController, root);
  const gameplayDiagnostics = [
    ...current.diagnostics,
    ...reviewGameplayEventDocumentation(model, current.eventMetadata),
    ...reviewGameplaySceneEventBindings(model, current.sceneSnapshot, current.runtimeCapabilities, current.sourceIndex),
  ];
  const knowledgeFresh = stableJson(model.project) === stableJson(current.currentProject);
  const review = createGameplayCodexReviewPackage(model, gameplayDiagnostics, current.currentProject, current.eventMetadata);
  let report: GameplayTestReport | null = null;
  let reportAvailable = false;
  const reportPath = join(gameplayRoot, 'reports', 'current', 'gameplay-report.json');
  try {
    const value = await readJson(reportPath);
    assertGameplayReport(value);
    report = value;
    reportAvailable = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportAvailable = await fileExists(reportPath);
  }
  const currentReport = report !== null
    && report.modelId === model.modelId
    && report.modelFingerprint === gameplayModelFingerprint(model)
    && report.reviewPackageId === review.packageId
    && stableJson(report.project) === stableJson(current.currentProject)
    ? report
    : null;
  const populations = POPULATIONS.map((playerCount) => ({
    playerCount,
    status: currentReport !== null
      ? currentReport.populations.find((entry) => entry.playerCount === playerCount)?.status ?? 'not-run'
      : reportAvailable ? 'stale' as const : 'not-run' as const,
  }));
  const firstMultiplayerFailure = currentReport !== null
    ? currentReport.populations
      .filter((entry) => entry.mode === 'multiplayer' && entry.firstFailure !== null)
      .sort((left, right) => left.playerCount - right.playerCount)
      .map((entry) => ({ playerCount: entry.playerCount, code: entry.firstFailure!.code, stepIndex: entry.firstFailure!.stepIndex }))[0] ?? null
    : null;
  return {
    mode: currentReport === null ? 'none' : 'manual',
    classification: currentReport?.runSummary?.classification ?? (currentReport === null ? null
      : currentReport.status === 'pass' ? 'model-pass'
        : currentReport.status === 'fail' ? 'model-fail'
          : currentReport.status === 'needs-editor' ? 'partial-needs-editor' : 'not-run-fatal'),
    latestCurrent: false,
    latestState: latestExists ? 'stale' : 'missing',
    strictStaticGate: review.staticGate.status,
    simulationGate: currentReport === null ? 'not-run' : currentReport.status === 'blocked' ? 'blocked' : 'pass',
    history,
    specStatus: !knowledgeFresh ? 'stale' : review.staticGate.status === 'blocked' ? 'blocked' : 'fresh',
    knowledgeFresh,
    staticGate: review.staticGate.status,
    populations,
    coverageRatio: currentReport?.coverage.ratio ?? null,
    truncated: currentReport?.populations.some((entry) => entry.truncated) ?? false,
    firstMultiplayerFailure,
    officialEditorRequirementKinds: [...new Set(model.evidenceRequirements
      .filter((requirement) => !isGameplayEvidenceSatisfied(requirement))
      .map((requirement) => requirement.kind))].sort((left, right) => left.localeCompare(right, 'en')),
    reportAvailable,
  };
}

export function registerGameplayCommands(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  sceneController: SceneController,
): void {
  const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
      try {
        return await callback(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(textFor(error));
        throw error;
      }
    }));
  };

  register('yuanmengAi.generateGameplayDraft', async (root) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const current = await currentGameplayContext(manager, sceneController, managed.project.root);
    const draft = buildGameplayKnowledgeDraft({
      project: current.projectBase,
      knowledgeFingerprint: current.currentProject.knowledgeFingerprint,
      sourceIndex: current.sourceIndex,
      registry: current.registry,
      uiSnapshot: managed.snapshot,
      sceneSnapshot: current.sceneSnapshot,
      runtimeCapabilities: current.runtimeCapabilities,
      projectDiagnostics: current.diagnostics,
    });
    const gameplayRoot = join(managed.project.root, '.yuanmeng-inspector', 'gameplay');
    await Promise.all([
      atomicWriteJson(nodeFileIO, join(gameplayRoot, 'spec.draft.json'), draft.model, assertGameplayModel),
      atomicWriteJson(nodeFileIO, join(gameplayRoot, 'knowledge.draft.json'), draft, assertKnowledgeDraft),
      ...POPULATIONS.map(async (count) => {
        const scenario: GameplayScenario = {
          schemaVersion: 1,
          scenarioId: `draft-population-${count}`,
          name: `${count} 人待确认玩法场景`,
          modelBinding: { modelId: draft.model.modelId, modelFingerprint: gameplayModelFingerprint(draft.model), ...draft.model.project },
          players: Array.from({ length: count }, (_, index) => `p${index + 1}`),
          exploreReadyEventInterleavings: count > 1,
          limits: { maxEvents: 2_000, maxVirtualMilliseconds: 300_000, maxVisitedStates: 2_000, maxBranches: 2_000 },
          steps: [],
        };
        await atomicWriteJson(nodeFileIO, join(gameplayRoot, 'scenario-drafts', `${count}-player.draft.json`), scenario, assertGameplayScenario);
      }),
    ]);
    await openText(join(gameplayRoot, 'knowledge.draft.json'));
    void vscode.window.showInformationMessage('玩法知识草案已生成；所有信号语义、状态归属和场景用途仍需确认，未覆盖 spec.json。');
    return { committed: true, modelId: draft.model.modelId, assumptionCount: draft.assumptions.length };
  });

  register('yuanmengAi.runGameplayTests', async (root) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const current = await currentGameplayContext(manager, sceneController, managed.project.root);
    const workflow = await runGameplayWorkflow({
      root: managed.project.root,
      mode: 'auto',
      currentProject: current.currentProject,
      luaFiles: current.luaFiles,
      strictDiagnostics: current.diagnostics,
      strictPreparationFindings: [],
      sourceIndex: current.sourceIndex,
      eventMetadata: current.eventMetadata,
      registry: current.registry,
      uiSnapshot: managed.snapshot,
      sceneSnapshot: current.sceneSnapshot,
      runtimeCapabilities: current.runtimeCapabilities,
    });
    const runId = workflow.run!.manifest.runId;
    await openText(join(managed.project.root, '.yuanmeng-inspector', 'gameplay', 'runs', runId, 'simulation-report.md'));
    void vscode.window.showInformationMessage(`自动玩法模型运行完成：${gameplayClassificationLabel(workflow.classification)}。模型结果仍需官方编辑器/真实多人验证。`);
    return {
      committed: true,
      mode: 'auto',
      status: workflow.report?.status ?? 'blocked',
      classification: workflow.classification,
      runId,
      reportId: workflow.report?.reportId ?? null,
      strictStaticGate: workflow.strictReview.staticGate.status,
      simulationGate: workflow.simulationGate.status,
    };
  });

  register('yuanmengAi.runConfirmedGameplayTests', async (root, suppliedDecision) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const decision = suppliedDecision === 'confirm' || suppliedDecision === 'cancel'
      ? suppliedDecision
      : await vscode.window.showWarningMessage(
        '高级手工模式将读取已确认 spec/scenarios 并运行 1/2/4/8 人有界模型模拟；它不会代替官方编辑器多人实测。',
        { modal: true },
        '运行玩法矩阵',
      ) === '运行玩法矩阵' ? 'confirm' : 'cancel';
    if (decision !== 'confirm') return { committed: false, mode: 'manual', status: 'cancelled' };
    const { model, scenarios } = await readConfirmedInputs(managed.project.root);
    const current = await currentGameplayContext(manager, sceneController, managed.project.root);
    const reportRoot = join(managed.project.root, '.yuanmeng-inspector', 'gameplay', 'reports', 'current');
    const workflow = await runGameplayWorkflow({
      root: managed.project.root,
      mode: 'manual',
      currentProject: current.currentProject,
      luaFiles: current.luaFiles,
      strictDiagnostics: current.diagnostics,
      strictPreparationFindings: [],
      sourceIndex: current.sourceIndex,
      eventMetadata: current.eventMetadata,
      registry: current.registry,
      uiSnapshot: managed.snapshot,
      sceneSnapshot: current.sceneSnapshot,
      runtimeCapabilities: current.runtimeCapabilities,
      manual: { model, scenarios, outputRoot: reportRoot },
    });
    if (workflow.report === null) {
      await openText(join(reportRoot, 'codex-review.md'));
      void vscode.window.showErrorMessage('高级手工玩法模型已过期或存在致命问题；未执行模拟。');
      return {
        committed: false, mode: 'manual', status: 'blocked', classification: workflow.classification,
        reviewPackageId: workflow.strictReview.packageId,
        strictStaticGate: workflow.strictReview.staticGate.status, simulationGate: workflow.simulationGate.status,
      };
    }
    await openText(join(reportRoot, 'gameplay-report.md'));
    void vscode.window.showInformationMessage(`高级手工玩法模型运行完成：${gameplayClassificationLabel(workflow.classification)}。官方编辑器多人验证仍为必需。`);
    return {
      committed: true, mode: 'manual', status: workflow.report.status, classification: workflow.classification,
      reportId: workflow.report.reportId,
      strictStaticGate: workflow.strictReview.staticGate.status, simulationGate: workflow.simulationGate.status,
    };
  });

  register('yuanmengAi.openGameplayReport', async (root) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const gameplayRoot = join(managed.project.root, '.yuanmeng-inspector', 'gameplay');
    const current = await currentGameplayContext(manager, sceneController, managed.project.root);
    const store = new GameplayRunStore({ io: createNodeGameplayRunStoreIO(nodeFileIO) });
    const automatic = await store.readCurrent(managed.project.root, current.currentProject);
    if (automatic !== null) {
      await openText(join(gameplayRoot, 'runs', automatic.manifest.runId, 'simulation-report.md'));
      return { opened: true, mode: 'auto', runId: automatic.manifest.runId };
    }
    const reportRoot = join(gameplayRoot, 'reports', 'current');
    const path = join(reportRoot, 'gameplay-report.md');
    try {
      const model = parseGameplayModel(await readJson(join(gameplayRoot, 'spec.json')));
      const evidence = refreshGameplayEvidence(model, current.currentProject);
      const currentModel = evidence.model;
      const gameplayDiagnostics = [
        ...current.diagnostics,
        ...reviewGameplayEventDocumentation(currentModel, current.eventMetadata),
        ...reviewGameplaySceneEventBindings(currentModel, current.sceneSnapshot, current.runtimeCapabilities, current.sourceIndex),
      ];
      const review = createGameplayCodexReviewPackage(currentModel, gameplayDiagnostics, currentModel.project, current.eventMetadata);
      const report = await readJson(join(reportRoot, 'gameplay-report.json'));
      assertGameplayReport(report);
      const isCurrent = report.modelId === currentModel.modelId
        && report.modelFingerprint === gameplayModelFingerprint(currentModel)
        && report.reviewPackageId === review.packageId
        && stableJson(report.project) === stableJson(currentModel.project);
      if (!isCurrent) throw new ProductError(
        'STALE',
        '最近的玩法模拟报告属于旧模型、旧代码或旧场景，已拒绝打开，避免把旧结果误当成当前通过。',
        ['重新运行“AI 玩法测试：静态审查并模拟 1/2/4/8 人”。'],
        'STATIC_LOCAL',
      );
      await openText(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as { code?: unknown }).code === 'FileNotFound') {
        throw new ProductError('NOT_FOUND', '尚无玩法模拟报告。', ['先运行“AI 玩法测试：静态审查并模拟 1/2/4/8 人”。'], 'STATIC_LOCAL');
      }
      throw error;
    }
    return { opened: true };
  });
}
