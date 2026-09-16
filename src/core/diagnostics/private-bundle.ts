import { ProductError, type ErrorCode, type EvidenceLevel } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import type { LuaSourceIndex } from '../lua/source-index.js';
import {
  REGISTRY_KINDS,
  REGISTRY_VALIDITIES,
  type RegistryDocument,
  type RegistryKind,
  type RegistryValidity,
  type UiSnapshot,
} from '../model.js';
import type { FieldEvidenceState, SceneIssue, SceneSnapshot } from '../scene/types.js';

export const PRIVATE_DIAGNOSTIC_OPERATIONS = [
  'scene-refresh',
  'scene-diff',
  'scene-rebind',
  'lua-index',
  'gameplay-simulation',
  'ui-refresh',
  'registry-sync',
] as const;

export const PRIVATE_DIAGNOSTIC_NEXT_ACTIONS = [
  'REFRESH_SCENE',
  'REFRESH_UI',
  'REINDEX_LUA',
  'REVIEW_REBIND',
  'RUN_OFFICIAL_EDITOR_SINGLE',
  'RUN_OFFICIAL_EDITOR_MULTI',
  'REDUCE_SCOPE',
  'RETRY_OPERATION',
] as const;

export type PrivateDiagnosticOperation = (typeof PRIVATE_DIAGNOSTIC_OPERATIONS)[number];
export type PrivateDiagnosticNextAction = (typeof PRIVATE_DIAGNOSTIC_NEXT_ACTIONS)[number];
export type PrivateDiagnosticFormat = 'json' | 'md';

export interface PrivateDiagnosticErrorInput {
  code: ErrorCode;
  evidence: EvidenceLevel;
}

export interface PrivateDiagnosticPerformanceInput {
  operation: PrivateDiagnosticOperation;
  itemCount: number;
  durationMs: number;
  peakHeapBytes: number | null;
}

export interface CreateAnonymousDiagnosticBundleInput {
  pluginVersion: string;
  protocolVersion: string;
  sceneSnapshot?: SceneSnapshot;
  uiSnapshot?: UiSnapshot;
  registry?: RegistryDocument;
  luaIndex?: LuaSourceIndex;
  errors: readonly PrivateDiagnosticErrorInput[];
  performanceSamples: readonly PrivateDiagnosticPerformanceInput[];
  nextActions: readonly PrivateDiagnosticNextAction[];
}

