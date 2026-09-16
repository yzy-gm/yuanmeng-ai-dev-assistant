import type { ProjectDiagnostic } from '../diagnostics/analyzer.js';
import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import type { ResolvedEventMetadata } from '../api/event-doc-index.js';
import type { LuaSourceFile, LuaSourceIndex, LuaSide } from '../lua/source-index.js';
import type { RegistryDocument, UiSnapshot } from '../model.js';
import type { CapabilityEvidenceResolution } from '../scene/probe-evidence.js';
import { assertSceneEventCompatible, resolveSceneInstanceIntelligence } from '../scene/semantic-catalog.js';
import type { SceneSnapshot } from '../scene/types.js';
import type {
  GameplayDraftAssumption,
  GameplayEvidenceRequirement,
  GameplayEffect,
  GameplayEventTargetSide,
  GameplayExpression,
  GameplayKnowledgeDraft,
  GameplayKnowledgeEdge,
  GameplayKnowledgeNode,
  GameplayModel,
  GameplayPreparationFinding,
  GameplaySceneEventBinding,
  GameplayScenario,
  GameplaySimulationGate,
  GameplayStaticGate,
  GameplayStaticFinding,
  GameplayStateRef,
  GameplayValue,
} from './types.js';

const EVENT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/u;

function finding(code: string, severity: GameplayStaticFinding['severity'], message: string, nextAction: string): GameplayStaticFinding {
  return { code, severity, message, evidence: 'STATIC_LOCAL', nextAction };
}

export function isGameplayEvidenceSatisfied(requirement: GameplayEvidenceRequirement): boolean {
  if (requirement.state !== 'confirmed') return false;
  if (requirement.kind === 'network-ordering') return requirement.evidence === 'OFFICIAL_EDITOR_MULTI';
  if (requirement.kind === 'scene-bounds') return requirement.evidence === 'EXTENSION_HOST'
    || requirement.evidence === 'OFFICIAL_EDITOR_SINGLE'
    || requirement.evidence === 'OFFICIAL_EDITOR_MULTI'
    || requirement.evidence === 'USER_ATTESTED';
  return requirement.evidence === 'OFFICIAL_EDITOR_SINGLE'
    || requirement.evidence === 'OFFICIAL_EDITOR_MULTI'
    || requirement.evidence === 'USER_ATTESTED';
}

function validValue(value: GameplayValue, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((entry) => validValue(entry, depth + 1));
  const entries = Object.entries(value);
  return entries.length <= 10_000 && entries.every(([key, entry]) => PATH_PATTERN.test(key) && validValue(entry, depth + 1));
}

function reviewRef(ref: GameplayStateRef, location: string, findings: GameplayStaticFinding[]): void {
  if (!PATH_PATTERN.test(ref.path)) findings.push(finding('INVALID_STATE_PATH', 'error', `${location} 的状态路径无效。`, '使用有限的点分标识符路径。'));
  if (ref.playerId !== undefined && !ID_PATTERN.test(ref.playerId)) findings.push(finding('INVALID_PLAYER_ID', 'error', `${location} 的玩家标识无效。`, '使用场景声明的玩家标识。'));
}

function reviewExpression(expression: GameplayExpression, location: string, findings: GameplayStaticFinding[]): void {
  if (expression.kind === 'literal') {
    if (!validValue(expression.value)) findings.push(finding('INVALID_LITERAL', 'error', `${location} 包含非有限或过深的字面量。`, '缩小并修正字面量。'));
    return;
  }
  if (expression.kind === 'read') {
    reviewRef(expression.ref, location, findings);
    return;
  }
  if (expression.kind === 'not') {
    reviewExpression(expression.value, location, findings);
    return;
  }
  if ('values' in expression) {
    for (const child of expression.values) reviewExpression(child, location, findings);
    return;
  }
  reviewExpression(expression.left, location, findings);
  reviewExpression(expression.right, location, findings);
}

function reviewEffect(effect: GameplayEffect, side: 'server' | 'client', location: string, findings: GameplayStaticFinding[]): void {
  if (effect.kind === 'emit') {
    if (!EVENT_PATTERN.test(effect.event) || !Number.isSafeInteger(effect.delayMilliseconds) || effect.delayMilliseconds < 0) {
      findings.push(finding('INVALID_EMIT', 'error', `${location} 的事件或延迟无效。`, '使用白名单事件名和非负整数延迟。'));
    }
    return;
  }
  reviewRef(effect.target, location, findings);
  reviewExpression(effect.value, location, findings);
  if (side === 'server' && effect.target.scope === 'client') {
    findings.push(finding(
      'SERVER_WRITES_CLIENT_STATE',
      'error',
      `${location} 试图由服务端直接写入客户端本地状态。`,
      '服务端只写共享/玩家权威状态；需要更新界面时通过目标端事件单播给客户端。',
    ));
  }
  if (side === 'client' && effect.target.scope !== 'client') {
    findings.push(finding(
      'CLIENT_WRITES_SERVER_STATE',
      'error',
      `${location} 试图由客户端修改 ${effect.target.scope} 状态。`,
      '改为服务端处理共享/玩家权威状态，客户端只更新本地表现。',
    ));
  }
  if (side === 'client' && effect.target.playerId !== undefined && effect.allowCrossPlayer === true) {
    findings.push(finding(
      'CLIENT_CROSS_PLAYER_AUTHORITY_INVALID',
      'error',
      `${location} 试图在客户端授权写入玩家 ${effect.target.playerId} 的本机状态。`,
      '删除客户端跨玩家写入；由服务端使用真实回调玩家路由，再单播给目标客户端。',
    ));
  } else if (side === 'client' && effect.target.playerId !== undefined) {
    findings.push(finding(
      'HARDCODED_CROSS_PLAYER_TARGET',
      'error',
      `${location} 的客户端效果硬编码写入玩家 ${effect.target.playerId}。`,
      '使用回调玩家路由；确需跨玩家操作时必须放到服务端并显式授权。',
    ));
  } else if (side === 'server' && effect.target.playerId !== undefined && effect.allowCrossPlayer !== true) {
    findings.push(finding(
      'HARDCODED_PLAYER_TARGET',
      'error',
      `${location} 的服务端效果硬编码写入玩家 ${effect.target.playerId}。`,
      '使用事件回调玩家；确需指定玩家时显式设置 allowCrossPlayer 并完成多人审查。',
    ));
  }
}

