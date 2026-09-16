import { ProductError } from '../errors.js';
import { EVIDENCE_LEVELS } from '../model.js';
import type {
  GameplayEffect,
  GameplayExpression,
  GameplayModel,
  GameplayScenario,
  GameplayStateRef,
  GameplayValue,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const DECIMAL_ID_PATTERN = /^[0-9]{1,32}$/u;
const EVENT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,15}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTION = 10_000;
const MAX_VALUE_DEPTH = 16;
const MAX_EXPRESSION_DEPTH = 24;
const MAX_VALUE_NODES = 100_000;

function fail(path: string, message: string): never {
  throw new ProductError('VALIDATION_FAILED', `${path}: ${message}`, ['只使用玩法助手声明的封闭 Schema，并缩小输入。'], 'STATIC_LOCAL');
}

function documentSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('$', '输入必须是可序列化的无环 JSON');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) fail('$', '文档大小超过 2 MiB 上限');
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, '必须是对象');
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in record)) fail(`${path}.${key}`, '缺少字段');
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${path}.${key}`, '包含未知字段');
}

function arrayAt(value: unknown, path: string, maximum = MAX_COLLECTION): unknown[] {
  if (!Array.isArray(value)) fail(path, '必须是数组');
  if (value.length > maximum) fail(path, `数组长度超过 ${maximum} 上限`);
  return value;
}

function stringAt(value: unknown, path: string, pattern?: RegExp, maximum = 2_048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || (pattern !== undefined && !pattern.test(value))) {
    fail(path, '字符串无效或超过上限');
  }
  return value;
}

function enumAt<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `必须是 ${allowed.join(', ')}`);
  return value as T;
}

function integerAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(path, `必须是 ${minimum} 到 ${maximum} 的整数`);
  return value as number;
}

function valueAt(value: unknown, path: string, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_VALUE_NODES) fail(path, '值节点数量超过上限');
  if (depth > MAX_VALUE_DEPTH) fail(path, '值嵌套深度超过上限');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > 16_384) fail(path, '字符串长度超过上限');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, '数值必须有限');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION) fail(path, '数组长度超过上限');
    value.forEach((entry, index) => valueAt(entry, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  const record = recordAt(value, path);
  const entries = Object.entries(record);
  if (entries.length > MAX_COLLECTION) fail(path, '对象字段数超过上限');
  for (const [key, entry] of entries) {
    if (!PATH_PATTERN.test(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') fail(`${path}.${key}`, '状态字段名无效');
    valueAt(entry, `${path}.${key}`, depth + 1, budget);
  }
}

function refAt(value: unknown, path: string): void {
  const record = recordAt(value, path);
  exactKeys(record, ['scope', 'path'], ['playerId'], path);
  enumAt(record.scope, ['shared', 'player', 'client'] as const, `${path}.scope`);
  stringAt(record.path, `${path}.path`, PATH_PATTERN);
  if (record.playerId !== undefined) stringAt(record.playerId, `${path}.playerId`, ID_PATTERN);
}

function expressionAt(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_EXPRESSION_DEPTH) fail(path, '表达式嵌套深度超过上限');
  const record = recordAt(value, path);
  const kind = enumAt(record.kind, ['literal', 'read', 'not', 'all', 'any', 'compare'] as const, `${path}.kind`);
  if (kind === 'literal') {
    exactKeys(record, ['kind', 'value'], [], path);
    valueAt(record.value, `${path}.value`, 0, { nodes: 0 });
  } else if (kind === 'read') {
    exactKeys(record, ['kind', 'ref'], [], path);
    refAt(record.ref, `${path}.ref`);
  } else if (kind === 'not') {
    exactKeys(record, ['kind', 'value'], [], path);
    expressionAt(record.value, `${path}.value`, depth + 1);
  } else if (kind === 'all' || kind === 'any') {
    exactKeys(record, ['kind', 'values'], [], path);
    arrayAt(record.values, `${path}.values`, 256).forEach((entry, index) => expressionAt(entry, `${path}.values[${index}]`, depth + 1));
  } else {
    exactKeys(record, ['kind', 'operator', 'left', 'right'], [], path);
    enumAt(record.operator, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const, `${path}.operator`);
    expressionAt(record.left, `${path}.left`, depth + 1);
    expressionAt(record.right, `${path}.right`, depth + 1);
  }
}

function effectAt(value: unknown, path: string): void {
  const record = recordAt(value, path);
  const kind = enumAt(record.kind, ['set', 'add', 'emit'] as const, `${path}.kind`);
  if (kind === 'emit') {
    exactKeys(record, ['kind', 'event', 'delayMilliseconds'], ['routing', 'targetSide'], path);
    stringAt(record.event, `${path}.event`, EVENT_PATTERN);
    integerAt(record.delayMilliseconds, `${path}.delayMilliseconds`, 0, 86_400_000);
    if (record.routing !== undefined) enumAt(record.routing, ['same-player', 'broadcast', 'without-player'] as const, `${path}.routing`);
    if (record.targetSide !== undefined) enumAt(record.targetSide, ['server', 'client', 'both'] as const, `${path}.targetSide`);
  } else {
    exactKeys(record, ['kind', 'target', 'value'], ['allowCrossPlayer'], path);
    refAt(record.target, `${path}.target`);
    expressionAt(record.value, `${path}.value`);
    if (record.allowCrossPlayer !== undefined && typeof record.allowCrossPlayer !== 'boolean') fail(`${path}.allowCrossPlayer`, '必须是布尔值');
  }
}

function modelAt(value: unknown): void {
  const model = recordAt(value, '$');
  exactKeys(model, ['schemaVersion', 'modelId', 'project', 'externalEvents', 'initialState', 'handlers', 'invariants', 'evidenceRequirements'], ['eventPolicies', 'sceneEventBindings', 'multiplayer'], '$');
  if (model.schemaVersion !== 1) fail('$.schemaVersion', '必须为 1');
  stringAt(model.modelId, '$.modelId', ID_PATTERN);
  const project = recordAt(model.project, '$.project');
  exactKeys(project, ['projectInstanceId', 'mapFingerprint', 'sceneSnapshotId', 'knowledgeFingerprint'], [], '$.project');
  stringAt(project.projectInstanceId, '$.project.projectInstanceId', UUID_PATTERN);
  if (project.mapFingerprint !== null) stringAt(project.mapFingerprint, '$.project.mapFingerprint', SHA_PATTERN);
  if (project.sceneSnapshotId !== null) stringAt(project.sceneSnapshotId, '$.project.sceneSnapshotId', SHA_PATTERN);
  stringAt(project.knowledgeFingerprint, '$.project.knowledgeFingerprint', SHA_PATTERN);
  arrayAt(model.externalEvents, '$.externalEvents').forEach((event, index) => stringAt(event, `$.externalEvents[${index}]`, EVENT_PATTERN));
  if (model.eventPolicies !== undefined) arrayAt(model.eventPolicies, '$.eventPolicies').forEach((candidate, index) => {
    const path = `$.eventPolicies[${index}]`;
    const policy = recordAt(candidate, path);
    exactKeys(policy, ['event', 'authority', 'playerRequired', 'duplicatePolicy', 'observableEffectRequired'], ['completion', 'targetSide'], path);
    stringAt(policy.event, `${path}.event`, EVENT_PATTERN);
    enumAt(policy.authority, ['client-request', 'server-only', 'engine'] as const, `${path}.authority`);
    if (typeof policy.playerRequired !== 'boolean') fail(`${path}.playerRequired`, '必须是布尔值');
    enumAt(policy.duplicatePolicy, ['allow', 'must-be-idempotent'] as const, `${path}.duplicatePolicy`);
    if (policy.completion !== undefined) enumAt(policy.completion, ['must-drain', 'may-remain'] as const, `${path}.completion`);
    if (policy.targetSide !== undefined) enumAt(policy.targetSide, ['server', 'client', 'both'] as const, `${path}.targetSide`);
    if (typeof policy.observableEffectRequired !== 'boolean') fail(`${path}.observableEffectRequired`, '必须是布尔值');
  });
  const initial = recordAt(model.initialState, '$.initialState');
  exactKeys(initial, ['shared', 'player', 'client'], [], '$.initialState');
  for (const scope of ['shared', 'player', 'client'] as const) valueAt(initial[scope], `$.initialState.${scope}`, 0, { nodes: 0 });
  arrayAt(model.handlers, '$.handlers').forEach((candidate, handlerIndex) => {
    const path = `$.handlers[${handlerIndex}]`;
    const handler = recordAt(candidate, path);
    exactKeys(handler, ['handlerId', 'event', 'side', 'branches'], [], path);
    stringAt(handler.handlerId, `${path}.handlerId`, ID_PATTERN);
    stringAt(handler.event, `${path}.event`, EVENT_PATTERN);
    enumAt(handler.side, ['server', 'client'] as const, `${path}.side`);
    const branches = arrayAt(handler.branches, `${path}.branches`);
    if (branches.length === 0) fail(`${path}.branches`, '至少需要一个分支');
    branches.forEach((branchValue, branchIndex) => {
      const branchPath = `${path}.branches[${branchIndex}]`;
      const branch = recordAt(branchValue, branchPath);
      exactKeys(branch, ['branchId', 'effects'], ['when', 'coverageRequired'], branchPath);
      stringAt(branch.branchId, `${branchPath}.branchId`, ID_PATTERN);
      if (branch.when !== undefined) expressionAt(branch.when, `${branchPath}.when`);
      if (branch.coverageRequired !== undefined && typeof branch.coverageRequired !== 'boolean') fail(`${branchPath}.coverageRequired`, '必须是布尔值');
      arrayAt(branch.effects, `${branchPath}.effects`).forEach((effect, effectIndex) => effectAt(effect, `${branchPath}.effects[${effectIndex}]`));
    });
  });
  arrayAt(model.invariants, '$.invariants').forEach((candidate, index) => {
    const path = `$.invariants[${index}]`;
    const invariant = recordAt(candidate, path);
    const kind = enumAt(invariant.kind, ['non-negative', 'range', 'equals'] as const, `${path}.kind`);
    if (kind === 'non-negative') exactKeys(invariant, ['invariantId', 'kind', 'ref'], [], path);
    else if (kind === 'range') exactKeys(invariant, ['invariantId', 'kind', 'ref'], ['minimum', 'maximum'], path);
    else exactKeys(invariant, ['invariantId', 'kind', 'ref', 'value'], [], path);
    stringAt(invariant.invariantId, `${path}.invariantId`, ID_PATTERN);
    refAt(invariant.ref, `${path}.ref`);
    if (kind === 'range') {
      if (invariant.minimum !== undefined && (typeof invariant.minimum !== 'number' || !Number.isFinite(invariant.minimum))) fail(`${path}.minimum`, '必须是有限数值');
      if (invariant.maximum !== undefined && (typeof invariant.maximum !== 'number' || !Number.isFinite(invariant.maximum))) fail(`${path}.maximum`, '必须是有限数值');
    } else if (kind === 'equals') valueAt(invariant.value, `${path}.value`, 0, { nodes: 0 });
  });
  arrayAt(model.evidenceRequirements, '$.evidenceRequirements').forEach((candidate, index) => {
    const path = `$.evidenceRequirements[${index}]`;
    const requirement = recordAt(candidate, path);
    exactKeys(requirement, ['requirementId', 'kind', 'state', 'description'], ['evidence'], path);
    stringAt(requirement.requirementId, `${path}.requirementId`, ID_PATTERN);
    enumAt(requirement.kind, ['npc-reachability', 'physics-contact', 'camera-appearance', 'network-ordering', 'scene-bounds'] as const, `${path}.kind`);
    enumAt(requirement.state, ['confirmed', 'unverified', 'stale'] as const, `${path}.state`);
    stringAt(requirement.description, `${path}.description`);
    if (requirement.evidence !== undefined) enumAt(requirement.evidence, EVIDENCE_LEVELS, `${path}.evidence`);
  });
  if (model.sceneEventBindings !== undefined) {
    const instanceIds: string[] = [];
    arrayAt(model.sceneEventBindings, '$.sceneEventBindings').forEach((candidate, index) => {
      const path = `$.sceneEventBindings[${index}]`;
      const binding = recordAt(candidate, path);
      exactKeys(binding, ['instanceId', 'status', 'interaction', 'eventName', 'handlerId'], [], path);
      instanceIds.push(stringAt(binding.instanceId, `${path}.instanceId`, DECIMAL_ID_PATTERN));
      const status = enumAt(binding.status, ['unconfirmed', 'event-bound', 'not-used'] as const, `${path}.status`);
      if (status === 'not-used') {
        if (binding.interaction !== null) fail(`${path}.interaction`, 'not-used 时必须为 null');
        if (binding.eventName !== null) fail(`${path}.eventName`, 'not-used 时必须为 null');
        if (binding.handlerId !== null) fail(`${path}.handlerId`, 'not-used 时必须为 null');
      } else {
        enumAt(binding.interaction, [
          'character-enter-trigger', 'character-leave-trigger',
          'element-enter-trigger', 'element-leave-trigger',
          'logic-element-enter-trigger', 'logic-element-leave-trigger',
          'creature-enter-trigger', 'creature-leave-trigger',
          'player-touch-element', 'element-touch-player',
        ] as const, `${path}.interaction`);
        stringAt(binding.eventName, `${path}.eventName`, EVENT_PATTERN);
        if (status === 'event-bound') stringAt(binding.handlerId, `${path}.handlerId`, ID_PATTERN);
        else if (binding.handlerId !== null) fail(`${path}.handlerId`, 'unconfirmed 时必须为 null');
      }
    });
    if (new Set(instanceIds).size !== instanceIds.length) fail('$.sceneEventBindings', '实例 ID 不能重复');
  }
  if (model.multiplayer !== undefined) {
    const multiplayer = recordAt(model.multiplayer, '$.multiplayer');
    exactKeys(multiplayer, ['maximumPlayers', 'rejoinPolicy'], [], '$.multiplayer');
    integerAt(multiplayer.maximumPlayers, '$.multiplayer.maximumPlayers', 1, 64);
    enumAt(multiplayer.rejoinPolicy, ['retain-player-reset-client', 'reset-all'] as const, '$.multiplayer.rejoinPolicy');
  }
}

function dispatchAt(value: unknown, path: string, includesKind: boolean): void {
  const action = recordAt(value, path);
  exactKeys(action, includesKind ? ['kind', 'event'] : ['event'], ['playerId', 'source', 'deliveryId', 'targetSide'], path);
  if (includesKind && action.kind !== 'dispatch') fail(`${path}.kind`, '必须为 dispatch');
  stringAt(action.event, `${path}.event`, EVENT_PATTERN);
  if (action.playerId !== undefined) stringAt(action.playerId, `${path}.playerId`, ID_PATTERN);
  if (action.source !== undefined) enumAt(action.source, ['client', 'server', 'engine'] as const, `${path}.source`);
  if (action.deliveryId !== undefined) stringAt(action.deliveryId, `${path}.deliveryId`, ID_PATTERN);
  if (action.targetSide !== undefined) enumAt(action.targetSide, ['server', 'client', 'both'] as const, `${path}.targetSide`);
}

function scenarioAt(value: unknown): void {
  const scenario = recordAt(value, '$');
  exactKeys(scenario, ['schemaVersion', 'scenarioId', 'name', 'modelBinding', 'players', 'limits', 'steps'], ['exploreReadyEventInterleavings', 'initialConnectedPlayers'], '$');
  if (scenario.schemaVersion !== 1) fail('$.schemaVersion', '必须为 1');
  stringAt(scenario.scenarioId, '$.scenarioId', ID_PATTERN);
  stringAt(scenario.name, '$.name');
  const binding = recordAt(scenario.modelBinding, '$.modelBinding');
  exactKeys(binding, ['modelId', 'modelFingerprint', 'projectInstanceId', 'mapFingerprint', 'sceneSnapshotId', 'knowledgeFingerprint'], [], '$.modelBinding');
  stringAt(binding.modelId, '$.modelBinding.modelId', ID_PATTERN);
  stringAt(binding.modelFingerprint, '$.modelBinding.modelFingerprint', SHA_PATTERN);
  stringAt(binding.projectInstanceId, '$.modelBinding.projectInstanceId', UUID_PATTERN);
  if (binding.mapFingerprint !== null) stringAt(binding.mapFingerprint, '$.modelBinding.mapFingerprint', SHA_PATTERN);
  if (binding.sceneSnapshotId !== null) stringAt(binding.sceneSnapshotId, '$.modelBinding.sceneSnapshotId', SHA_PATTERN);
  stringAt(binding.knowledgeFingerprint, '$.modelBinding.knowledgeFingerprint', SHA_PATTERN);
  if (scenario.exploreReadyEventInterleavings !== undefined && typeof scenario.exploreReadyEventInterleavings !== 'boolean') fail('$.exploreReadyEventInterleavings', '必须是布尔值');
  const players = arrayAt(scenario.players, '$.players', 64);
  if (players.length === 0) fail('$.players', '至少需要一个玩家');
  const playerIds = players.map((player, index) => stringAt(player, `$.players[${index}]`, ID_PATTERN));
  if (new Set(playerIds).size !== playerIds.length) fail('$.players', '玩家 ID 不能重复');
  if (scenario.initialConnectedPlayers !== undefined) {
    const connected = arrayAt(scenario.initialConnectedPlayers, '$.initialConnectedPlayers', 64)
      .map((player, index) => stringAt(player, `$.initialConnectedPlayers[${index}]`, ID_PATTERN));
    if (new Set(connected).size !== connected.length) fail('$.initialConnectedPlayers', '初始连接玩家 ID 不能重复');
    if (connected.some((playerId) => !playerIds.includes(playerId))) fail('$.initialConnectedPlayers', '初始连接玩家必须属于 participants 池');
  }
  const limits = recordAt(scenario.limits, '$.limits');
  exactKeys(limits, ['maxEvents', 'maxVirtualMilliseconds', 'maxVisitedStates', 'maxBranches'], [], '$.limits');
  integerAt(limits.maxEvents, '$.limits.maxEvents', 1, 100_000);
  integerAt(limits.maxVirtualMilliseconds, '$.limits.maxVirtualMilliseconds', 1, 86_400_000);
  integerAt(limits.maxVisitedStates, '$.limits.maxVisitedStates', 1, 100_000);
  integerAt(limits.maxBranches, '$.limits.maxBranches', 1, 100_000);
  arrayAt(scenario.steps, '$.steps').forEach((candidate, index) => {
    const path = `$.steps[${index}]`;
    const step = recordAt(candidate, path);
    const kind = enumAt(step.kind, ['dispatch', 'parallel', 'join', 'leave', 'advance', 'expect'] as const, `${path}.kind`);
    if (kind === 'dispatch') dispatchAt(step, path, true);
    else if (kind === 'parallel') {
      exactKeys(step, ['kind', 'actions'], ['exploreInterleavings'], path);
      const actions = arrayAt(step.actions, `${path}.actions`, 8);
      if (actions.length === 0) fail(`${path}.actions`, '至少需要一个动作');
      actions.forEach((action, actionIndex) => dispatchAt(action, `${path}.actions[${actionIndex}]`, false));
      if (step.exploreInterleavings !== undefined && typeof step.exploreInterleavings !== 'boolean') fail(`${path}.exploreInterleavings`, '必须是布尔值');
    } else if (kind === 'join' || kind === 'leave') {
      exactKeys(step, ['kind', 'playerId'], [], path);
      stringAt(step.playerId, `${path}.playerId`, ID_PATTERN);
    } else if (kind === 'advance') {
      exactKeys(step, ['kind', 'milliseconds'], [], path);
      integerAt(step.milliseconds, `${path}.milliseconds`, 0, 86_400_000);
    } else {
      exactKeys(step, ['kind', 'ref', 'operator', 'value'], [], path);
      refAt(step.ref, `${path}.ref`);
      enumAt(step.operator, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const, `${path}.operator`);
      valueAt(step.value, `${path}.value`, 0, { nodes: 0 });
    }
  });
  const declaredPlayers = new Set(playerIds);
  const ensurePlayer = (playerId: unknown, path: string): void => {
    if (playerId !== undefined && !declaredPlayers.has(playerId as string)) fail(path, '玩家不在场景 participants 列表中');
  };
  (scenario.steps as unknown[]).forEach((candidate, index) => {
    const step = recordAt(candidate, `$.steps[${index}]`);
    if (step.kind === 'dispatch') ensurePlayer(step.playerId, `$.steps[${index}].playerId`);
    else if (step.kind === 'parallel') (step.actions as unknown[]).forEach((action, actionIndex) => {
      ensurePlayer(recordAt(action, `$.steps[${index}].actions[${actionIndex}]`).playerId, `$.steps[${index}].actions[${actionIndex}].playerId`);
    });
    else if (step.kind === 'join' || step.kind === 'leave') ensurePlayer(step.playerId, `$.steps[${index}].playerId`);
    else if (step.kind === 'expect') ensurePlayer(recordAt(step.ref, `$.steps[${index}].ref`).playerId, `$.steps[${index}].ref.playerId`);
  });
}

export function parseGameplayModel(value: unknown): GameplayModel {
  documentSize(value);
  modelAt(value);
  return value as GameplayModel;
}

export function parseGameplayScenario(value: unknown): GameplayScenario {
  documentSize(value);
  scenarioAt(value);
  return value as GameplayScenario;
}

export function isGameplayModel(value: unknown): value is GameplayModel {
  try { parseGameplayModel(value); return true; } catch { return false; }
}

export function isGameplayScenario(value: unknown): value is GameplayScenario {
  try { parseGameplayScenario(value); return true; } catch { return false; }
}

// Compile-time anchors keep the closed parser synchronized with the public unions.
type _Effect = GameplayEffect;
type _Expression = GameplayExpression;
type _Ref = GameplayStateRef;
type _Value = GameplayValue;
void (0 as unknown as _Effect | _Expression | _Ref | _Value);