export interface AnonymousDiagnosticBundle {
  schemaVersion: 1;
  pluginVersion: string;
  protocolVersion: string;
  hashes: Array<{ kind: 'scene-snapshot' | 'scene-source' | 'ui-snapshot' | 'registry-state'; prefix: string }>;
  errors: Array<{ code: ErrorCode; evidence: EvidenceLevel; count: number }>;
  structure: {
    scene: null | {
      instances: number;
      groups: number;
      distinctElementTypes: number;
      issueCounts: Array<{ code: SceneIssue['code']; count: number }>;
      featureStates: Array<{ state: 'observed' | 'candidate' | 'unsupported' | 'absent'; count: number }>;
      unknownFieldSummaries: number;
    };
    ui: null | { controls: number; roots: number; maxDepth: number; duplicateNameGroups: number };
    registry: null | {
      records: number;
      kindCounts: Array<{ kind: RegistryKind; count: number }>;
      validityCounts: Array<{ validity: RegistryValidity; count: number }>;
    };
    lua: null | {
      files: number;
      calls: number;
      idReferences: number;
      signalReferences: number;
      sideCounts: Array<{ side: 'client' | 'server' | 'shared' | 'unknown'; count: number }>;
      confidenceCounts: Array<{ confidence: 'confirmed' | 'inferred' | 'candidate'; count: number }>;
    };
  };
  evidence: Array<{ state: FieldEvidenceState | EvidenceLevel; count: number }>;
  performance: Array<{
    operation: PrivateDiagnosticOperation;
    itemCount: number;
    durationMs: number;
    peakHeapBytes: number | null;
  }>;
  nextActions: PrivateDiagnosticNextAction[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const HASH_PREFIX_LENGTH = 12;
const EVIDENCE_LEVELS = new Set<EvidenceLevel>([
  'STATIC_LOCAL', 'UNIT_E2E', 'EXTENSION_HOST', 'OFFICIAL_EDITOR_SINGLE',
  'OFFICIAL_EDITOR_MULTI', 'USER_ATTESTED',
]);
const ERROR_CODES = new Set<ErrorCode>([
  'OK', 'OFFLINE', 'STALE', 'AMBIGUOUS', 'NOT_FOUND', 'VALIDATION_FAILED', 'USAGE_ERROR', 'INTERNAL_ERROR',
  'ATOMIC_WRITE_FAILED', 'UNSAFE_LUA_NODE', 'LUA_LIMIT_EXCEEDED', 'DUPLICATE_LUA_KEY', 'NON_FINITE_NUMBER',
  'INVALID_LUA_SYNTAX', 'INVALID_UTF8', 'OFFICIAL_SCHEMA_UNVERIFIED', 'UNSUPPORTED_UI_SCHEMA', 'DUPLICATE_UI_ID',
  'OFFICIAL_COMMAND_MISSING', 'EXPORT_TIMEOUT', 'SOURCE_NOT_STABLE', 'API_NOT_FOUND', 'PLAYER_ROUTING_UNCONFIRMED',
  'GENERATED_FILE_PROTECTED', 'CONFIRMATION_REQUIRED', 'HASH_CONFLICT', 'UNSUPPORTED_SCENE_CONTAINER',
  'SCENE_INTEGRITY_FAILED', 'SCENE_WIRE_INVALID', 'UNSUPPORTED_SCENE_SCHEMA', 'SCENE_LIMIT_EXCEEDED',
  'SCENE_SOURCE_CONFLICT', 'SCENE_SOURCE_UNSTABLE', 'SCENE_EVIDENCE_INSUFFICIENT',
]);
const OPERATIONS = new Set<PrivateDiagnosticOperation>(PRIVATE_DIAGNOSTIC_OPERATIONS);
const NEXT_ACTIONS = new Set<PrivateDiagnosticNextAction>(PRIVATE_DIAGNOSTIC_NEXT_ACTIONS);
const REGISTRY_KIND_SET = new Set<RegistryKind>(REGISTRY_KINDS);
const REGISTRY_VALIDITY_SET = new Set<RegistryValidity>(REGISTRY_VALIDITIES);
const SCENE_ISSUE_CODES = new Set<SceneIssue['code']>([
  'UNSUPPORTED_INSTANCE_VARIANT', 'DUPLICATE_INSTANCE', 'DUPLICATE_GROUP', 'ORPHAN_OWNER',
  'RELATION_CYCLE', 'MISSING_GROUP_MEMBER',
]);
const FEATURE_STATES = new Set(['observed', 'candidate', 'unsupported', 'absent']);
const LUA_SIDES = new Set(['client', 'server', 'shared', 'unknown']);
const REFERENCE_CONFIDENCE = new Set(['confirmed', 'inferred', 'candidate']);
const FIELD_EVIDENCE_STATES = new Set<FieldEvidenceState>([
  'confirmed-calibration', 'observed-repeatable', 'inferred-candidate', 'unknown',
]);

function validation(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['修正匿名诊断输入后重试。'], 'STATIC_LOCAL');
}

function version(value: string, label: string): string {
  if (!VERSION_PATTERN.test(value)) validation(`${label} 只能使用受限版本字符且最长 64 字符。`);
  return value;
}

function nonNegativeInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) validation(`${label} 必须是安全范围内的非负整数。`);
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) validation(`${label} 必须是有限非负数。`);
  return value;
}

function hashPrefix(hash: string): string {
  if (!SHA256_PATTERN.test(hash)) validation('诊断哈希必须是 SHA-256。');
  return hash.slice(0, HASH_PREFIX_LENGTH);
}