export function reviewGameplayModel(model: GameplayModel): GameplayStaticFinding[] {
  const findings: GameplayStaticFinding[] = [];
  if (model.schemaVersion !== 1) findings.push(finding('UNSUPPORTED_MODEL_SCHEMA', 'error', '玩法模型版本不受支持。', '重新生成玩法模型。'));
  if (!ID_PATTERN.test(model.modelId)) findings.push(finding('INVALID_MODEL_ID', 'error', '玩法模型 ID 无效。', '使用稳定的匿名模型标识。'));
  for (const [scope, values] of Object.entries(model.initialState)) {
    if (!validValue(values)) findings.push(finding('INVALID_INITIAL_STATE', 'error', `${scope} 初始状态无效。`, '移除非有限、过深或过大的状态。'));
  }
  const handlerIds = new Set<string>();
  const branchIds = new Set<string>();
  const consumedEvents = new Set<string>();
  const emittedEvents = new Set<string>();
  const emittedTargets = new Map<string, Set<GameplayEventTargetSide>>();
  const handlerSides = new Map<string, Set<'server' | 'client'>>();
  for (const handler of model.handlers) {
    if (handlerIds.has(handler.handlerId)) findings.push(finding('DUPLICATE_HANDLER', 'error', `处理器 ${handler.handlerId} 重复。`, '为处理器设置唯一 ID。'));
    handlerIds.add(handler.handlerId);
    consumedEvents.add(handler.event);
    const sides = handlerSides.get(handler.event) ?? new Set<'server' | 'client'>();
    sides.add(handler.side);
    handlerSides.set(handler.event, sides);
    if (!EVENT_PATTERN.test(handler.event) || !ID_PATTERN.test(handler.handlerId) || handler.branches.length === 0) {
      findings.push(finding('INVALID_HANDLER', 'error', `处理器 ${handler.handlerId} 定义无效。`, '检查事件名、ID 和分支。'));
    }
    const defaultBranchIndexes = handler.branches.flatMap((branch, index) => branch.when === undefined ? [index] : []);
    if (defaultBranchIndexes.length > 1) findings.push(finding(
      'MULTIPLE_DEFAULT_BRANCHES', 'error', `处理器 ${handler.handlerId} 存在多个无条件默认分支。`, '只保留一个末尾默认分支。',
    ));
    if (defaultBranchIndexes.some((index) => index !== handler.branches.length - 1)) findings.push(finding(
      'DEFAULT_BRANCH_NOT_LAST', 'error', `处理器 ${handler.handlerId} 的无条件默认分支不是最后一个。`, '将默认分支移动到条件分支之后。',
    ));
    for (const branch of handler.branches) {
      const qualifiedBranch = `${handler.handlerId}:${branch.branchId}`;
      if (branchIds.has(qualifiedBranch) || !ID_PATTERN.test(branch.branchId)) findings.push(finding('DUPLICATE_BRANCH', 'error', `分支 ${qualifiedBranch} 无效或重复。`, '设置唯一分支 ID。'));
      branchIds.add(qualifiedBranch);
      if (branch.when !== undefined) reviewExpression(branch.when, qualifiedBranch, findings);
      for (const effect of branch.effects) {
        reviewEffect(effect, handler.side, qualifiedBranch, findings);
        if (effect.kind === 'emit') {
          emittedEvents.add(effect.event);
          if (effect.targetSide !== undefined) {
            const targets = emittedTargets.get(effect.event) ?? new Set<GameplayEventTargetSide>();
            targets.add(effect.targetSide);
            emittedTargets.set(effect.event, targets);
          }
        }
      }
    }
  }
  for (const event of emittedEvents) {
    if (!consumedEvents.has(event)) findings.push(finding('SIGNAL_WITHOUT_CONSUMER', 'warning', `事件 ${event} 没有接收处理器。`, '确认它是否是仅供日志的事件，否则补充接收者。'));
  }
  const external = new Set(model.externalEvents);
  for (const event of consumedEvents) {
    if (!external.has(event) && !emittedEvents.has(event)) findings.push(finding('SIGNAL_WITHOUT_PRODUCER', 'warning', `事件 ${event} 没有已建模发送者。`, '补充外部入口或事件发送效果。'));
  }
  for (const invariant of model.invariants) reviewRef(invariant.ref, `不变量 ${invariant.invariantId}`, findings);
  for (const requirement of model.evidenceRequirements) {
    if (requirement.state === 'confirmed' && !isGameplayEvidenceSatisfied(requirement)) findings.push(finding(
      'CONFIRMED_EVIDENCE_INSUFFICIENT', 'warning', `证据要求 ${requirement.requirementId} 被标为 confirmed，但证据等级不足。`,
      requirement.kind === 'network-ordering' ? '使用 OFFICIAL_EDITOR_MULTI 真实多人证据。' : '补充官方编辑器或明确用户验收证据。',
    ));
  }
  const policyEvents = new Set<string>();
  const policyTargets = new Map<string, GameplayEventTargetSide | undefined>();
  for (const policy of model.eventPolicies ?? []) {
    if (!EVENT_PATTERN.test(policy.event) || policyEvents.has(policy.event)) {
      findings.push(finding('INVALID_EVENT_POLICY', 'error', `事件策略 ${policy.event} 无效或重复。`, '每个事件只保留一个有效策略。'));
    }
    policyEvents.add(policy.event);
    policyTargets.set(policy.event, policy.targetSide);
    if (typeof policy.observableEffectRequired !== 'boolean') findings.push(finding(
      'INCOMPLETE_EVENT_POLICY', 'error', `事件策略 ${policy.event} 没有明确是否要求可观察结果。`, '显式设置 observableEffectRequired 为 true 或 false。',
    ));
  }
  for (const [event, sides] of handlerSides) {
    const target = policyTargets.get(event);
    if (sides.size > 1 && target === undefined) {
      findings.push(finding(
        'AMBIGUOUS_EVENT_TARGET_SIDE',
        'error',
        `事件 ${event} 同时存在客户端和服务端处理器，但没有声明目标端。`,
        '在 eventPolicies 中显式填写 targetSide，或拆分为不同事件。',
      ));
    }
    if ((target === 'server' && !sides.has('server')) || (target === 'client' && !sides.has('client'))) {
      findings.push(finding(
        'EVENT_TARGET_WITHOUT_HANDLER',
        'error',
        `事件 ${event} 声明的 ${target} 目标端没有处理器。`,
        '修正 targetSide 或补充对应端处理器。',
      ));
    }
    if (target === 'both' && (!sides.has('server') || !sides.has('client'))) {
      findings.push(finding(
        'BOTH_REQUIRES_BOTH_HANDLERS',
        'error',
        `事件 ${event} 声明同时投递客户端和服务端，但两端处理器不完整。`,
        '为客户端和服务端分别补充处理器，或收窄 targetSide。',
      ));
    }
  }
  for (const event of consumedEvents) {
    if (!policyEvents.has(event)) {
      findings.push(finding(
        'MISSING_EVENT_POLICY',
        'error',
        `可执行事件 ${event} 没有显式权威、玩家路由和目标端策略。`,
        '在 eventPolicies 中声明 authority、playerRequired、duplicatePolicy 和 targetSide。',
      ));
    }
  }
  for (const [event, targets] of emittedTargets) {
    const policyTarget = policyTargets.get(event);
    if (policyTarget !== undefined && [...targets].some((target) => target !== policyTarget)) findings.push(finding(
      'EVENT_TARGET_POLICY_CONFLICT', 'error', `事件 ${event} 的发送目标与 eventPolicies.targetSide 冲突。`, '删除局部 targetSide 覆盖并以事件策略为唯一目标端。',
    ));
  }
  return findings.sort((left, right) => {
    const severityOrder = { error: 0, warning: 1, info: 2 } as const;
    return severityOrder[left.severity] - severityOrder[right.severity] || left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'zh-CN');
  });
}

export function reviewGameplayStaticGate(
  model: GameplayModel,
  projectDiagnostics: readonly ProjectDiagnostic[] = [],
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata> = new Map(),
): GameplayStaticGate {
  const eventDocumentationDiagnostics = reviewGameplayEventDocumentation(model, eventMetadata);
  const findings = [
    ...reviewGameplayModel(model).map((entry) => ({ ...entry, source: 'model' as const })),
    ...projectDiagnostics.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      message: entry.message,
      evidence: 'STATIC_LOCAL' as const,
      nextAction: entry.nextAction,
      source: 'project' as const,
    })),
    ...eventDocumentationDiagnostics.map((entry) => ({
      code: entry.code,
      severity: entry.severity,
      message: entry.message,
      evidence: 'STATIC_LOCAL' as const,
      nextAction: entry.nextAction,
      source: 'event-documentation' as const,
    })),
  ].sort((left, right) => {
    const order = { error: 0, warning: 1, info: 2 } as const;
    return order[left.severity] - order[right.severity]
      || left.source.localeCompare(right.source, 'en')
      || left.code.localeCompare(right.code, 'en');
  });
  return {
    schemaVersion: 1,
    status: findings.some((entry) => entry.severity === 'error') ? 'blocked' : 'pass',
    findings,
  };
}

/**
 * 将生产环境使用的 Events 文档解析结果接入玩法静态门。
 * 只有明确使用官方 Events.* 名称的模型项才触发此门禁；普通自定义事件仍由
 * eventPolicies 负责。文档缺失、运行端/回调参数冲突或声明与 API 不匹配时一律阻断。
 */
