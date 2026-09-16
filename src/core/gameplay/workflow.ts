import { join } from 'node:path';

import type { ResolvedEventMetadata } from '../api/event-doc-index.js';
import type { ProjectDiagnostic } from '../diagnostics/analyzer.js';
import { atomicWriteJson, atomicWriteText, nodeFileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';
import type { LuaSourceFile, LuaSourceIndex } from '../lua/source-index.js';
import type { RegistryDocument, UiSnapshot } from '../model.js';
import type { CapabilityEvidenceResolution } from '../scene/probe-evidence.js';
import type { SceneSnapshot } from '../scene/types.js';
import { autoPrepareGameplay } from './auto-prepare.js';
import {
  gameplayModelFingerprint,
  refreshGameplayEvidence,
  refreshGameplayScenarioBinding,
  reviewGameplayEventDocumentation,
  reviewGameplaySceneEventBindings,
  reviewGameplaySimulationEligibility,
} from './model.js';
import {
  classifyGameplayRun,
  createGameplayCodexReviewPackage,
  createGameplayTestReport,
  renderGameplayCodexReviewMarkdown,
  renderGameplayTestReportMarkdown,
  type GameplayCodexReviewPackage,
} from './report.js';
import { createNodeGameplayRunStoreIO, GameplayRunStore } from './run-store.js';
import { runGameplayPopulationMatrix } from './simulator.js';
import type {
  GameplayModel,
  GameplayPreparationFinding,
  GameplayRunClassification,
  GameplayRunMode,
  GameplayScenario,
  GameplaySimulationGate,
  GameplaySkippedFlow,
  GameplayTestReport,
} from './types.js';

function assertJsonValue(_value: unknown): asserts _value is unknown {
  // Domain constructors already validate typed gameplay documents.
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('玩法工作流已取消。');
  error.name = 'AbortError';
  throw error;
}

function diagnosticKey(diagnostic: Pick<ProjectDiagnostic, 'code' | 'path' | 'range'>): string {
  return [diagnostic.code, diagnostic.path?.replace(/\\/gu, '/') ?? '', String(diagnostic.range?.startLine ?? 1)].join('\0');
}

function simulationDiagnostics(
  diagnostics: readonly ProjectDiagnostic[],
  gate: GameplaySimulationGate,
): ProjectDiagnostic[] {
  const fatalKeys = new Set(gate.fatalFindings.flatMap((finding) => finding.evidence.length === 0
    ? [[finding.code, '', '1'].join('\0')]
    : finding.evidence.map((evidence) => [finding.code, evidence.path.replace(/\\/gu, '/'), String(evidence.line)].join('\0'))));
  return diagnostics.map((diagnostic) => diagnostic.severity !== 'error' || fatalKeys.has(diagnosticKey(diagnostic))
    ? diagnostic
    : {
      ...diagnostic,
      severity: 'warning' as const,
      message: `${diagnostic.message}（严格静态审查保留；本项不影响本次有限模型模拟。）`,
    });
}

function staleManualFinding(changedKeys: readonly string[]): GameplayPreparationFinding {
  return {
    code: 'GAMEPLAY_MANUAL_EVIDENCE_STALE',
    severity: 'fatal',
    scope: 'artifact',
    message: `手工玩法模型的当前工程证据已变化：${changedKeys.join('、')}。`,
    nextAction: '重新生成、人工确认并显式提供新的玩法模型与场景。',
    evidence: [],
  };
}

async function writeManualReview(outputRoot: string, review: GameplayCodexReviewPackage): Promise<void> {
  await Promise.all([
    atomicWriteJson(nodeFileIO, join(outputRoot, 'codex-review.json'), review, assertJsonValue),
    atomicWriteText(nodeFileIO, join(outputRoot, 'codex-review.md'), renderGameplayCodexReviewMarkdown(review)),
  ]);
}

async function writeManualReport(outputRoot: string, report: GameplayTestReport): Promise<void> {
  await Promise.all([
    atomicWriteJson(nodeFileIO, join(outputRoot, 'gameplay-report.json'), report, assertJsonValue),
    atomicWriteText(nodeFileIO, join(outputRoot, 'gameplay-report.md'), renderGameplayTestReportMarkdown(report)),
  ]);
}

export interface GameplayWorkflowResult {
  mode: GameplayRunMode;
  classification: GameplayRunClassification;
  model: GameplayModel;
  scenarios: GameplayScenario[];
  modelFingerprint: string;
  scenarioFingerprint: string;
  strictReview: GameplayCodexReviewPackage;
  simulationGate: GameplaySimulationGate;
  preparationFindings: GameplayPreparationFinding[];
  skippedFlows: GameplaySkippedFlow[];
  executedScenarioIds: string[];
  report: GameplayTestReport | null;
  run: Awaited<ReturnType<GameplayRunStore['commit']>> | null;
}

export async function runGameplayWorkflow(input: {
  root: string;
  mode: GameplayRunMode;
  currentProject: GameplayModel['project'];
  luaFiles: readonly LuaSourceFile[];
  strictDiagnostics: readonly ProjectDiagnostic[];
  strictPreparationFindings: readonly GameplayPreparationFinding[];
  sourceIndex: LuaSourceIndex;
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata>;
  registry: RegistryDocument;
  uiSnapshot: UiSnapshot | null;
  sceneSnapshot: SceneSnapshot | null;
  runtimeCapabilities: ReadonlyMap<string, CapabilityEvidenceResolution>;
  manual?: { model: GameplayModel; scenarios: GameplayScenario[]; outputRoot: string };
  focus?: { text: string | null; changedFiles: string[] };
  persist?: boolean;
  signal?: AbortSignal;
  store?: GameplayRunStore;
}): Promise<GameplayWorkflowResult> {
  throwIfAborted(input.signal);
  let model: GameplayModel;
  let scenarios: GameplayScenario[];
  let productionPaths: ReadonlySet<string>;
  let preparationFindings: GameplayPreparationFinding[];
  let skippedFlows: GameplaySkippedFlow[];
  let manualStale = false;

  if (input.mode === 'auto') {
    const prepared = autoPrepareGameplay({
      project: input.currentProject,
      luaFiles: input.luaFiles,
      productionSourceIndex: input.sourceIndex,
      eventMetadata: input.eventMetadata,
      registry: input.registry,
      uiSnapshot: input.uiSnapshot,
      sceneSnapshot: input.sceneSnapshot,
      runtimeCapabilities: input.runtimeCapabilities,
      ...(input.focus === undefined ? {} : { focus: input.focus }),
    });
    model = prepared.model;
    scenarios = [...prepared.scenarios];
    productionPaths = new Set(prepared.productionScope.reachablePaths);
    preparationFindings = [...input.strictPreparationFindings, ...prepared.findings];
    skippedFlows = prepared.skippedFlows.map((flow) => ({ ...flow, evidence: [...flow.evidence] }));
  } else {
    if (input.manual === undefined) throw new Error('手工玩法模式缺少显式模型、场景和输出目录。');
    model = input.manual.model;
    scenarios = input.manual.scenarios.map((scenario) => ({ ...scenario }));
    productionPaths = new Set(input.luaFiles.map((file) => file.path.replace(/\\/gu, '/')));
    preparationFindings = input.strictPreparationFindings.map((finding) => ({ ...finding, evidence: [...finding.evidence] }));
    skippedFlows = [];
    if (model.project.projectInstanceId !== input.currentProject.projectInstanceId) {
      preparationFindings.push({
        code: 'CURRENT_PROJECT_BINDING_MISMATCH', severity: 'fatal', scope: 'project',
        message: '手工玩法模型属于另一个工程。', nextAction: '切换到模型所属工程或重新生成当前工程模型。', evidence: [],
      });
      manualStale = true;
    } else {
      const evidence = refreshGameplayEvidence(model, input.currentProject);
      manualStale = evidence.refreshed;
      if (manualStale) preparationFindings.push(staleManualFinding(evidence.changedKeys));
      else scenarios = scenarios.map((scenario) => refreshGameplayScenarioBinding(scenario, model, evidence.model));
    }
  }

  throwIfAborted(input.signal);
  const strictDiagnostics = [
    ...input.strictDiagnostics,
    ...reviewGameplaySceneEventBindings(model, input.sceneSnapshot, input.runtimeCapabilities, input.sourceIndex),
    ...reviewGameplayEventDocumentation(model, input.eventMetadata),
  ];
  const strictReview = createGameplayCodexReviewPackage(model, strictDiagnostics, input.currentProject, input.eventMetadata);
  if (input.mode === 'manual') await writeManualReview(input.manual!.outputRoot, strictReview);

  const simulationGate = reviewGameplaySimulationEligibility({
    model,
    scenarios,
    productionPaths,
    preparationFindings,
    projectDiagnostics: strictDiagnostics,
    allowSceneEvidenceGaps: input.mode === 'auto',
  });
  throwIfAborted(input.signal);

  let report: GameplayTestReport | null = null;
  let classification: GameplayRunClassification;
  let executedScenarioIds: string[] = [];
  if (simulationGate.status === 'blocked' || manualStale) {
    classification = 'not-run-fatal';
  } else {
    const eligibleDiagnostics = simulationDiagnostics(strictDiagnostics, simulationGate);
    const requiredPlayerCounts = input.mode === 'auto'
      ? [...new Set(scenarios.map((scenario) => scenario.players.length))].sort((left, right) => left - right)
      : undefined;
    const matrix = runGameplayPopulationMatrix(model, scenarios, {
      currentProject: input.currentProject,
      projectDiagnostics: eligibleDiagnostics,
      eventMetadata: input.eventMetadata,
      ...(requiredPlayerCounts === undefined ? {} : { requiredPlayerCounts }),
    });
    const initialReport = createGameplayTestReport(model, matrix, {
      projectDiagnostics: eligibleDiagnostics,
      reviewPackageId: strictReview.packageId,
      eventMetadata: input.eventMetadata,
    });
    classification = classifyGameplayRun({ gate: simulationGate, report: initialReport, skippedFlows });
    executedScenarioIds = scenarios.map((scenario) => scenario.scenarioId);
    report = createGameplayTestReport(model, matrix, {
      projectDiagnostics: eligibleDiagnostics,
      reviewPackageId: strictReview.packageId,
      eventMetadata: input.eventMetadata,
      runSummary: {
        mode: input.mode,
        classification,
        strictStaticGate: strictReview.staticGate.status,
        simulationGate: simulationGate.status,
        executedScenarioIds,
        skippedFlows,
        truncated: initialReport.populations.some((population) => population.truncated),
      },
    });
    if (input.mode === 'manual') await writeManualReport(input.manual!.outputRoot, report);
  }

  throwIfAborted(input.signal);
  const modelFingerprint = gameplayModelFingerprint(model);
  const scenarioFingerprint = sha256Hex(stableJson(scenarios));
  let run: GameplayWorkflowResult['run'] = null;
  if (input.mode === 'auto' && input.persist !== false) {
    const store = input.store ?? new GameplayRunStore({ io: createNodeGameplayRunStoreIO(nodeFileIO) });
    const reportMarkdown = report === null
      ? '# AI 玩法测试报告\n\n- 运行分类：not-run-fatal\n- 模拟准入门：blocked\n\n本次没有执行模型场景；请按 manifest 与严格审查包中的 fatal finding 修复后重试。\n'
      : renderGameplayTestReportMarkdown(report);
    throwIfAborted(input.signal);
    run = await store.commit({
      root: input.root,
      mode: input.mode,
      project: input.currentProject,
      model,
      scenarios,
      strictReview,
      strictReviewMarkdown: renderGameplayCodexReviewMarkdown(strictReview),
      simulationReport: report,
      simulationReportMarkdown: reportMarkdown,
      strictStaticGate: strictReview.staticGate.status,
      simulationGate: simulationGate.status,
      classification,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  return {
    mode: input.mode,
    classification,
    model,
    scenarios,
    modelFingerprint,
    scenarioFingerprint,
    strictReview,
    simulationGate,
    preparationFindings,
    skippedFlows,
    executedScenarioIds,
    report,
    run,
  };
}