function counted<T extends string>(values: readonly T[]): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value, 'en'));
}

function sceneStructure(snapshot: SceneSnapshot): NonNullable<AnonymousDiagnosticBundle['structure']['scene']> {
  nonNegativeInteger(snapshot.instances.length, 'scene.instances', 200_000);
  nonNegativeInteger(snapshot.groups.length, 'scene.groups', 100_000);
  const issueCounts = counted(snapshot.issues.map((issue) => issue.code)).map(({ value: code, count }) => ({ code, count }));
  const featureStates = counted(snapshot.instances.flatMap((instance) => [
    instance.transform.state,
    instance.customProperties.state,
    instance.signals.state,
    instance.resources.state,
    instance.bounds.state,
  ])).map(({ value: state, count }) => ({ state, count }));
  return {
    instances: snapshot.instances.length,
    groups: snapshot.groups.length,
    distinctElementTypes: new Set(snapshot.instances.map((item) => item.elementTypeId).filter((value) => value !== null)).size,
    issueCounts,
    featureStates,
    unknownFieldSummaries: snapshot.unknownFields.length
      + snapshot.instances.reduce((total, item) => total + item.unknownFields.length, 0),
  };
}

function uiStructure(snapshot: UiSnapshot): NonNullable<AnonymousDiagnosticBundle['structure']['ui']> {
  nonNegativeInteger(snapshot.nodes.length, 'ui.controls', 500_000);
  return {
    controls: snapshot.nodes.length,
    roots: snapshot.nodes.filter((node) => node.parentId === null).length,
    maxDepth: snapshot.nodes.reduce((maximum, node) => Math.max(maximum, node.depth), 0),
    duplicateNameGroups: snapshot.duplicateNames.length,
  };
}

function registryStructure(document: RegistryDocument): NonNullable<AnonymousDiagnosticBundle['structure']['registry']> {
  nonNegativeInteger(document.records.length, 'registry.records', 200_000);
  return {
    records: document.records.length,
    kindCounts: counted(document.records.map((record) => record.kind)).map(({ value: kind, count }) => ({ kind, count })),
    validityCounts: counted(document.records.map((record) => record.validity)).map(({ value: validity, count }) => ({ validity, count })),
  };
}

function luaStructure(index: LuaSourceIndex): NonNullable<AnonymousDiagnosticBundle['structure']['lua']> {
  const total = index.files.length + index.calls.length + index.idReferences.length + index.signalReferences.length;
  nonNegativeInteger(total, 'lua.indexEntries', 1_000_000);
  const sides = index.files.map((file) => file.side.value);
  const confidence = [...index.idReferences, ...index.signalReferences].map((reference) => reference.confidence);
  return {
    files: index.files.length,
    calls: index.calls.length,
    idReferences: index.idReferences.length,
    signalReferences: index.signalReferences.length,
    sideCounts: counted(sides).map(({ value: side, count }) => ({ side, count })),
    confidenceCounts: counted(confidence).map(({ value, count }) => ({ confidence: value, count })),
  };
}

function evidenceCounts(input: CreateAnonymousDiagnosticBundleInput): AnonymousDiagnosticBundle['evidence'] {
  const states: Array<FieldEvidenceState | EvidenceLevel> = input.errors.map((error) => error.evidence);
  if (input.sceneSnapshot !== undefined) {
    for (const instance of input.sceneSnapshot.instances) {
      states.push(instance.evidence.state);
      for (const feature of [instance.transform, instance.customProperties, instance.signals, instance.resources, instance.bounds]) {
        if (feature.state === 'observed' || feature.state === 'candidate') states.push(feature.evidence.state);
      }
    }
    for (const group of input.sceneSnapshot.groups) states.push(group.evidence.state);
  }
  return counted(states).map(({ value: state, count }) => ({ state, count }));
}