export function reviewGameplayEventDocumentation(
  model: GameplayModel,
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata>,
): ProjectDiagnostic[] {
  const names = new Set<string>();
  for (const value of [...model.handlers.map((handler) => handler.event), ...(model.sceneEventBindings ?? []).flatMap((binding) => binding.eventName === null ? [] : [binding.eventName])]) {
    if (value.startsWith('Events.')) names.add(value.slice('Events.'.length));
  }
  const diagnostics: ProjectDiagnostic[] = [];
  for (const name of [...names].sort((left, right) => left.localeCompare(right, 'en'))) {
    const metadata = eventMetadata.get(name);
    if (metadata === undefined) {
      diagnostics.push({
        code: 'EVENT_DOCUMENTATION_BLOCKED', severity: 'error',
        message: `官方事件 Events.${name} 没有可用的声明/文档元数据。`,
        nextAction: '刷新官方 API 声明和 Events.md 后再确认玩法事件。', path: null, range: null,
        evidence: 'STATIC_LOCAL', runtimeVerified: false,
      });
      continue;
    }
    if (metadata.generationEligibility !== 'allowed') diagnostics.push({
      code: 'EVENT_DOCUMENTATION_BLOCKED', severity: 'error',
      message: `官方事件 Events.${name} 的运行端、回调参数或声明存在冲突，不能进入玩法门禁。${metadata.conflicts.join('；')}`,
      nextAction: '修正文档/API 声明冲突或将该事件标记为待确认，不要手工绕过门禁。', path: null, range: null,
      evidence: 'STATIC_LOCAL', runtimeVerified: false,
    });
  }
  return diagnostics;
}

export interface BuildGameplayKnowledgeDraftInput {
  project: Omit<GameplayModel['project'], 'knowledgeFingerprint'>;
  knowledgeFingerprint: string;
  sourceIndex: LuaSourceIndex;
  registry: RegistryDocument;
  uiSnapshot: UiSnapshot | null;
  sceneSnapshot: SceneSnapshot | null;
  runtimeCapabilities?: ReadonlyMap<string, CapabilityEvidenceResolution>;
  projectDiagnostics?: readonly ProjectDiagnostic[];
}

export function createGameplayKnowledgeFingerprint(input: {
  project: Omit<GameplayModel['project'], 'knowledgeFingerprint'>;
  luaFiles: readonly LuaSourceFile[];
  registry: RegistryDocument;
  uiSnapshot: UiSnapshot | null;
  sceneSnapshot: SceneSnapshot | null;
  runtimeCapabilities?: ReadonlyMap<string, CapabilityEvidenceResolution>;
}): string {
  return sha256Hex(stableJson({
    project: input.project,
    luaSources: [...input.luaFiles]
      .map((file) => ({ path: file.path, sha256: sha256Hex(file.source) }))
      .sort((left, right) => left.path.localeCompare(right.path, 'en')),
    registrySha256: sha256Hex(stableJson(input.registry)),
    uiSnapshotId: input.uiSnapshot?.snapshotId ?? null,
    sceneSnapshotId: input.sceneSnapshot?.snapshotId ?? null,
    runtimeCapabilities: [...(input.runtimeCapabilities ?? new Map()).entries()]
      .map(([instanceId, resolution]) => resolution.state === 'conflict'
        ? { instanceId, state: 'conflict' as const }
        : {
          instanceId, state: 'unique' as const,
          evidence: {
            snapshotId: resolution.evidence.snapshotId,
            sceneSourceSha256: resolution.evidence.sceneSourceSha256,
            characterState: resolution.evidence.characterState ?? 'error',
            creatureState: resolution.evidence.creatureState ?? 'error',
            elementState: resolution.evidence.elementState,
            logicElementState: resolution.evidence.logicElementState,
            playerState: resolution.evidence.playerState ?? 'error',
            triggerBoxState: resolution.evidence.triggerBoxState,
            triggerSampleState: resolution.evidence.triggerSampleState,
            triggerSample: resolution.evidence.triggerSample,
            fields: resolution.evidence.fields,
            fieldConflicts: resolution.evidence.fieldConflicts,
          },
        })
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en')),
  }));
}

export function gameplayModelFingerprint(model: GameplayModel): string {
  return sha256Hex(stableJson(model));
}

export interface GameplayEvidenceRefreshResult {
  model: GameplayModel;
  refreshed: boolean;
  changedKeys: Array<'mapFingerprint' | 'sceneSnapshotId' | 'knowledgeFingerprint'>;
}

/**
 * 将当前工程刚刚采集到的证据元数据重新绑定到既有玩法模型。
 *
 * 这里只更新地图/场景/知识指纹，不重写 handlers、eventPolicies、状态、
 * 分支或场景事件语义；因此地图保存后可以自动获得新证据，但不会把 AI
 * 猜测的玩法语义悄悄替换掉。工程实例 ID 不允许自动迁移，避免串图。
 */
export function refreshGameplayEvidence(
  model: GameplayModel,
  currentProject: GameplayModel['project'],
): GameplayEvidenceRefreshResult {
  if (model.project.projectInstanceId !== currentProject.projectInstanceId) {
    throw new ProductError(
      'VALIDATION_FAILED',
      '当前证据属于另一个工程，拒绝自动迁移玩法模型。',
      ['切换到玩法模型所属的元梦工程，或重新生成该工程的玩法草案。'],
      'STATIC_LOCAL',
    );
  }
  const changedKeys = (['mapFingerprint', 'sceneSnapshotId', 'knowledgeFingerprint'] as const)
    .filter((key) => model.project[key] !== currentProject[key]);
  if (changedKeys.length === 0) return { model, refreshed: false, changedKeys: [] };
  return {
    model: { ...model, project: { ...currentProject } },
    refreshed: true,
    changedKeys: [...changedKeys],
  };
}

/**
 * 仅当场景文件刷新造成模型证据指纹变化时，更新已确认场景的绑定元数据。
 * 对于本来就不是旧模型绑定的场景，保留原值，让模拟器继续明确报错而不是猜测。
 */
export function refreshGameplayScenarioBinding(
  scenario: GameplayScenario,
  previousModel: GameplayModel,
  currentModel: GameplayModel,
): GameplayScenario {
  const previousBinding = {
    modelId: previousModel.modelId,
    modelFingerprint: gameplayModelFingerprint(previousModel),
    ...previousModel.project,
  };
  if (stableJson(scenario.modelBinding) !== stableJson(previousBinding)) return scenario;
  return {
    ...scenario,
    modelBinding: {
      modelId: currentModel.modelId,
      modelFingerprint: gameplayModelFingerprint(currentModel),
      ...currentModel.project,
    },
  };
}

/**
 * 模型模拟器不执行真实 Lua/API 调用，因此“未知官方 API”不会影响有限状态
 * 模拟本身。该发现仍保留在严格 Codex 静态审查包中；这里只把它降为模拟阶段
 * 的警告，避免无关的全工程 API 索引问题阻塞 1/2/4/8 人流程探索。
 */
export function prepareGameplaySimulationDiagnostics(
  diagnostics: readonly ProjectDiagnostic[],
): ProjectDiagnostic[] {
  return diagnostics.map((entry) => entry.code === 'UNKNOWN_OFFICIAL_API' && entry.severity === 'error'
    ? {
      ...entry,
      severity: 'warning' as const,
      message: `${entry.message}（纯模型模拟不执行 Lua/API 调用，本项不阻断模拟；仍保留在严格静态审查中。）`,
      nextAction: '完成模型模拟后，单独核对该 API 的官方声明并通过官方编辑器验证。',
    }
    : entry);
}

const SIMULATION_STRICT_ONLY_DIAGNOSTIC_CODES = new Set<ProjectDiagnostic['code']>([
  'UNKNOWN_OFFICIAL_API',
  'OFFICIAL_API_UNAVAILABLE',
  'DUPLICATE_UI_NAME',
  'DUPLICATE_UI_ID',
  'STALE_UI_SNAPSHOT',
]);

const AUTO_SCENE_EVIDENCE_GAP_CODES = new Set<ProjectDiagnostic['code']>([
  'SCENE_EVENT_BINDING_REQUIRED',
  'SCENE_EVENT_BINDING_UNCONFIRMED',
  'SCENE_EVENT_BINDING_STALE',
  'SCENE_EVIDENCE_INSUFFICIENT',
  'SCENE_CAPABILITY_MISMATCH',
]);

