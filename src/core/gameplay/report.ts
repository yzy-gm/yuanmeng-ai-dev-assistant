import type { ProjectDiagnostic } from '../diagnostics/analyzer.js';
import type { ResolvedEventMetadata } from '../api/event-doc-index.js';
import { sha256Hex, stableJson } from '../hash.js';
import { gameplayModelFingerprint, isGameplayEvidenceSatisfied, reviewGameplayStaticGate } from './model.js';
import {
  firstPopulationFailure,
  populationEditorRequirementIds,
  summarizeGameplayCoverage,
} from './assertions.js';
import type {
  GameplayModel,
  GameplayPopulationMatrixResult,
  GameplayRunClassification,
  GameplayRunSummary,
  GameplaySimulationGate,
  GameplaySkippedFlow,
  GameplayStaticGate,
  GameplayTestReport,
  GameplayValue,
} from './types.js';

const WINDOWS_PATH = /(?:[A-Za-z]:[\\/])(?:[^\s，。；：,;:)\]}]+[\\/])*[^\s，。；：,;:)\]}]*/gu;
const UNC_PATH = /(?:\\\\|\/\/)[^\\/\s，。；：,;:)\]}]+[\\/][^\s，。；：,;:)\]}]+/gu;
// 不将“2/4/8 人”这类纯数字分隔文案误判成 Unix 绝对路径。
// /123/456/file 仍会匹配；只豁免到文本边界为止全是数字的多段序列。
const UNIX_ABSOLUTE_PATH = /\/(?!\d+(?:\/\d+)+(?:\s|$|[，。；：,;:)\]}]))(?:[^/\s，。；：,;:)\]}]+\/)+[^/\s，。；：,;:)\]}]+/gu;

function redactText(value: string): string {
  return value.replace(UNC_PATH, '[已脱敏路径]').replace(WINDOWS_PATH, '[已脱敏路径]').replace(UNIX_ABSOLUTE_PATH, '[已脱敏路径]');
}

function redactValue(value: GameplayValue): GameplayValue {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(redactValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
}

function redactJson<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry)])) as T;
}