export function createAnonymousDiagnosticBundle(input: CreateAnonymousDiagnosticBundleInput): AnonymousDiagnosticBundle {
  version(input.pluginVersion, 'pluginVersion');
  version(input.protocolVersion, 'protocolVersion');
  nonNegativeInteger(input.errors.length, 'errors', 10_000);
  nonNegativeInteger(input.performanceSamples.length, 'performanceSamples', 1_000);
  nonNegativeInteger(input.nextActions.length, 'nextActions', 100);
  for (const item of input.errors) {
    if (!ERROR_CODES.has(item.code) || !EVIDENCE_LEVELS.has(item.evidence)) validation('诊断错误码或证据等级不在闭合协议中。');
  }
  const errors = counted(input.errors.map((item) => `${item.code}\0${item.evidence}`)).map(({ value, count }) => {
    const [code, evidence] = value.split('\0') as [ErrorCode, EvidenceLevel];
    return { code, evidence, count };
  });
  const performance = input.performanceSamples.map((sample) => {
    if (!OPERATIONS.has(sample.operation)) validation('性能操作不在闭合协议中。');
    nonNegativeInteger(sample.itemCount, 'performance.itemCount', 10_000_000);
    finiteNonNegative(sample.durationMs, 'performance.durationMs');
    if (sample.peakHeapBytes !== null) nonNegativeInteger(sample.peakHeapBytes, 'performance.peakHeapBytes');
    return {
      operation: sample.operation,
      itemCount: sample.itemCount,
      durationMs: Math.round(sample.durationMs * 1_000) / 1_000,
      peakHeapBytes: sample.peakHeapBytes,
    };
  }).sort((left, right) => left.operation.localeCompare(right.operation, 'en')
    || left.itemCount - right.itemCount || left.durationMs - right.durationMs
    || (left.peakHeapBytes ?? -1) - (right.peakHeapBytes ?? -1));
  const nextActions = [...new Set(input.nextActions)].sort((left, right) => left.localeCompare(right, 'en'));
  if (!nextActions.every((action) => NEXT_ACTIONS.has(action))) validation('nextAction 不在闭合协议中。');
  const hashes: AnonymousDiagnosticBundle['hashes'] = [];
  if (input.sceneSnapshot !== undefined) {
    hashes.push({ kind: 'scene-snapshot', prefix: hashPrefix(input.sceneSnapshot.snapshotId) });
    hashes.push({ kind: 'scene-source', prefix: hashPrefix(input.sceneSnapshot.sourceSha256) });
  }
  if (input.uiSnapshot !== undefined) hashes.push({ kind: 'ui-snapshot', prefix: hashPrefix(input.uiSnapshot.snapshotId) });
  if (input.registry !== undefined) hashes.push({ kind: 'registry-state', prefix: hashPrefix(sha256Hex(stableJson(input.registry))) });
  hashes.sort((left, right) => left.kind.localeCompare(right.kind, 'en'));
  return {
    schemaVersion: 1,
    pluginVersion: input.pluginVersion,
    protocolVersion: input.protocolVersion,
    hashes,
    errors,
    structure: {
      scene: input.sceneSnapshot === undefined ? null : sceneStructure(input.sceneSnapshot),
      ui: input.uiSnapshot === undefined ? null : uiStructure(input.uiSnapshot),
      registry: input.registry === undefined ? null : registryStructure(input.registry),
      lua: input.luaIndex === undefined ? null : luaStructure(input.luaIndex),
    },
    evidence: evidenceCounts(input),
    performance,
    nextActions,
  };
}

function markdownCounts<T extends { count: number }>(values: readonly T[], label: (value: T) => string): string {
  return values.length === 0 ? '- none' : values.map((value) => `- ${label(value)}: ${value.count}`).join('\n');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) validation(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    validation(`${label} 字段缺失或包含未知字段。`);
  }
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number') validation(`${label} 必须是数字。`);
  return nonNegativeInteger(value, label);
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) validation(`${label} 必须是数组。`);
  nonNegativeInteger(value.length, `${label}.length`, maximum);
  return value;
}