function simulationFinding(
  code: string,
  severity: GameplayPreparationFinding['severity'],
  message: string,
  nextAction: string,
  evidence: GameplayPreparationFinding['evidence'] = [],
): GameplayPreparationFinding {
  return { code, severity, scope: 'artifact', message, nextAction, evidence };
}

function diagnosticSimulationFinding(
  diagnostic: ProjectDiagnostic,
  severity: GameplayPreparationFinding['severity'],
): GameplayPreparationFinding {
  return simulationFinding(
    diagnostic.code,
    severity,
    diagnostic.message,
    diagnostic.nextAction,
    diagnostic.path === null ? [] : [{
      path: diagnostic.path.replace(/\\/gu, '/'),
      line: diagnostic.range?.startLine ?? 1,
      column: diagnostic.range?.startColumn ?? 1,
    }],
  );
}

/**
 * 纯模型模拟只阻断会让输入不确定或不可执行的问题。严格静态审查仍保留
 * 全工程/API 发现，但不会因无关备份文件或未调用的官方 API 阻断模型探索。
 */
export function reviewGameplaySimulationEligibility(input: {
  model: GameplayModel;
  scenarios: readonly GameplayScenario[];
  productionPaths: ReadonlySet<string>;
  preparationFindings: readonly GameplayPreparationFinding[];
  projectDiagnostics: readonly ProjectDiagnostic[];
  /** Automatic preparation may run independent model flows while these gaps remain editor-only. */
  allowSceneEvidenceGaps?: boolean;
}): GameplaySimulationGate {
  const fatalFindings: GameplayPreparationFinding[] = input.preparationFindings
    .filter((entry) => entry.severity === 'fatal')
    .map((entry) => ({ ...entry, evidence: [...entry.evidence] }));
  const skippedFindings: GameplayPreparationFinding[] = input.preparationFindings
    .filter((entry) => entry.severity !== 'fatal')
    .map((entry) => ({ ...entry, evidence: [...entry.evidence] }));

  if (input.model.handlers.length === 0) fatalFindings.push(simulationFinding(
    'GAMEPLAY_NO_EXECUTABLE_HANDLERS', 'fatal', '玩法模型没有可执行处理器。', '补充至少一个来源明确的事件处理器后再模拟。',
  ));
  if (input.scenarios.length === 0) fatalFindings.push(simulationFinding(
    'GAMEPLAY_NO_EXECUTABLE_SCENARIOS', 'fatal', '没有可执行玩法场景。', '生成至少一个包含实际步骤的场景后再模拟。',
  ));

  const expectedBinding = {
    modelId: input.model.modelId,
    modelFingerprint: gameplayModelFingerprint(input.model),
    ...input.model.project,
  };
  for (const scenario of input.scenarios) {
    if (scenario.steps.length === 0) fatalFindings.push(simulationFinding(
      'GAMEPLAY_EMPTY_SCENARIO', 'fatal', `场景 ${scenario.scenarioId} 没有可执行步骤。`, '删除空场景或补充来源明确的分发、时序与断言步骤。',
    ));
    if (stableJson(scenario.modelBinding) !== stableJson(expectedBinding)) fatalFindings.push(simulationFinding(
      'GAMEPLAY_SCENARIO_BINDING_INVALID', 'fatal', `场景 ${scenario.scenarioId} 不属于当前玩法模型证据。`, '重新生成当前模型绑定的场景，禁止沿用旧工程或旧模型场景。',
    ));
  }

  for (const entry of reviewGameplayModel(input.model).filter((finding) => finding.severity === 'error')) {
    fatalFindings.push(simulationFinding(entry.code, 'fatal', entry.message, entry.nextAction));
  }

  const normalizedProductionPaths = new Set([...input.productionPaths].map((path) => path.replace(/\\/gu, '/')));
  for (const diagnostic of input.projectDiagnostics) {
    const sceneEvidenceGap = input.allowSceneEvidenceGaps === true && AUTO_SCENE_EVIDENCE_GAP_CODES.has(diagnostic.code);
    if (diagnostic.severity !== 'error' || SIMULATION_STRICT_ONLY_DIAGNOSTIC_CODES.has(diagnostic.code) || sceneEvidenceGap) {
      skippedFindings.push(diagnosticSimulationFinding(diagnostic, sceneEvidenceGap ? 'partial' : 'info'));
      continue;
    }
    const normalizedPath = diagnostic.path?.replace(/\\/gu, '/') ?? null;
    if (normalizedPath !== null && !normalizedProductionPaths.has(normalizedPath)) {
      skippedFindings.push(diagnosticSimulationFinding(diagnostic, 'info'));
      continue;
    }
    fatalFindings.push(diagnosticSimulationFinding(diagnostic, 'fatal'));
  }

  const sortFindings = (entries: GameplayPreparationFinding[]): GameplayPreparationFinding[] => entries.sort((left, right) => (
    left.code.localeCompare(right.code, 'en')
      || (left.evidence[0]?.path ?? '').localeCompare(right.evidence[0]?.path ?? '', 'en')
      || left.message.localeCompare(right.message, 'zh-CN')
  ));
  sortFindings(fatalFindings);
  sortFindings(skippedFindings);
  return {
    schemaVersion: 1,
    status: fatalFindings.length > 0 ? 'blocked' : 'pass',
    fatalFindings,
    skippedFindings,
  };
}

function sceneEventDiagnostic(
  code: Extract<ProjectDiagnostic['code'],
    | 'SCENE_EVENT_BINDING_REQUIRED'
    | 'SCENE_EVENT_BINDING_UNCONFIRMED'
    | 'SCENE_EVENT_BINDING_STALE'
    | 'SCENE_EVIDENCE_INSUFFICIENT'
    | 'SCENE_CAPABILITY_MISMATCH'>,
  message: string,
  nextAction: string,
): ProjectDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    nextAction,
    path: null,
    range: null,
    evidence: 'STATIC_LOCAL',
    runtimeVerified: false,
  };
}

const EVENT_BY_INTERACTION: Readonly<Record<Exclude<GameplaySceneEventBinding['interaction'], null>, string>> = {
  'character-enter-trigger': 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX',
  'character-leave-trigger': 'Events.ON_CHARACTER_LEAVE_SIGNAL_BOX',
  'element-enter-trigger': 'Events.ON_ELEMENT_ENTER_TRIGGER',
  'element-leave-trigger': 'Events.ON_ELEMENT_LEAVE_TRIGGER',
  'logic-element-enter-trigger': 'Events.ON_LOGIC_ACTOR_ENTER_TRIGGER',
  'logic-element-leave-trigger': 'Events.ON_LOGIC_ACTOR_LEAVE_TRIGGER',
  'creature-enter-trigger': 'Events.ON_CREATURE_ENTER_TRIGGER',
  'creature-leave-trigger': 'Events.ON_CREATURE_LEAVE_TRIGGER',
  'player-touch-element': 'Events.ON_PLAYER_TOUCH_ELEMENT',
  'element-touch-player': 'Events.ON_ELEMENT_TOUCH_PLAYER',
};

/**
 * Hard gate between scene object semantics and the gameplay model.
 * It never guesses which Lua handler owns an instance: only a trigger box that
 * the confirmed model explicitly references must be event-bound or deliberately
 * marked not-used. Unreferenced scene objects remain scene evidence, not model
 * obligations.
 */