function changedKeys(initial: Record<string, GameplayValue>, current: Record<string, GameplayValue>): string[] {
  const has = (value: Record<string, GameplayValue>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
  return [...new Set([...Object.keys(initial), ...Object.keys(current)])]
    .filter((key) => has(initial, key) !== has(current, key)
      || (has(initial, key) && stableJson(initial[key]) !== stableJson(current[key])))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export interface GameplayCodexReviewPackage {
  schemaVersion: 1;
  packageId: string;
  kind: 'CODEX_REVIEW_INPUT';
  modelId: string;
  project: GameplayModel['project'];
  staticGate: GameplayStaticGate;
  modelSummary: {
    handlerCount: number;
    branchCount: number;
    invariantCount: number;
    evidenceRequirementCount: number;
    maximumPlayers: number | null;
  };
  evidenceBoundary: {
    static: 'STATIC_LOCAL';
    simulation: 'NOT_RUN';
    editor: 'NOT_RUN';
  };
}

function privacySafeGate(
  model: GameplayModel,
  diagnostics: readonly ProjectDiagnostic[],
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata> = new Map(),
): GameplayStaticGate {
  const gate = reviewGameplayStaticGate(model, diagnostics, eventMetadata);
  return {
    ...gate,
    findings: gate.findings.map((finding) => ({
      ...finding,
      message: redactText(finding.message),
      nextAction: redactText(finding.nextAction),
    })),
  };
}

export function createGameplayCodexReviewPackage(
  model: GameplayModel,
  projectDiagnostics: readonly ProjectDiagnostic[] = [],
  currentProject?: GameplayModel['project'],
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata> = new Map(),
): GameplayCodexReviewPackage {
  const staticGate = privacySafeGate(model, projectDiagnostics, eventMetadata);
  if (currentProject !== undefined && stableJson(currentProject) !== stableJson(model.project)) {
    staticGate.status = 'blocked';
    staticGate.findings.push({
      source: 'model', code: 'CURRENT_KNOWLEDGE_FINGERPRINT_MISMATCH', severity: 'error', evidence: 'STATIC_LOCAL',
      message: '当前 Lua、UI、注册表或场景知识指纹与玩法模型不一致。',
      nextAction: '重新生成并确认玩法模型与场景；禁止沿用旧审查结果。',
    });
  }
  const content = {
    schemaVersion: 1 as const,
    kind: 'CODEX_REVIEW_INPUT' as const,
    modelId: model.modelId,
    project: model.project,
    staticGate,
    modelSummary: {
      handlerCount: model.handlers.length,
      branchCount: model.handlers.reduce((total, handler) => total + handler.branches.length, 0),
      invariantCount: model.invariants.length,
      evidenceRequirementCount: model.evidenceRequirements.length,
      maximumPlayers: model.multiplayer?.maximumPlayers ?? null,
    },
    evidenceBoundary: {
      static: 'STATIC_LOCAL' as const,
      simulation: 'NOT_RUN' as const,
      editor: 'NOT_RUN' as const,
    },
  };
  return { ...content, packageId: sha256Hex(stableJson(content)) };
}

export function renderGameplayCodexReviewMarkdown(review: GameplayCodexReviewPackage): string {
  const findings = review.staticGate.findings.length === 0
    ? '- 未发现本地静态问题。'
    : review.staticGate.findings.map((finding) => `- [${finding.severity.toUpperCase()}] ${finding.code}: ${redactText(finding.message)}（${redactText(finding.nextAction)}）`).join('\n');
  return [
    '# Codex 代码审查包',
    '',
    `- 模型：${review.modelId}`,
    `- 静态门：${review.staticGate.status}`,
    '- 当前证据：STATIC_LOCAL',
    '- 玩法模拟：NOT_RUN',
    '- 官方编辑器：NOT_RUN',
    '',
    '## 模型摘要',
    '',
    `- 处理器：${review.modelSummary.handlerCount}`,
    `- 分支：${review.modelSummary.branchCount}`,
    `- 不变量：${review.modelSummary.invariantCount}`,
    `- 最大玩家：${review.modelSummary.maximumPlayers ?? '未声明'}`,
    '',
    '## 静态发现',
    '',
    findings,
    '',
    '> 这是供 Codex 读取的脱敏本地审查包；当前版本不会自动调用外部 Codex 服务。',
    '',
  ].join('\n');
}

export function createGameplayTestReport(
  model: GameplayModel,
  matrix: GameplayPopulationMatrixResult,
  options: {
    projectDiagnostics?: readonly ProjectDiagnostic[];
    reviewPackageId?: string;
    runSummary?: GameplayRunSummary;
    eventMetadata?: ReadonlyMap<string, ResolvedEventMetadata>;
  } = {},
): GameplayTestReport {
  const staticGate = privacySafeGate(model, options.projectDiagnostics ?? [], options.eventMetadata);
  const sceneBackedRequirements = model.evidenceRequirements.filter((requirement) => (
    requirement.kind === 'physics-contact' || requirement.kind === 'scene-bounds' || requirement.kind === 'npc-reachability'
  ));
  const sceneEvidence: GameplayTestReport['evidence']['sceneEvidence'] = sceneBackedRequirements.length === 0
    ? 'NOT_AVAILABLE'
    : sceneBackedRequirements.some((requirement) => requirement.state === 'stale')
      ? 'STALE'
      : model.project.sceneSnapshotId !== null && sceneBackedRequirements.every(isGameplayEvidenceSatisfied)
        ? 'CONFIRMED'
        : 'CANDIDATE';
  const staticKeys = new Set(staticGate.findings.map((finding) => `${finding.code}\0${finding.message}`));
  const scenarioFindingMap = new Map<string, GameplayTestReport['findings'][number]>();
  for (const population of matrix.populations) for (const schedule of population.matrix.schedules) {
    for (const finding of schedule.result.staticFindings) {
      if (staticKeys.has(`${finding.code}\0${finding.message}`)) continue;
      const key = `${population.playerCount}\0${schedule.result.scenarioId}\0${finding.code}\0${finding.message}`;
      scenarioFindingMap.set(key, {
        source: 'scenario', code: finding.code, severity: finding.severity,
        message: `${population.playerCount} 人场景 ${schedule.result.scenarioId}: ${redactText(finding.message)}`,
        nextAction: redactText(finding.nextAction),
      });
    }
  }
  const populations = matrix.populations.map((population) => {
    const failingSchedule = population.matrix.schedules.find((schedule) => schedule.result.failures.length > 0) ?? null;
    const representative = failingSchedule ?? population.matrix.schedules[0] ?? null;
    const broadcastDeliveries: GameplayTestReport['populations'][number]['broadcastDeliveries'] = [];
    const sharedOutcomes = new Map<string, Record<string, GameplayValue>>();
    for (const schedule of population.matrix.schedules) {
      const safeShared = redactValue(schedule.result.finalState.shared) as Record<string, GameplayValue>;
      sharedOutcomes.set(stableJson(safeShared), safeShared);
      const scheduleBroadcastGroups = new Map<string, { event: string; expected: Set<string>; actual: Set<string> }>();
      for (const trace of schedule.result.trace) {
        if (trace.broadcastId === null || trace.playerId === null) continue;
        const group = scheduleBroadcastGroups.get(trace.broadcastId) ?? { event: trace.event, expected: new Set<string>(), actual: new Set<string>() };
        for (const expected of trace.broadcastExpectedPlayerIds ?? []) group.expected.add(expected);
        if (trace.deliveryOutcome === 'handled') group.actual.add(trace.playerId);
        scheduleBroadcastGroups.set(trace.broadcastId, group);
      }
      for (const [broadcastId, group] of scheduleBroadcastGroups) {
        const expectedRecipientPlayerIds = [...group.expected].sort((left, right) => left.localeCompare(right, 'en'));
        const actualRecipientPlayerIds = [...group.actual].sort((left, right) => left.localeCompare(right, 'en'));
        broadcastDeliveries.push({
          scheduleId: schedule.scheduleId, broadcastId, event: group.event,
          expectedRecipientPlayerIds, actualRecipientPlayerIds,
          missingRecipientPlayerIds: expectedRecipientPlayerIds.filter((playerId) => !group.actual.has(playerId)),
          unexpectedRecipientPlayerIds: actualRecipientPlayerIds.filter((playerId) => !group.expected.has(playerId)),
        });
      }
    }
    const representativeState = representative?.result.finalState;
    const firstFailureStep = failingSchedule?.result.failures[0]?.stepIndex;
    const contaminationCodes = new Set(['CLIENT_WRITES_SERVER_STATE', 'HARDCODED_CROSS_PLAYER_TARGET', 'CLIENT_CROSS_PLAYER_AUTHORITY_INVALID', 'HARDCODED_PLAYER_TARGET']);
    const exercisedPlayers = new Set(population.matrix.schedules.flatMap((schedule) => schedule.result.trace.flatMap((trace) => trace.playerId === null ? [] : [trace.playerId])));
    return {
      playerCount: population.playerCount,
      mode: population.mode,
      status: population.status,
      schedulesExplored: population.schedulesExplored,
      truncated: population.truncated,
      scenarios: population.scenarioResults,
      firstFailure: firstPopulationFailure(population),
      firstFailingScheduleId: failingSchedule?.scheduleId ?? null,
      minimalReproduction: failingSchedule === null || firstFailureStep === undefined ? null : {
        scenarioSteps: redactJson(failingSchedule.scenarioSteps.slice(0, Math.max(0, firstFailureStep + 1))),
        trace: failingSchedule.result.trace.filter((trace) => trace.stepIndex <= firstFailureStep).map((trace) => ({
          sequence: trace.sequence, stepIndex: trace.stepIndex, event: trace.event, playerId: trace.playerId,
          source: trace.source, targetSide: trace.targetSide, routing: trace.routing,
        })),
        readyInterleavings: { ...failingSchedule.result.readyInterleavings },
      },
      playerStateDiffs: representativeState === undefined ? [] : Object.keys(representativeState.players).sort().map((playerId) => ({
        playerId,
        serverChangedKeys: changedKeys(model.initialState.player, representativeState.players[playerId] ?? {}),
        clientChangedKeys: changedKeys(model.initialState.client, representativeState.clients[playerId] ?? {}),
      })),
      broadcastDeliveries: broadcastDeliveries.sort((left, right) => left.scheduleId.localeCompare(right.scheduleId, 'en') || left.broadcastId.localeCompare(right.broadcastId, 'en')),
      crossPlayerIsolation: population.matrix.schedules.some((schedule) => schedule.result.staticFindings.some((finding) => contaminationCodes.has(finding.code)))
        ? 'failed' as const
        : exercisedPlayers.size > 1 ? 'no-modeled-contamination-observed' as const : 'not-exercised' as const,
      sharedOutcomes: [...sharedOutcomes.values()].slice(0, 16),
      editorRequirementIds: populationEditorRequirementIds(population),
    };
  });
  const editorRetest = [
    '在官方编辑器中分别执行单人、2 人、4 人和 8 人流程。',
    '多人房间验证真实网络复制、延迟、断线重连及回调玩家身份。',
    ...model.evidenceRequirements.filter((requirement) => !isGameplayEvidenceSatisfied(requirement)).map((requirement) => redactText(requirement.description)),
  ];
  if (populations.some((population) => population.truncated)) editorRetest.push('增加有界时序上限后复查被截断的同帧排列。');
  const coverage = summarizeGameplayCoverage(model, matrix);
  const populationCoverageIncomplete = coverage.byPopulation.some((population) => (
    population.shared.ratio < 1 || population.byPlayer.some((player) => player.ratio < 1)
  ));
  const playerIsolationRelevant = Object.keys(model.initialState.player).length > 0
    || Object.keys(model.initialState.client).length > 0
    || (model.eventPolicies ?? []).some((policy) => policy.playerRequired)
    || model.handlers.some((handler) => handler.branches.some((branch) => branch.effects.some((effect) => (
      effect.kind !== 'emit' && (effect.target.scope === 'player' || effect.target.scope === 'client')
    ))));
  const isolationIncomplete = playerIsolationRelevant
    && populations.some((population) => population.mode === 'multiplayer' && population.crossPlayerIsolation === 'not-exercised');
  const coverageComplete = coverage.ratio === 1 && !populationCoverageIncomplete && !isolationIncomplete;
  const coverageFinding = !coverageComplete ? [{
    source: 'model' as const,
    code: 'DECLARED_BRANCH_COVERAGE_INCOMPLETE',
    severity: 'error' as const,
    message: `声明分支未达到全局、分人口、共享或每玩家的多人覆盖门。`,
    nextAction: '为每个人口及每个适用玩家补充场景；确有角色差异时先在模型中显式拆分职责。',
  }] : [];
  const truncationFindings = populations.filter((population) => population.truncated).map((population) => ({
    source: 'scenario' as const,
    code: 'TIMING_EXPLORATION_TRUNCATED',
    severity: 'warning' as const,
    message: `${population.playerCount} 人测试达到有界时序上限，未探索时序不能视为通过。`,
    nextAction: '提高 maxSchedules 或拆分场景后重试，并保留官方编辑器多人复测。',
  }));
  const findings = [
    ...staticGate.findings.map((finding) => ({
      source: finding.source,
      code: finding.code,
      severity: finding.severity,
      message: redactText(finding.message),
      nextAction: redactText(finding.nextAction),
    })),
    ...scenarioFindingMap.values(),
    ...truncationFindings,
    ...coverageFinding,
  ];
  const nextActions: GameplayTestReport['nextActions'] = [];
  const addNextAction = (
    kind: GameplayTestReport['nextActions'][number]['kind'],
    description: string,
    previewTarget: GameplayTestReport['nextActions'][number]['previewTarget'],
    evidenceRequired: GameplayTestReport['nextActions'][number]['evidenceRequired'],
  ): void => {
    const safeDescription = redactText(description);
    const actionId = `${kind}:${sha256Hex(`${safeDescription}\0${previewTarget}\0${evidenceRequired}`).slice(0, 16)}`;
    if (!nextActions.some((entry) => entry.actionId === actionId)) nextActions.push({
      actionId, kind, description: safeDescription, previewTarget, evidenceRequired, autoApply: false,
    });
  };
  for (const entry of findings.filter((finding) => finding.severity === 'error')) {
    addNextAction('fix-static-model', entry.nextAction, entry.source === 'project' ? 'source-review' : 'spec.json', 'STATIC_LOCAL');
  }
  if (!coverageComplete) addNextAction(
    'add-regression-scenario',
    '为每个未覆盖人口和玩家补齐可重复的成功、失败、重复投递、共享资源竞争与断线重连场景。',
    'scenarios',
    'UNIT_E2E',
  );
  addNextAction(
    'confirm-model-contract',
    '确认资源上下界、事务幂等、任务前置和升级前置均已写入玩法规格；系统不会根据变量名猜测。',
    'spec.json',
    'STATIC_LOCAL',
  );
  addNextAction(
    'official-editor-test',
    '完成官方编辑器单人以及 2/4/8 人实测，重点检查物理、NPC 可达、真实复制顺序与跨玩家隔离。',
    'official-editor',
    'OFFICIAL_EDITOR_MULTI',
  );
  const combinedStaticGate = staticGate.status === 'blocked' || [...scenarioFindingMap.values()].some((finding) => finding.severity === 'error') ? 'blocked' as const : 'pass' as const;
  const content = {
    schemaVersion: 1 as const,
    modelFingerprint: gameplayModelFingerprint(model),
    reviewPackageId: options.reviewPackageId
      ?? createGameplayCodexReviewPackage(model, options.projectDiagnostics ?? [], model.project, options.eventMetadata).packageId,
    modelId: model.modelId,
    project: model.project,
    status: combinedStaticGate === 'blocked' ? 'blocked' as const : !coverageComplete ? 'fail' as const : matrix.status,
    evidence: {
      staticReview: 'STATIC_LOCAL' as const,
      modelSimulation: 'UNIT_E2E' as const,
      sceneEvidence,
      officialEditor: 'REQUIRED_FOR_ENGINE_BEHAVIOR' as const,
    },
    staticGate: combinedStaticGate,
    ...(options.runSummary === undefined ? {} : { runSummary: redactJson(options.runSummary) }),
    findings,
    populations,
    coverage,
    nextActions,
    editorRetest: [...new Set(editorRetest)],
  };
  return { ...content, reportId: sha256Hex(stableJson(content)) };
}

export function classifyGameplayRun(input: {
  gate: GameplaySimulationGate;
  report: GameplayTestReport | null;
  skippedFlows: readonly GameplaySkippedFlow[];
}): GameplayRunClassification {
  if (input.gate.status === 'blocked' || input.report === null || input.report.status === 'blocked') return 'not-run-fatal';
  if (input.report.status === 'fail') return 'model-fail';
  if (input.report.status === 'needs-editor'
    || input.skippedFlows.length > 0
    || input.gate.skippedFindings.some((finding) => finding.severity === 'partial')
    || input.report.populations.some((population) => population.truncated)) return 'partial-needs-editor';
  return 'model-pass';
}

export function renderGameplayTestReportMarkdown(report: GameplayTestReport): string {
  const runSummary: GameplayRunSummary = report.runSummary ?? {
    mode: 'manual',
    classification: report.status === 'blocked' ? 'not-run-fatal'
      : report.status === 'fail' ? 'model-fail'
        : report.status === 'needs-editor' || report.populations.some((population) => population.truncated) ? 'partial-needs-editor'
          : 'model-pass',
    strictStaticGate: report.staticGate,
    simulationGate: report.status === 'blocked' ? 'blocked' : 'pass',
    executedScenarioIds: [...new Set(report.populations.flatMap((population) => population.scenarios.map((scenario) => scenario.scenarioId)))],
    skippedFlows: [],
    truncated: report.populations.some((population) => population.truncated),
  };
  const populationLines = report.populations.map((population) => (
    `| ${population.playerCount} | ${population.mode === 'single-player' ? '单人模式' : '多人模式'} | ${population.status} | ${population.schedulesExplored} | ${population.truncated ? '是' : '否'} |`
  ));
  const findingLines = report.findings.length === 0
    ? ['- 无阻断性静态发现。']
    : report.findings.map((finding) => `- [${finding.severity.toUpperCase()}] ${finding.code}: ${redactText(finding.message)}`);
  const multiplayerDetails = report.populations.flatMap((population) => {
    const failure = population.firstFailure === null
      ? '- 首次失败：无'
      : `- 首次失败：${population.firstFailingScheduleId ?? 'unknown'} / step ${population.firstFailure.stepIndex} / ${population.firstFailure.code}`;
    const reproduction = population.minimalReproduction === null
      ? '- 最小复现分发顺序：无'
      : `- 有界复现：步骤 ${population.minimalReproduction.scenarioSteps.length} 个；实际事件 ${population.minimalReproduction.trace.map((trace) => `${trace.event}@${trace.playerId ?? '无玩家'}:${trace.targetSide}`).join(' → ') || '无'}；ready选择 [${population.minimalReproduction.readyInterleavings.choices.join(',')}]`;
    const players = population.playerStateDiffs.length === 0
      ? '- 每玩家状态差异：无'
      : `- 每玩家状态差异：${population.playerStateDiffs.map((entry) => `${entry.playerId}[server:${entry.serverChangedKeys.join(',') || '-'}; client:${entry.clientChangedKeys.join(',') || '-'}]`).join('；')}`;
    const broadcasts = population.broadcastDeliveries.length === 0
      ? '- 广播收件集合：无广播'
      : `- 广播收件集合：${population.broadcastDeliveries.map((entry) => `${entry.scheduleId}/${entry.event} 预期[${entry.expectedRecipientPlayerIds.join(',')}] 实际[${entry.actualRecipientPlayerIds.join(',')}] 缺失[${entry.missingRecipientPlayerIds.join(',')}] 越界[${entry.unexpectedRecipientPlayerIds.join(',')}]`).join('；')}`;
    return [
      `### ${population.playerCount} 人`,
      '',
      failure,
      `- 独立场景：${population.scenarios.map((entry) => `${entry.scenarioId}=${entry.status}/${entry.schedulesExplored}${entry.truncated ? '/截断' : ''}`).join('；')}`,
      reproduction,
      players,
      broadcasts,
      `- 跨玩家隔离：${population.crossPlayerIsolation}`,
      `- 共享资源竞争结果：${population.sharedOutcomes.length} 种最终状态`,
      `- 未探索时序：${population.truncated ? '存在（已达到有界上限）' : '无'}`,
      '',
    ];
  });
  const coverageDetails = report.coverage.byPopulation.flatMap((population) => [
    `- ${population.playerCount} 人：${population.visitedBranches}/${population.totalBranches}；共享 ${population.shared.visitedBranches}/${population.shared.totalBranches}；每玩家 ${population.byPlayer.map((entry) => `${entry.playerId}=${entry.visitedBranches}/${entry.totalBranches}`).join('，')}`,
  ]);
  const nextActionLines = report.nextActions.map((entry) => (
    `- [${entry.kind}] ${redactText(entry.description)}；预览目标=${entry.previewTarget}；所需证据=${entry.evidenceRequired}；自动应用=否`
  ));
  return [
    '# AI 玩法测试报告',
    '',
    `- 总状态：${report.status}`,
    `- 运行模式：${runSummary.mode}`,
    `- 运行分类：${runSummary.classification}`,
    `- 严格静态门：${runSummary.strictStaticGate}`,
    `- 模拟准入门：${runSummary.simulationGate}`,
    `- 实际执行场景：${runSummary.executedScenarioIds.join('，') || '无'}`,
    `- 跳过流程：${runSummary.skippedFlows.map((flow) => `${flow.flowId}/${flow.reasonCode}`).join('，') || '无'}`,
    `- 有界截断：${runSummary.truncated ? '是' : '否'}`,
    `- 静态代码审查：${report.staticGate}（STATIC_LOCAL）`,
    '- 玩法模型模拟：MODEL_SIMULATION / UNIT_E2E',
    `- 场景证据：SCENE_EVIDENCE / ${report.evidence.sceneEvidence}`,
    '- 官方编辑器多人验证：OFFICIAL_EDITOR_MULTI_REQUIRED',
    `- 已声明分支覆盖率：${report.coverage.visitedBranches}/${report.coverage.totalBranches} (${(report.coverage.ratio * 100).toFixed(1)}%)`,
    '',
    '## 单人/多人矩阵',
    '',
    '| 人数 | 模式 | 状态 | 探索时序 | 截断 |',
    '| ---: | --- | --- | ---: | --- |',
    ...populationLines,
    '',
    '## 多人模式详细证据',
    '',
    ...multiplayerDetails,
    '## 分人口/每玩家覆盖',
    '',
    ...coverageDetails,
    '',
    '## 静态发现',
    '',
    ...findingLines,
    '',
    '## 建议下一步（只预览，不自动改 Lua）',
    '',
    ...nextActionLines,
    '',
    '## 官方编辑器最小复测',
    '',
    ...report.editorRetest.map((entry) => `- ${redactText(entry)}`),
    '',
    '> 90%–95% 只指已声明且可建模分支的覆盖目标，不代表真实引擎错误检出率。',
    '',
  ].join('\n');
}