function validateCountItems(
  value: unknown,
  label: string,
  key: string,
  allowed: ReadonlySet<string>,
  maximum: number,
): void {
  for (const [index, candidate] of array(value, label, maximum).entries()) {
    const item = object(candidate, `${label}[${index}]`);
    exact(item, [key, 'count'], `${label}[${index}]`);
    if (typeof item[key] !== 'string' || !allowed.has(item[key])) validation(`${label}[${index}].${key} 不在闭合协议中。`);
    count(item.count, `${label}[${index}].count`);
  }
}

export function validateAnonymousDiagnosticBundle(value: unknown): asserts value is AnonymousDiagnosticBundle {
  const bundle = object(value, 'bundle');
  exact(bundle, [
    'schemaVersion', 'pluginVersion', 'protocolVersion', 'hashes', 'errors', 'structure',
    'evidence', 'performance', 'nextActions',
  ], 'bundle');
  if (bundle.schemaVersion !== 1 || typeof bundle.pluginVersion !== 'string' || typeof bundle.protocolVersion !== 'string') {
    validation('匿名诊断包版本字段无效。');
  }
  version(bundle.pluginVersion, 'pluginVersion');
  version(bundle.protocolVersion, 'protocolVersion');
  const hashKinds = new Set(['scene-snapshot', 'scene-source', 'ui-snapshot', 'registry-state']);
  for (const [index, candidate] of array(bundle.hashes, 'hashes', 4).entries()) {
    const item = object(candidate, `hashes[${index}]`);
    exact(item, ['kind', 'prefix'], `hashes[${index}]`);
    if (typeof item.kind !== 'string' || !hashKinds.has(item.kind) || typeof item.prefix !== 'string' || !/^[a-f0-9]{12}$/u.test(item.prefix)) {
      validation(`hashes[${index}] 无效。`);
    }
  }
  for (const [index, candidate] of array(bundle.errors, 'errors', 10_000).entries()) {
    const item = object(candidate, `errors[${index}]`);
    exact(item, ['code', 'evidence', 'count'], `errors[${index}]`);
    if (typeof item.code !== 'string' || !ERROR_CODES.has(item.code as ErrorCode)
      || typeof item.evidence !== 'string' || !EVIDENCE_LEVELS.has(item.evidence as EvidenceLevel)) {
      validation(`errors[${index}] 不在闭合协议中。`);
    }
    count(item.count, `errors[${index}].count`);
  }
  const structure = object(bundle.structure, 'structure');
  exact(structure, ['scene', 'ui', 'registry', 'lua'], 'structure');
  if (structure.scene !== null) {
    const scene = object(structure.scene, 'structure.scene');
    exact(scene, ['instances', 'groups', 'distinctElementTypes', 'issueCounts', 'featureStates', 'unknownFieldSummaries'], 'structure.scene');
    for (const key of ['instances', 'groups', 'distinctElementTypes', 'unknownFieldSummaries'] as const) count(scene[key], `structure.scene.${key}`);
    validateCountItems(scene.issueCounts, 'structure.scene.issueCounts', 'code', SCENE_ISSUE_CODES, 6);
    validateCountItems(scene.featureStates, 'structure.scene.featureStates', 'state', FEATURE_STATES, 4);
  }
  if (structure.ui !== null) {
    const ui = object(structure.ui, 'structure.ui');
    exact(ui, ['controls', 'roots', 'maxDepth', 'duplicateNameGroups'], 'structure.ui');
    for (const key of ['controls', 'roots', 'maxDepth', 'duplicateNameGroups'] as const) count(ui[key], `structure.ui.${key}`);
  }
  if (structure.registry !== null) {
    const registry = object(structure.registry, 'structure.registry');
    exact(registry, ['records', 'kindCounts', 'validityCounts'], 'structure.registry');
    count(registry.records, 'structure.registry.records');
    validateCountItems(registry.kindCounts, 'structure.registry.kindCounts', 'kind', REGISTRY_KIND_SET, REGISTRY_KINDS.length);
    validateCountItems(registry.validityCounts, 'structure.registry.validityCounts', 'validity', REGISTRY_VALIDITY_SET, REGISTRY_VALIDITIES.length);
  }
  if (structure.lua !== null) {
    const lua = object(structure.lua, 'structure.lua');
    exact(lua, ['files', 'calls', 'idReferences', 'signalReferences', 'sideCounts', 'confidenceCounts'], 'structure.lua');
    for (const key of ['files', 'calls', 'idReferences', 'signalReferences'] as const) count(lua[key], `structure.lua.${key}`);
    validateCountItems(lua.sideCounts, 'structure.lua.sideCounts', 'side', LUA_SIDES, 4);
    validateCountItems(lua.confidenceCounts, 'structure.lua.confidenceCounts', 'confidence', REFERENCE_CONFIDENCE, 3);
  }
  const allEvidence = new Set<string>([...FIELD_EVIDENCE_STATES, ...EVIDENCE_LEVELS]);
  validateCountItems(bundle.evidence, 'evidence', 'state', allEvidence, allEvidence.size);
  for (const [index, candidate] of array(bundle.performance, 'performance', 1_000).entries()) {
    const item = object(candidate, `performance[${index}]`);
    exact(item, ['operation', 'itemCount', 'durationMs', 'peakHeapBytes'], `performance[${index}]`);
    if (typeof item.operation !== 'string' || !OPERATIONS.has(item.operation as PrivateDiagnosticOperation)) validation(`performance[${index}].operation 无效。`);
    count(item.itemCount, `performance[${index}].itemCount`);
    if (typeof item.durationMs !== 'number') validation(`performance[${index}].durationMs 无效。`);
    finiteNonNegative(item.durationMs, `performance[${index}].durationMs`);
    if (item.peakHeapBytes !== null) count(item.peakHeapBytes, `performance[${index}].peakHeapBytes`);
  }
  for (const [index, item] of array(bundle.nextActions, 'nextActions', 100).entries()) {
    if (typeof item !== 'string' || !NEXT_ACTIONS.has(item as PrivateDiagnosticNextAction)) validation(`nextActions[${index}] 无效。`);
  }
}