export function reviewGameplaySceneEventBindings(
  model: GameplayModel,
  sceneSnapshot: SceneSnapshot | null,
  runtimeCapabilities: ReadonlyMap<string, CapabilityEvidenceResolution> = new Map(),
  sourceIndex?: LuaSourceIndex,
): ProjectDiagnostic[] {
  if (sceneSnapshot === null) return (model.sceneEventBindings ?? []).map((binding) => sceneEventDiagnostic(
    'SCENE_EVENT_BINDING_STALE',
    `事件绑定引用实例 ${binding.instanceId}，但当前没有场景快照可核对。`,
    '绑定并刷新当前地图的场景源后重新审查。',
  ));
  const diagnostics: ProjectDiagnostic[] = [];
  const instancesById = new Map<string, SceneSnapshot['instances']>();
  for (const instance of sceneSnapshot.instances) {
    const candidates = instancesById.get(instance.instanceId) ?? [];
    candidates.push(instance);
    instancesById.set(instance.instanceId, candidates);
  }
  const bindings = new Map((model.sceneEventBindings ?? []).map((binding) => [binding.instanceId, binding]));
  const requiredTriggerIds = new Set<string>();
  const ambiguousTriggerIds = new Set<string>();
  // idReferences also contains configuration literals and ordinary Element API
  // parameters. They are not event-dispatch ownership proof. Only an explicit
  // callback guard is strong enough to create a scene-event obligation here.
  const sourceReferencedSceneIds = new Set<string>();
  for (const call of sourceIndex?.calls ?? []) {
    for (const instanceId of call.sceneInstanceGuards ?? []) sourceReferencedSceneIds.add(instanceId);
  }

  for (const [instanceId, candidates] of instancesById) {
    if (candidates.length !== 1) {
      // 只有显式声明的 event-bound 绑定才进入事件门禁。地图中存在未参与本
      // 次玩法的信号盒，不代表玩法模型必须为它们逐个登记事件。
      if (bindings.get(instanceId)?.status === 'event-bound'
        && candidates.some((candidate) => resolveSceneInstanceIntelligence(candidate).actorFamily === 'trigger-box')) {
        ambiguousTriggerIds.add(instanceId);
        diagnostics.push(sceneEventDiagnostic(
          'SCENE_EVENT_BINDING_STALE',
          `信号触发盒实例 ID ${instanceId} 存在 ${candidates.length} 个候选，不能安全绑定事件。`,
          '先消除重复实例 ID 或换用可信快照，再确认进入事件。',
        ));
      }
      continue;
    }
    const runtime = runtimeCapabilities.get(instanceId) ?? null;
    const intelligence = resolveSceneInstanceIntelligence(
      candidates[0]!,
      runtime?.state === 'unique' ? runtime.evidence : null,
    );
    if (intelligence.actorFamily === 'trigger-box') {
      if (bindings.get(instanceId)?.status === 'event-bound') requiredTriggerIds.add(instanceId);
      if (sourceReferencedSceneIds.has(instanceId)) {
        requiredTriggerIds.add(instanceId);
        const binding = bindings.get(instanceId);
        if (binding === undefined || binding.status === 'not-used') diagnostics.push(sceneEventDiagnostic(
          'SCENE_EVENT_BINDING_REQUIRED',
          `生产 Lua 明确引用信号触发盒实例 ${instanceId}，但玩法模型没有可执行的事件绑定。`,
          '为该实例建立官方进入/离开事件、明确运行端和 handler；若无法确认则不要执行此流程模拟。',
        ));
      }
    }
  }

  for (const binding of [...bindings.values()].sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en'))) {
    const candidates = instancesById.get(binding.instanceId) ?? [];
    if (candidates.length !== 1) {
      if (ambiguousTriggerIds.has(binding.instanceId)) continue;
      diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVENT_BINDING_STALE',
        candidates.length === 0
          ? `事件绑定引用的场景实例 ${binding.instanceId} 已不存在。`
          : `事件绑定引用的场景实例 ${binding.instanceId} 存在重复候选，无法安全选择。`,
        '刷新场景并修正或消歧 sceneEventBindings 后重新审查。',
      ));
      continue;
    }
    if (binding.status === 'not-used') continue;
    if (binding.status === 'unconfirmed') {
      diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVENT_BINDING_UNCONFIRMED',
        `场景实例 ${binding.instanceId} 的事件绑定仍未确认。`,
        `核对实际 Lua 注册后，将 ${binding.eventName ?? '推荐事件'} 标记为 event-bound；若该实例不参与玩法则标记 not-used。`,
      ));
      continue;
    }
    const runtime = runtimeCapabilities.get(binding.instanceId) ?? null;
    if (runtime?.state === 'unique' && (
      runtime.evidence.instanceId !== binding.instanceId
      || runtime.evidence.snapshotId !== sceneSnapshot.snapshotId
      || runtime.evidence.sceneSourceSha256 !== sceneSnapshot.sourceSha256
    )) {
      diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVIDENCE_INSUFFICIENT',
        `场景实例 ${binding.instanceId} 的运行时证据不属于当前快照或当前场景源。`,
        '重新运行当前快照的对象族探针并导入最新日志。',
      ));
      continue;
    }
    if (runtime?.state === 'conflict') {
      diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVIDENCE_INSUFFICIENT',
        `场景实例 ${binding.instanceId} 有互相冲突的运行时对象族证据。`,
        '重新运行当前快照的对象族探针并消除冲突后再执行玩法模拟。',
      ));
      continue;
    }
    const intelligence = resolveSceneInstanceIntelligence(
      candidates[0]!,
      runtime?.state === 'unique' ? runtime.evidence : null,
    );
    const expectedRuntimeState = intelligence.actorFamily === 'trigger-box'
      ? runtime?.state === 'unique' ? runtime.evidence.triggerBoxState : null
      : intelligence.actorFamily === 'character'
        ? runtime?.state === 'unique' ? runtime.evidence.characterState ?? 'error' : null
        : intelligence.actorFamily === 'creature'
          ? runtime?.state === 'unique' ? runtime.evidence.creatureState ?? 'error' : null
      : intelligence.actorFamily === 'element'
        ? runtime?.state === 'unique' ? runtime.evidence.elementState : null
        : intelligence.actorFamily === 'logic-element'
          ? runtime?.state === 'unique' ? runtime.evidence.logicElementState : null
          : intelligence.actorFamily === 'player'
            ? runtime?.state === 'unique' ? runtime.evidence.playerState ?? 'error' : null
          : null;
    if (expectedRuntimeState === 'absent' || expectedRuntimeState === 'error') {
      diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVIDENCE_INSUFFICIENT',
        `场景实例 ${binding.instanceId} 的已校准类型与当前运行时对象族证据不一致。`,
        '重新运行对象族探针；在冲突消除前不执行该事件模型。',
      ));
      continue;
    }
    try {
      const expectedEvent = binding.interaction === null ? null : EVENT_BY_INTERACTION[binding.interaction];
      if (expectedEvent !== binding.eventName) {
        throw new ProductError(
          'SCENE_CAPABILITY_MISMATCH',
          `交互意图 ${binding.interaction ?? '未声明'} 必须使用 ${expectedEvent ?? '明确事件'}，不能使用 ${binding.eventName ?? '空事件'}。`,
          ['修正 sceneEventBindings 的 interaction 与 eventName，使其精确一致。'],
          'STATIC_LOCAL',
        );
      }
      assertSceneEventCompatible(intelligence, binding.eventName!);
    } catch (error) {
      if (!(error instanceof ProductError)) throw error;
      diagnostics.push(sceneEventDiagnostic(
        error.code === 'SCENE_CAPABILITY_MISMATCH' ? 'SCENE_CAPABILITY_MISMATCH' : 'SCENE_EVIDENCE_INSUFFICIENT',
        `场景实例 ${binding.instanceId}：${error.message}`,
        error.nextActions[0] ?? '根据对象族改用对应的官方事件。',
      ));
      continue;
    }
    const handler = model.handlers.find((candidate) => candidate.handlerId === binding.handlerId);
    const policy = model.eventPolicies?.find((candidate) => candidate.event === binding.eventName);
    const targetMatchesHandler = policy?.targetSide === 'both' || policy?.targetSide === handler?.side;
    if (!model.externalEvents.includes(binding.eventName!)
      || handler === undefined
      || handler.event !== binding.eventName
      || policy?.authority !== 'engine'
      || policy.playerRequired !== true
      || policy.targetSide === undefined
      || !targetMatchesHandler) {
      diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVENT_BINDING_UNCONFIRMED',
        `场景实例 ${binding.instanceId} 的 ${binding.eventName ?? '事件'} 尚未连接到完整的引擎事件处理链。`,
        '将事件加入 externalEvents，并用绑定的 handlerId 建立对应处理器；eventPolicies 必须声明 authority=engine、playerRequired=true 和明确 targetSide。',
      ));
      continue;
    }
    if (sourceIndex !== undefined) {
      const registrations = sourceIndex.calls.filter((call) => (
        (call.qualifiedName === 'System:RegisterEvent' || call.qualifiedName === 'System.RegisterEvent')
        && call.arguments[0]?.qualifiedName === binding.eventName
        && call.side.value === handler.side
      ));
      if (registrations.length === 0) diagnostics.push(sceneEventDiagnostic(
        'SCENE_EVENT_BINDING_UNCONFIRMED',
        `玩法模型声明了 ${binding.eventName}，但当前 ${handler.side} 端 Lua 索引未找到对应的 System:RegisterEvent 注册。`,
        '在正确端注册官方事件后重新建立 Lua 索引；不要只在 spec.json 中自报已绑定。',
      ));
      else if (requiredTriggerIds.size > 1 && !registrations.some((call) => call.sceneInstanceGuards?.includes(binding.instanceId))) {
        diagnostics.push(sceneEventDiagnostic(
          'SCENE_EVENT_BINDING_UNCONFIRMED',
          `当前场景有 ${requiredTriggerIds.size} 个信号触发盒，但 Lua 回调尚未证明只处理实例 ${binding.instanceId}。`,
          `在回调中用 signalBoxId 明确校验实例 ${binding.instanceId}，或提供可审计的全局分发表后重新建立 Lua 索引。`,
        ));
      }
    }
  }
  return diagnostics;
}

function graphNodeId(kind: GameplayKnowledgeNode['kind'], identity: string): string {
  return `${kind}:${sha256Hex(identity).slice(0, 20)}`;
}

function sideForPath(index: LuaSourceIndex, path: string): LuaSide {
  return index.files.find((file) => file.path === path)?.side.value ?? 'unknown';
}

function evidenceForConfidence(value: 'confirmed' | 'inferred' | 'candidate'): GameplayKnowledgeNode['evidence'] {
  return value;
}

function evidenceForSceneState(state: SceneSnapshot['instances'][number]['evidence']['state']): GameplayKnowledgeNode['evidence'] {
  if (state === 'confirmed-calibration') return 'confirmed';
  if (state === 'inferred-candidate' || state === 'unknown') return 'candidate';
  return 'inferred';
}

function boundedKnowledgeValue(value: unknown): string {
  const serialized = stableJson(value);
  return serialized.length <= 160 ? serialized : `${serialized.slice(0, 157)}...`;
}

/**
 * Builds an identity graph and a deliberately incomplete model draft.
 * It never infers economic meaning, state ownership, routing, or idempotency
 * from names. Those choices are emitted as explicit user-confirmation items.
 */
export function buildGameplayKnowledgeDraft(input: BuildGameplayKnowledgeDraftInput): GameplayKnowledgeDraft {
  const nodes = new Map<string, GameplayKnowledgeNode>();
  const edges = new Map<string, GameplayKnowledgeEdge>();
  const assumptions = new Map<string, GameplayDraftAssumption>();
  const addNode = (node: GameplayKnowledgeNode): void => { nodes.set(node.nodeId, node); };
  const addEdge = (kind: GameplayKnowledgeEdge['kind'], from: string, to: string): void => {
    const edgeId = `${kind}:${sha256Hex(`${from}\0${to}`).slice(0, 20)}`;
    edges.set(edgeId, { edgeId, kind, from, to });
  };
  const addAssumption = (
    kind: GameplayDraftAssumption['kind'],
    identity: string,
    prompt: string,
    evidenceNodeIds: string[],
  ): void => {
    const assumptionId = `${kind}:${sha256Hex(identity).slice(0, 20)}`;
    assumptions.set(assumptionId, { assumptionId, kind, status: 'needs-user-confirmation', prompt, evidenceNodeIds: [...new Set(evidenceNodeIds)].sort() });
  };

  // These are intentionally explicit questions, not name-based guesses. Once
  // confirmed, the existing invariant, event-policy and branch coverage engine
  // can enforce the declared bounds, idempotency and prerequisite paths.
  addAssumption('resource-bounds', 'global-resource-contracts', '逐项声明共享/每玩家资源的状态路径、最小值和最大值；未声明时不会猜测“金币”“库存”等变量名。', []);
  addAssumption('transaction-contract', 'global-transaction-contracts', '逐项声明购买、扣款、发奖等事务入口及幂等要求，并为重复投递建立回归场景。', []);
  addAssumption('task-prerequisite', 'global-task-prerequisites', '逐项声明领取/完成任务的前置状态与成功、拒绝分支；未覆盖分支不得通过。', []);
  addAssumption('upgrade-prerequisite', 'global-upgrade-prerequisites', '逐项声明升级入口的等级、资源和任务前置条件，以及失败时必须保持不变的状态。', []);

  const fileNodes = new Map<string, string>();
  for (const file of input.sourceIndex.files) {
    const nodeId = graphNodeId('lua-file', file.path);
    fileNodes.set(file.path, nodeId);
    addNode({ nodeId, kind: 'lua-file', label: file.path, externalId: null, evidence: file.side.value === 'unknown' ? 'candidate' : 'confirmed' });
  }

  const registryValueNodes = new Map<string, string[]>();
  for (const record of input.registry.records) {
    const nodeId = graphNodeId('registry-record', record.recordId);
    addNode({ nodeId, kind: 'registry-record', label: record.name, externalId: record.value, evidence: record.validity === 'confirmed' ? 'confirmed' : 'candidate' });
    const current = registryValueNodes.get(record.value) ?? [];
    current.push(nodeId);
    registryValueNodes.set(record.value, current);
  }

  const signalHandlers = new Map<string, { event: string; side: 'server' | 'client'; evidenceNodes: string[] }>();
  const luaSignalNodes = new Map<string, string[]>();
  for (const signal of input.sourceIndex.signalReferences) {
    const signalIdentity = `${signal.path}:${signal.line}:${signal.column}:${signal.value}:${signal.role}`;
    const nodeId = graphNodeId('lua-signal', signalIdentity);
    addNode({ nodeId, kind: 'lua-signal', label: signal.value, externalId: signal.value, evidence: evidenceForConfidence(signal.confidence) });
    luaSignalNodes.set(signal.value, [...(luaSignalNodes.get(signal.value) ?? []), nodeId]);
    const fileNode = fileNodes.get(signal.path);
    if (fileNode !== undefined) addEdge('declares', fileNode, nodeId);
    for (const registryNode of registryValueNodes.get(signal.value) ?? []) addEdge('same-value', nodeId, registryNode);
    const side = sideForPath(input.sourceIndex, signal.path);
    if (signal.role === 'listen' && (side === 'server' || side === 'client')) {
      const key = `${side}\0${signal.value}`;
      const current = signalHandlers.get(key) ?? { event: signal.value, side, evidenceNodes: [] };
      current.evidenceNodes.push(nodeId);
      signalHandlers.set(key, current);
    }
    addAssumption('signal-semantics', signal.value, `确认信号 ${signal.value} 的触发条件、参数、路由和预期结果。`, [nodeId]);
    addAssumption('state-ownership', `${signal.value}:${side}`, `确认信号 ${signal.value} 修改的是共享、每玩家还是客户端本机状态。`, [nodeId]);
    addAssumption('idempotency', signal.value, `确认信号 ${signal.value} 是否必须防止重复投递。`, [nodeId]);
  }

  const uiNodes = new Map<string, string>();
  for (const node of input.uiSnapshot?.nodes ?? []) {
    const nodeId = graphNodeId('ui-control', `${node.sourceFile}:${node.path}:${node.id}`);
    uiNodes.set(`${node.sourceFile}\0${node.id}`, nodeId);
    addNode({ nodeId, kind: 'ui-control', label: node.path, externalId: node.id, evidence: 'confirmed' });
    for (const registryNode of registryValueNodes.get(node.id) ?? []) addEdge('same-value', nodeId, registryNode);
    addAssumption('ui-result', `${node.sourceFile}:${node.path}`, `确认控件 ${node.path} 的点击入口和可观察结果。`, [nodeId]);
  }
  for (const node of input.uiSnapshot?.nodes ?? []) {
    if (node.parentId === null) continue;
    const child = uiNodes.get(`${node.sourceFile}\0${node.id}`);
    const parent = uiNodes.get(`${node.sourceFile}\0${node.parentId}`);
    if (child !== undefined && parent !== undefined) addEdge('parent-of', parent, child);
  }

  const sceneNodes = new Map<string, string[]>();
  const sceneOccurrenceNodes: string[] = [];
  const sceneEventBindings: GameplaySceneEventBinding[] = [];
  const sceneSignalNodes = new Map<string, string[]>();
  let hasCalibratedTriggerBox = false;
  // Keep scene-event draft obligations tied to explicit callback guards. A
  // configured signal-box ID can be used for placement/visibility without
  // being an event registration owned by this model.
  const sourceReferencedSceneIds = new Set<string>();
  for (const call of input.sourceIndex.calls) {
    for (const instanceId of call.sceneInstanceGuards ?? []) sourceReferencedSceneIds.add(instanceId);
  }
  const sceneInstanceCounts = new Map<string, number>();
  for (const instance of input.sceneSnapshot?.instances ?? []) {
    sceneInstanceCounts.set(instance.instanceId, (sceneInstanceCounts.get(instance.instanceId) ?? 0) + 1);
  }
  for (const [instanceIndex, instance] of (input.sceneSnapshot?.instances ?? []).entries()) {
    const runtime = sceneInstanceCounts.get(instance.instanceId) === 1
      ? input.runtimeCapabilities?.get(instance.instanceId) ?? null
      : null;
    const intelligence = resolveSceneInstanceIntelligence(
      instance,
      runtime?.state === 'unique' ? runtime.evidence : null,
    );
    const hasReferencedSignal = instance.signals.state === 'observed'
      && instance.signals.value.some((signal) => luaSignalNodes.has(signal.name));
    const isGameplayRelevant = sourceReferencedSceneIds.has(instance.instanceId)
      || hasReferencedSignal;
    hasCalibratedTriggerBox ||= intelligence.actorFamily === 'trigger-box';
    if (intelligence.actorFamily === 'trigger-box' && isGameplayRelevant && sceneInstanceCounts.get(instance.instanceId) === 1) {
      sceneEventBindings.push({
        instanceId: instance.instanceId,
        status: 'unconfirmed',
        interaction: 'character-enter-trigger',
        eventName: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX',
        handlerId: null,
      });
      addAssumption(
        'scene-event-capability',
        `scene-trigger-events:${instance.instanceId}`,
        `实例 ${instance.instanceId} 的信号触发盒同时具备角色进入 Events.ON_CHARACTER_ENTER_SIGNAL_BOX 与角色离开 Events.ON_CHARACTER_LEAVE_SIGNAL_BOX 能力；两者都应核对回调 playerId、signalBoxId、运行端和具体实例路由。`,
        [],
      );
    }
    const nodeId = graphNodeId('scene-instance', `${instance.instanceId}:${instanceIndex}`);
    const sameIdNodes = sceneNodes.get(instance.instanceId) ?? [];
    sameIdNodes.push(nodeId);
    sceneNodes.set(instance.instanceId, sameIdNodes);
    sceneOccurrenceNodes.push(nodeId);
    addNode({
      nodeId,
      kind: 'scene-instance',
      label: intelligence.canonicalName === null
        ? `scene:${instance.instanceId}`
        : `${intelligence.canonicalName} · scene:${instance.instanceId}`,
      externalId: instance.instanceId,
      evidence: instance.evidence.state === 'confirmed-calibration' ? 'confirmed' : 'inferred',
    });
    if (instance.signals.state === 'observed') {
      for (const [signalIndex, signal] of instance.signals.value.entries()) {
        const signalNodeId = graphNodeId('scene-signal', `instance:${instance.instanceId}:${instanceIndex}:${signalIndex}:${signal.name}`);
        addNode({
          nodeId: signalNodeId, kind: 'scene-signal', label: signal.name, externalId: signal.name,
          evidence: evidenceForSceneState(instance.signals.evidence.state),
        });
        addEdge('declares', nodeId, signalNodeId);
        for (const registryNode of registryValueNodes.get(signal.name) ?? []) addEdge('same-value', signalNodeId, registryNode);
        for (const luaNode of luaSignalNodes.get(signal.name) ?? []) addEdge('same-value', signalNodeId, luaNode);
        sceneSignalNodes.set(signal.name, [...(sceneSignalNodes.get(signal.name) ?? []), signalNodeId]);
      }
    }
    if (instance.customProperties.state === 'observed') {
      for (const [propertyIndex, property] of instance.customProperties.value.entries()) {
        const propertyNodeId = graphNodeId('scene-property', `${instance.instanceId}:${instanceIndex}:${propertyIndex}:${property.key}`);
        addNode({
          nodeId: propertyNodeId,
          kind: 'scene-property',
          label: `${property.key}=${boundedKnowledgeValue(property.value)}`,
          externalId: instance.instanceId,
          evidence: evidenceForSceneState(instance.customProperties.evidence.state),
        });
        addEdge('declares', nodeId, propertyNodeId);
      }
    }
    for (const registryNode of registryValueNodes.get(instance.instanceId) ?? []) addEdge('same-value', nodeId, registryNode);
    if (isGameplayRelevant) {
      addAssumption('scene-meaning', instance.instanceId, `确认场景实例 ${instance.instanceId} 在玩法中的职责和必要空间断言。`, [nodeId]);
      const eventPrompt = intelligence.actorFamily === 'trigger-box'
        ? `实例 ${instance.instanceId} 已校准为信号触发盒；角色进入必须使用 Events.ON_CHARACTER_ENTER_SIGNAL_BOX，不能用 ON_PLAYER_TOUCH_ELEMENT 代替。`
        : intelligence.actorFamily === 'element'
          ? `实例 ${instance.instanceId} 是普通元件候选；只有运行时确认属于 Element 且已开启碰撞时，普通触碰事件才适用。`
          : intelligence.actorFamily === 'unknown'
            ? `实例 ${instance.instanceId} 的对象族未知；必须先运行对象族分类探针，再选择进入、碰撞或专用事件。`
            : `实例 ${instance.instanceId} 属于 ${intelligence.canonicalName ?? intelligence.actorFamily}；不能仅因存在场景实例 ID 就套用普通碰撞事件。`;
      addAssumption('scene-event-compatibility', `scene-event:${instance.instanceId}:${instanceIndex}`, eventPrompt, [nodeId]);
    }
  }
  for (const [instanceId, candidates] of sceneNodes) {
    if (candidates.length > 1) addAssumption(
      'scene-meaning',
      `duplicate-instance:${instanceId}`,
      `场景实例 ID ${instanceId} 存在 ${candidates.length} 个候选；父子、注册表和玩法职责必须人工消歧。`,
      candidates,
    );
  }
  for (const [instanceIndex, instance] of (input.sceneSnapshot?.instances ?? []).entries()) {
    if (instance.ownerId === null) continue;
    const child = sceneOccurrenceNodes[instanceIndex]!;
    for (const parent of sceneNodes.get(instance.ownerId) ?? []) if (parent !== child) addEdge('parent-of', parent, child);
  }
  const groupNodes = new Map<string, string[]>();
  const groupOccurrenceNodes: string[] = [];
  for (const [groupIndex, group] of (input.sceneSnapshot?.groups ?? []).entries()) {
    const groupNode = graphNodeId('scene-group', `${group.groupId}:${groupIndex}`);
    const sameIdNodes = groupNodes.get(group.groupId) ?? [];
    sameIdNodes.push(groupNode);
    groupNodes.set(group.groupId, sameIdNodes);
    groupOccurrenceNodes.push(groupNode);
    addNode({ nodeId: groupNode, kind: 'scene-group', label: `group:${group.groupId}`, externalId: group.groupId, evidence: group.evidence.state === 'confirmed-calibration' ? 'confirmed' : 'inferred' });
    if (group.metadata?.state === 'observed') {
      const metadataNodeId = graphNodeId('scene-metadata', `group:${group.groupId}:${groupIndex}`);
      addNode({
        nodeId: metadataNodeId,
        kind: 'scene-metadata',
        label: `编组 ${group.groupId} 元数据候选${group.metadata.value.labelCandidate === null ? '' : `：${group.metadata.value.labelCandidate}`}`,
        externalId: group.groupId,
        evidence: evidenceForConfidence(group.metadata.evidence.state === 'observed-repeatable' ? 'inferred' : 'candidate'),
      });
      addEdge('declares', groupNode, metadataNodeId);
    }
    for (const memberId of group.memberIds) {
      for (const member of sceneNodes.get(memberId) ?? []) addEdge('member-of', member, groupNode);
    }
  }
  for (const [groupIndex, group] of (input.sceneSnapshot?.groups ?? []).entries()) {
    const parent = groupOccurrenceNodes[groupIndex]!;
    for (const nestedId of group.nestedGroupIds) {
      for (const nested of groupNodes.get(nestedId) ?? []) if (nested !== parent) addEdge('member-of', nested, parent);
    }
  }
  for (const [groupId, candidates] of groupNodes) {
    if (candidates.length > 1) addAssumption(
      'scene-meaning',
      `duplicate-group:${groupId}`,
      `编组 ID ${groupId} 存在 ${candidates.length} 个候选；成员和嵌套关系按全部候选保留，必须人工确认唯一对象。`,
      candidates,
    );
  }

  if (input.sceneSnapshot?.signalRegistry?.state === 'observed') {
    for (const [signalIndex, signal] of input.sceneSnapshot.signalRegistry.value.entries()) {
      const signalNodeId = graphNodeId('scene-signal', `root:${signalIndex}:${signal.name}`);
      addNode({
        nodeId: signalNodeId,
        kind: 'scene-signal',
        label: `${signal.name}${signal.ambiguous === true ? '（同名歧义）' : ''}${signal.unknownFields === undefined ? '' : `（未知字段 ${signal.unknownFields.length}）`}`,
        externalId: signal.name,
        evidence: evidenceForSceneState(input.sceneSnapshot.signalRegistry.evidence.state),
      });
      for (const registryNode of registryValueNodes.get(signal.name) ?? []) addEdge('same-value', signalNodeId, registryNode);
      for (const luaNode of luaSignalNodes.get(signal.name) ?? []) addEdge('same-value', signalNodeId, luaNode);
      sceneSignalNodes.set(signal.name, [...(sceneSignalNodes.get(signal.name) ?? []), signalNodeId]);
    }
  }
  for (const [signalName, evidenceNodeIds] of sceneSignalNodes) {
    addAssumption('signal-semantics', `scene-signal:${signalName}`, `确认场景信号 ${signalName} 的发送者、接收者、参数和触发结果。`, evidenceNodeIds);
  }
  const sceneMetadata = input.sceneSnapshot?.sceneMetadata;
  if (sceneMetadata?.layerName.state === 'observed') addNode({
    nodeId: graphNodeId('scene-metadata', `layer:${sceneMetadata.layerName.value}`),
    kind: 'scene-metadata',
    label: `图层名称候选：${sceneMetadata.layerName.value}`,
    externalId: null,
    evidence: evidenceForSceneState(sceneMetadata.layerName.evidence.state),
  });
  if (sceneMetadata?.editorVersionCandidate.state === 'observed') addNode({
    nodeId: graphNodeId('scene-metadata', `editor-version:${sceneMetadata.editorVersionCandidate.value}`),
    kind: 'scene-metadata',
    label: `场景版本文本候选：${sceneMetadata.editorVersionCandidate.value}`,
    externalId: null,
    evidence: evidenceForSceneState(sceneMetadata.editorVersionCandidate.evidence.state),
  });
  if (sceneMetadata?.instanceIndex.state === 'observed') addNode({
    nodeId: graphNodeId('scene-metadata', `instance-index:${sceneMetadata.instanceIndex.value.entryCount}`),
    kind: 'scene-metadata',
    label: `实例索引：${sceneMetadata.instanceIndex.value.entryCount} 条${sceneMetadata.instanceIndex.value.unknownFields === undefined ? '' : `，未知字段 ${sceneMetadata.instanceIndex.value.unknownFields.length} 条`}`,
    externalId: null,
    evidence: evidenceForSceneState(sceneMetadata.instanceIndex.evidence.state),
  });

  const handlers = [...signalHandlers.values()].sort((left, right) => left.event.localeCompare(right.event, 'en') || left.side.localeCompare(right.side, 'en')).map((entry) => ({
    handlerId: `draft-${entry.side}-${sha256Hex(entry.event).slice(0, 12)}`,
    event: entry.event,
    side: entry.side,
    branches: [{ branchId: 'unmodeled', effects: [], coverageRequired: false }],
  }));
  const sceneSnapshotId = input.sceneSnapshot?.snapshotId ?? input.project.sceneSnapshotId;
  const triggerBoxTouchReviewRequired = hasCalibratedTriggerBox && input.sourceIndex.calls.some((call) => (
    call.context.includes('Events.ON_PLAYER_TOUCH_ELEMENT')
  ));
  const evidenceRequirements: GameplayEvidenceRequirement[] = [{
    requirementId: 'real-multiplayer-network-order',
    kind: 'network-ordering',
    state: 'unverified',
    description: '在官方编辑器真实多人房间验证广播、单播、同时操作、断线重连和迟到回调顺序。',
  }];
  if (input.sceneSnapshot !== null) evidenceRequirements.push(
    {
      requirementId: 'scene-spatial-bounds', kind: 'scene-bounds', state: 'unverified',
      description: '确认本次场景快照中的关键高度、边界、重叠和摆放关系仍与玩法规格一致。',
    },
    {
      requirementId: 'scene-physics-contact', kind: 'physics-contact', state: 'unverified',
      description: '在官方编辑器中验证碰撞、接触、承托和射线结果；静态场景解析不能代替物理运行。',
    },
    {
      requirementId: 'scene-npc-reachability-if-used', kind: 'npc-reachability', state: 'unverified',
      description: '若玩法使用 NPC，需在官方编辑器确认出生点、路径、高度和目标可达；草案不会从名称猜测 NPC。',
    },
  );
  const model: GameplayModel = {
    schemaVersion: 1,
    modelId: `draft-${sha256Hex(`${input.project.projectInstanceId}\0${input.knowledgeFingerprint}`).slice(0, 20)}`,
    project: { ...input.project, sceneSnapshotId, knowledgeFingerprint: input.knowledgeFingerprint },
    externalEvents: [],
    initialState: { shared: {}, player: {}, client: {} },
    handlers,
    invariants: [],
    evidenceRequirements,
    ...(sceneEventBindings.length === 0 ? {} : {
      sceneEventBindings: sceneEventBindings.sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en')),
    }),
    multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
  };
  return {
    schemaVersion: 1,
    requiresUserConfirmation: true,
    model,
    graph: {
      schemaVersion: 1,
      nodes: [...nodes.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId, 'en')),
      edges: [...edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId, 'en')),
    },
    assumptions: [...assumptions.values()].sort((left, right) => left.assumptionId.localeCompare(right.assumptionId, 'en')),
    sourceFindings: [
      ...(input.projectDiagnostics ?? []).map((entry) => finding(entry.code, entry.severity, entry.message, entry.nextAction)),
      ...(triggerBoxTouchReviewRequired ? [finding(
        'TRIGGER_BOX_TOUCH_EVENT_REVIEW_REQUIRED',
        'warning',
        '工程同时存在已校准的信号触发盒和 ON_PLAYER_TOUCH_ELEMENT 注册；静态索引无法仅凭这一行证明事件目标相同。',
        '将事件绑定到具体实例；若目标是信号触发盒，改用 Events.ON_CHARACTER_ENTER_SIGNAL_BOX。',
      )] : []),
      ...(input.sceneSnapshot?.issues ?? []).map((entry) => finding(
        `SCENE_${entry.code}`,
        'warning',
        entry.message,
        '先在场景检查视图确认该关系问题是否影响玩法，再决定修复或记录为已知限制。',
      )),
    ].sort((left, right) => left.code.localeCompare(right.code, 'en') || left.message.localeCompare(right.message, 'zh-CN')),
  };
}