export function renderAnonymousDiagnosticBundle(bundle: AnonymousDiagnosticBundle, format: PrivateDiagnosticFormat): string {
  validateAnonymousDiagnosticBundle(bundle);
  if (format === 'json') return stableJson(bundle);
  const scene = bundle.structure.scene;
  const ui = bundle.structure.ui;
  const registry = bundle.structure.registry;
  const lua = bundle.structure.lua;
  return `# Anonymous diagnostic bundle

- Schema: ${bundle.schemaVersion}
- Plugin: ${bundle.pluginVersion}
- Protocol: ${bundle.protocolVersion}

## Hash prefixes

${bundle.hashes.length === 0 ? '- none' : bundle.hashes.map((item) => `- ${item.kind}: ${item.prefix}`).join('\n')}

## Stable errors

${markdownCounts(bundle.errors, (item) => `${item.code} / ${item.evidence}`)}

## Anonymous structure

- Scene instances/groups/types: ${scene === null ? 'n/a' : `${scene.instances}/${scene.groups}/${scene.distinctElementTypes}`}
- UI controls/roots/max-depth: ${ui === null ? 'n/a' : `${ui.controls}/${ui.roots}/${ui.maxDepth}`}
- Registry records: ${registry === null ? 'n/a' : registry.records}
- Lua files/calls/ID refs/signal refs: ${lua === null ? 'n/a' : `${lua.files}/${lua.calls}/${lua.idReferences}/${lua.signalReferences}`}

## Evidence

${markdownCounts(bundle.evidence, (item) => item.state)}

## Performance

${bundle.performance.length === 0 ? '- none' : bundle.performance.map((item) => (
    `- ${item.operation}: items=${item.itemCount}, durationMs=${item.durationMs}, peakHeapBytes=${item.peakHeapBytes ?? 'n/a'}`
  )).join('\n')}

## Next actions

${bundle.nextActions.length === 0 ? '- none' : bundle.nextActions.map((item) => `- ${item}`).join('\n')}
`;
}
