import { ProductError, type ErrorCode, type EvidenceLevel } from '../errors.js';
import type { SceneDiff, SceneDiffOptions } from './diff.js';
import type { SceneIndex } from './index.js';
import type { SceneSnapshot } from './types.js';
import type { SceneSourceRole } from './container.js';

export const SCENE_WORKER_PROTOCOL_VERSION = 1 as const;
export const SCENE_WORKER_MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const SCENE_WORKER_MAX_INSTANCES = 200_000;
export const SCENE_WORKER_MAX_GROUPS = 100_000;

export type SceneWorkerPhase = 'container' | 'wire' | 'normalize' | 'index' | 'diff' | 'complete';

export interface SceneWorkerProcessInput {
  bytes: Uint8Array;
  bindingId: string;
  role: SceneSourceRole;
  sourceSha256: string;
  observedAt: string;
}

export type SceneWorkerRequest =
  | {
    protocolVersion: 1;
    kind: 'process';
    requestId: string;
    input: SceneWorkerProcessInput;
  }
  | {
    protocolVersion: 1;
    kind: 'index';
    requestId: string;
    snapshot: SceneSnapshot;
  }
  | {
    protocolVersion: 1;
    kind: 'diff';
    requestId: string;
    before: SceneSnapshot;
    after: SceneSnapshot;
    options: SceneDiffOptions;
  };

export interface SceneWorkerProcessResult {
  snapshot: SceneSnapshot;
  index: SceneIndex;
  metrics: {
    elapsedMilliseconds: number;
    peakHeapUsedBytes: number;
  };
}

export type SceneWorkerResult = SceneWorkerProcessResult | SceneIndex | SceneDiff;

export type SceneWorkerResponse =
  | { protocolVersion: 1; kind: 'progress'; requestId: string; phase: SceneWorkerPhase }
  | { protocolVersion: 1; kind: 'result'; requestId: string; operation: SceneWorkerRequest['kind']; value: SceneWorkerResult }
  | {
    protocolVersion: 1;
    kind: 'error';
    requestId: string;
    code: ErrorCode;
    message: string;
    nextActions: string[];
    evidence: EvidenceLevel;
  };

const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ROLES = new Set<SceneSourceRole>(['manual-dat', 'auto-dat', 'raw-pbin']);
const PHASES = new Set<SceneWorkerPhase>(['container', 'wire', 'normalize', 'index', 'diff', 'complete']);
const EVIDENCE = new Set<EvidenceLevel>([
  'STATIC_LOCAL', 'UNIT_E2E', 'EXTENSION_HOST', 'OFFICIAL_EDITOR_SINGLE',
  'OFFICIAL_EDITOR_MULTI', 'USER_ATTESTED',
]);
const ERROR_CODES = new Set<ErrorCode>([
  'OK', 'OFFLINE', 'STALE', 'AMBIGUOUS', 'NOT_FOUND', 'VALIDATION_FAILED', 'USAGE_ERROR',
  'INTERNAL_ERROR', 'ATOMIC_WRITE_FAILED', 'UNSAFE_LUA_NODE', 'LUA_LIMIT_EXCEEDED',
  'DUPLICATE_LUA_KEY', 'NON_FINITE_NUMBER', 'INVALID_LUA_SYNTAX', 'INVALID_UTF8',
  'OFFICIAL_SCHEMA_UNVERIFIED', 'UNSUPPORTED_UI_SCHEMA', 'DUPLICATE_UI_ID',
  'OFFICIAL_COMMAND_MISSING', 'EXPORT_TIMEOUT', 'SOURCE_NOT_STABLE', 'API_NOT_FOUND',
  'PLAYER_ROUTING_UNCONFIRMED', 'GENERATED_FILE_PROTECTED', 'CONFIRMATION_REQUIRED',
  'HASH_CONFLICT', 'UNSUPPORTED_SCENE_CONTAINER', 'SCENE_INTEGRITY_FAILED',
  'SCENE_WIRE_INVALID', 'UNSUPPORTED_SCENE_SCHEMA', 'SCENE_LIMIT_EXCEEDED',
  'SCENE_SOURCE_CONFLICT', 'SCENE_SOURCE_UNSTABLE', 'SCENE_EVIDENCE_INSUFFICIENT',
]);

function failure(message = '场景后台任务协议无效。'): ProductError {
  return new ProductError('VALIDATION_FAILED', message, ['重新刷新场景源。'], 'STATIC_LOCAL');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw failure();
}

function exactKeysEither(value: Record<string, unknown>, alternatives: readonly (readonly string[])[]): void {
  const actual = Object.keys(value).sort();
  if (!alternatives.some((expected) => {
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  })) throw failure();
}

function string(value: unknown, maximum = 1024): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw failure();
}

function dateTime(value: unknown): asserts value is string {
  string(value, 128);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw failure('场景观测时间必须是 UTC ISO 8601 日期。');
}

function requestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw failure();
}

function sha256(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw failure();
}

function nullableString(value: unknown, maximum = 128): void {
  if (value !== null) string(value, maximum);
}

function finiteNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw failure();
}

function safeInteger(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw failure();
}

function stringArray(value: unknown, maximum: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum) throw failure();
  for (const item of value) string(item, 1024);
}

function evidence(value: unknown): void {
  const candidate = object(value);
  exactKeys(candidate, ['state', 'source', 'confidence']);
  if (!['confirmed-calibration', 'observed-repeatable', 'inferred-candidate', 'unknown'].includes(candidate.state as string)) throw failure();
  string(candidate.source, 256);
  finiteNumber(candidate.confidence);
  if (candidate.confidence < 0 || candidate.confidence > 1) throw failure();
}

function vector(value: unknown): void {
  const candidate = object(value);
  exactKeys(candidate, ['x', 'y', 'z']);
  finiteNumber(candidate.x);
  finiteNumber(candidate.y);
  finiteNumber(candidate.z);
}

function transform(value: unknown): void {
  const candidate = object(value);
  exactKeys(candidate, ['position', 'rotation', 'scale']);
  vector(candidate.position);
  vector(candidate.rotation);
  vector(candidate.scale);
}

function jsonValue(value: unknown, depth = 0): void {
  if (depth > 32) throw failure();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    finiteNumber(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw failure();
    for (const item of value) jsonValue(item, depth + 1);
    return;
  }
  const candidate = object(value);
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  const keys = Object.keys(candidate);
  if (keys.length > 10_000) throw failure();
  for (const key of keys) {
    string(key, 256);
    jsonValue(candidate[key], depth + 1);
  }
}

function feature(value: unknown, observed: (item: unknown) => void): void {
  const candidate = object(value);
  if (candidate.state === 'observed') {
    exactKeys(candidate, ['state', 'value', 'evidence']);
    observed(candidate.value);
    evidence(candidate.evidence);
    return;
  }
  if (candidate.state === 'candidate') {
    exactKeys(candidate, ['state', 'wirePaths', 'evidence']);
    stringArray(candidate.wirePaths, 10_000);
    evidence(candidate.evidence);
    return;
  }
  if (candidate.state === 'unsupported') {
    exactKeys(candidate, ['state', 'reason']);
    string(candidate.reason, 1024);
    return;
  }
  if (candidate.state === 'absent') {
    exactKeys(candidate, ['state']);
    return;
  }
  throw failure();
}

function unknownField(value: unknown): void {
  const candidate = object(value);
  exactKeys(candidate, ['path', 'wireType', 'length', 'sha256']);
  string(candidate.path, 1024);
  safeInteger(candidate.wireType);
  if (![0, 1, 2, 5].includes(candidate.wireType)) throw failure();
  safeInteger(candidate.length);
  sha256(candidate.sha256);
}

function unknownFields(value: unknown): void {
  if (!Array.isArray(value) || value.length > SCENE_WORKER_MAX_INSTANCES) throw failure();
  for (const item of value) unknownField(item);
}

function instance(value: unknown): void {
  const candidate = object(value);
  exactKeys(candidate, [
    'instanceId', 'elementTypeId', 'ownerId', 'variant', 'evidence', 'transform',
    'customProperties', 'signals', 'resources', 'bounds', 'unknownFields',
  ]);
  string(candidate.instanceId, 128);
  nullableString(candidate.elementTypeId);
  nullableString(candidate.ownerId);
  if (!['standard', 'unsupported-oneof-1', 'component6-oneof-11', 'component6-oneof-1', 'unknown'].includes(candidate.variant as string)) throw failure();
  evidence(candidate.evidence);
  feature(candidate.transform, transform);
  feature(candidate.customProperties, (items) => {
    if (!Array.isArray(items) || items.length > 10_000) throw failure();
    for (const item of items) {
      const entry = object(item);
      exactKeys(entry, ['key', 'value']);
      string(entry.key, 256);
      jsonValue(entry.value);
    }
  });
  feature(candidate.signals, (items) => {
    if (!Array.isArray(items) || items.length > 10_000) throw failure();
    for (const item of items) {
      const entry = object(item);
      exactKeys(entry, ['name']);
      string(entry.name, 256);
    }
  });
  feature(candidate.resources, (items) => {
    if (!Array.isArray(items) || items.length > 10_000) throw failure();
    for (const item of items) {
      const entry = object(item);
      exactKeys(entry, ['resourceId']);
      string(entry.resourceId, 128);
    }
  });
  feature(candidate.bounds, (item) => {
    const bounds = object(item);
    exactKeys(bounds, ['min', 'max', 'evidence']);
    vector(bounds.min);
    vector(bounds.max);
    evidence(bounds.evidence);
  });
  unknownFields(candidate.unknownFields);
}

function group(value: unknown): void {
  const candidate = object(value);
  exactKeysEither(candidate, [
    ['groupId', 'memberIds', 'nestedGroupIds', 'evidence'],
    ['groupId', 'memberIds', 'nestedGroupIds', 'evidence', 'parentGroupId', 'transform', 'metadata'],
    ['groupId', 'memberIds', 'nestedGroupIds', 'evidence', 'parentGroupId', 'transform', 'metadata', 'unknownFields'],
  ]);
  string(candidate.groupId, 128);
  stringArray(candidate.memberIds, SCENE_WORKER_MAX_INSTANCES);
  stringArray(candidate.nestedGroupIds, SCENE_WORKER_MAX_GROUPS);
  evidence(candidate.evidence);
  if ('parentGroupId' in candidate) {
    nullableString(candidate.parentGroupId);
    feature(candidate.transform, transform);
    feature(candidate.metadata, (item) => {
      const metadata = object(item);
      exactKeysEither(metadata, [['opaqueRef', 'rawKind', 'labelCandidate'], ['opaqueRef', 'rawKind', 'labelCandidate', 'unknownFields']]);
      nullableString(metadata.opaqueRef);
      nullableString(metadata.rawKind);
      nullableString(metadata.labelCandidate, 512);
      if ('unknownFields' in metadata) unknownFields(metadata.unknownFields);
    });
    if ('unknownFields' in candidate) unknownFields(candidate.unknownFields);
  }
}

const ISSUE_CODES = new Set([
  'UNSUPPORTED_INSTANCE_VARIANT', 'DUPLICATE_INSTANCE', 'DUPLICATE_GROUP', 'ORPHAN_OWNER',
  'RELATION_CYCLE', 'MISSING_GROUP_MEMBER', 'GROUP_RELATION_CONFLICT',
  'INSTANCE_INDEX_DUPLICATE', 'INSTANCE_INDEX_MISSING', 'INSTANCE_INDEX_EXTRA',
]);

function issue(value: unknown): void {
  const candidate = object(value);
  exactKeys(candidate, ['code', 'message', 'instanceId']);
  if (!ISSUE_CODES.has(candidate.code as string)) throw failure();
  string(candidate.message, 1024);
  nullableString(candidate.instanceId);
}

function snapshot(value: unknown): asserts value is SceneSnapshot {
  const candidate = object(value);
  const baseKeys = [
    'schemaVersion', 'snapshotId', 'bindingId', 'role', 'sourceSha256', 'observedAt',
    'adapterId', 'instances', 'groups', 'issues', 'unknownFields',
  ] as const;
  exactKeysEither(candidate, [baseKeys, [...baseKeys, 'signalRegistry'], [...baseKeys, 'signalRegistry', 'sceneMetadata']]);
  if (candidate.schemaVersion !== 1 || !ROLES.has(candidate.role as SceneSourceRole)) throw failure();
  sha256(candidate.snapshotId);
  // 早期私有缓存中的 bindingId 不是内容哈希。这里验证它是有界非空标识符，
  // 而不是把旧缓存误判为损坏；新建绑定仍由 source 层生成 SHA-256。
  string(candidate.bindingId, 128);
  sha256(candidate.sourceSha256);
  dateTime(candidate.observedAt);
  string(candidate.adapterId, 128);
  if (!Array.isArray(candidate.instances) || candidate.instances.length > SCENE_WORKER_MAX_INSTANCES) throw failure('场景实例数量超过后台任务上限。');
  if (!Array.isArray(candidate.groups) || candidate.groups.length > SCENE_WORKER_MAX_GROUPS) throw failure('场景编组数量超过后台任务上限。');
  if (!Array.isArray(candidate.issues) || candidate.issues.length > SCENE_WORKER_MAX_INSTANCES) throw failure();
  for (const item of candidate.instances) instance(item);
  for (const item of candidate.groups) group(item);
  for (const item of candidate.issues) issue(item);
  unknownFields(candidate.unknownFields);
  if ('signalRegistry' in candidate) {
    feature(candidate.signalRegistry, (items) => {
      if (!Array.isArray(items) || items.length > 10_000) throw failure();
      for (const item of items) {
        const signal = object(item);
        exactKeysEither(signal, [['name', 'unknownRefCount'], ['name', 'unknownRefCount', 'ambiguous'], ['name', 'unknownRefCount', 'unknownFields'], ['name', 'unknownRefCount', 'ambiguous', 'unknownFields']]);
        string(signal.name, 512);
        safeInteger(signal.unknownRefCount);
        if ('ambiguous' in signal && typeof signal.ambiguous !== 'boolean') throw failure();
        if ('unknownFields' in signal) unknownFields(signal.unknownFields);
      }
    });
  }
  if ('sceneMetadata' in candidate) {
    const metadata = object(candidate.sceneMetadata);
    exactKeys(metadata, ['layerName', 'editorVersionCandidate', 'instanceIndex']);
    feature(metadata.layerName, (item) => string(item, 512));
    feature(metadata.editorVersionCandidate, (item) => string(item, 128));
    feature(metadata.instanceIndex, (item) => {
      const index = object(item);
      exactKeysEither(index, [['entryCount', 'duplicateIds', 'missingInstanceIds', 'extraInstanceIds', 'rawStatusValues'], ['entryCount', 'duplicateIds', 'missingInstanceIds', 'extraInstanceIds', 'rawStatusValues', 'unknownFields']]);
      safeInteger(index.entryCount);
      stringArray(index.duplicateIds, SCENE_WORKER_MAX_INSTANCES);
      stringArray(index.missingInstanceIds, SCENE_WORKER_MAX_INSTANCES);
      stringArray(index.extraInstanceIds, SCENE_WORKER_MAX_INSTANCES);
      stringArray(index.rawStatusValues, 1024);
      if ('unknownFields' in index) unknownFields(index.unknownFields);
    });
  }
}

/**
 * 深层校验从磁盘读取的场景快照。
 *
 * 与 worker 的消息边界共用同一份闭合校验，避免缓存读取只验证根对象，
 * 却让缺字段的实例、编组或 v6 元数据进入 AI 查询链路。
 */
export function assertSceneSnapshotDocument(value: unknown): asserts value is SceneSnapshot {
  snapshot(value);
}

function processInput(value: unknown): asserts value is SceneWorkerProcessInput {
  const candidate = object(value);
  exactKeys(candidate, ['bytes', 'bindingId', 'role', 'sourceSha256', 'observedAt']);
  if (!(candidate.bytes instanceof Uint8Array) || candidate.bytes.byteLength < 1) throw failure();
  if (candidate.bytes.byteLength > SCENE_WORKER_MAX_INPUT_BYTES) throw failure('场景源超过后台任务输入上限。');
  sha256(candidate.bindingId);
  sha256(candidate.sourceSha256);
  if (!ROLES.has(candidate.role as SceneSourceRole)) throw failure();
  dateTime(candidate.observedAt);
}

function sceneIndex(value: unknown): asserts value is SceneIndex {
  const candidate = object(value);
  exactKeysEither(candidate, [
    ['snapshot', 'byInstanceId', 'byElementTypeId', 'byOwnerId'],
    ['snapshot', 'byInstanceId', 'byElementTypeId', 'byOwnerId', 'bySignalName'],
    ['snapshot', 'byInstanceId', 'byElementTypeId', 'byOwnerId', 'bySignalRegistryName'],
    ['snapshot', 'byInstanceId', 'byElementTypeId', 'byOwnerId', 'bySignalName', 'bySignalRegistryName'],
  ]);
  snapshot(candidate.snapshot);
  for (const map of [candidate.byInstanceId, candidate.byElementTypeId, candidate.byOwnerId, ...('bySignalName' in candidate ? [candidate.bySignalName] : [])]) {
    if (!(map instanceof Map) || map.size > SCENE_WORKER_MAX_INSTANCES) throw failure();
    let total = 0;
    for (const [key, values] of map) {
      string(key, 128);
      if (!Array.isArray(values)) throw failure();
      total += values.length;
      if (total > SCENE_WORKER_MAX_INSTANCES) throw failure();
      for (const item of values) instance(item);
    }
  }
  if ('bySignalRegistryName' in candidate) {
    const map = candidate.bySignalRegistryName;
    if (!(map instanceof Map) || map.size > 10_000) throw failure();
    let total = 0;
    for (const [key, values] of map) {
      string(key, 512);
      if (!Array.isArray(values)) throw failure();
      total += values.length;
      if (total > 10_000) throw failure();
      for (const item of values) {
        const signal = object(item);
        exactKeysEither(signal, [['name', 'unknownRefCount'], ['name', 'unknownRefCount', 'ambiguous'], ['name', 'unknownRefCount', 'unknownFields'], ['name', 'unknownRefCount', 'ambiguous', 'unknownFields']]);
        string(signal.name, 512);
        safeInteger(signal.unknownRefCount);
        if ('ambiguous' in signal && typeof signal.ambiguous !== 'boolean') throw failure();
        if ('unknownFields' in signal) unknownFields(signal.unknownFields);
      }
    }
  }
}

function processResult(value: unknown): asserts value is SceneWorkerProcessResult {
  const candidate = object(value);
  exactKeys(candidate, ['snapshot', 'index', 'metrics']);
  snapshot(candidate.snapshot);
  sceneIndex(candidate.index);
  const metrics = object(candidate.metrics);
  exactKeys(metrics, ['elapsedMilliseconds', 'peakHeapUsedBytes']);
  if (
    typeof metrics.elapsedMilliseconds !== 'number'
    || !Number.isFinite(metrics.elapsedMilliseconds)
    || metrics.elapsedMilliseconds < 0
    || typeof metrics.peakHeapUsedBytes !== 'number'
    || !Number.isSafeInteger(metrics.peakHeapUsedBytes)
    || metrics.peakHeapUsedBytes < 0
  ) throw failure();
}

function sceneDiff(value: unknown): asserts value is SceneDiff {
  const candidate = object(value);
  exactKeys(candidate, ['fromSnapshotId', 'toSnapshotId', 'changes']);
  sha256(candidate.fromSnapshotId);
  sha256(candidate.toSnapshotId);
  if (!Array.isArray(candidate.changes) || candidate.changes.length > SCENE_WORKER_MAX_INSTANCES * 16) throw failure();
  for (const change of candidate.changes) sceneChange(change);
}

function featureSummary(value: unknown): void {
  const candidate = object(value);
  if (candidate.state === 'observed') {
    const expected = candidate.count === undefined ? ['state', 'valueSha256'] : ['state', 'valueSha256', 'count'];
    exactKeys(candidate, expected);
    sha256(candidate.valueSha256);
    if (candidate.count !== undefined) safeInteger(candidate.count);
    return;
  }
  if (candidate.state === 'candidate') {
    exactKeys(candidate, ['state', 'wirePaths']);
    stringArray(candidate.wirePaths, 10_000);
    return;
  }
  if (candidate.state === 'unsupported') {
    exactKeys(candidate, ['state', 'reason']);
    string(candidate.reason, 1024);
    return;
  }
  if (candidate.state === 'absent') {
    exactKeys(candidate, ['state']);
    return;
  }
  throw failure();
}

function vectorComponents(value: unknown): void {
  const candidate = object(value);
  if (Object.keys(candidate).some((key) => !['x', 'y', 'z'].includes(key))) throw failure();
  for (const delta of Object.values(candidate)) {
    const entry = object(delta);
    exactKeys(entry, ['before', 'after', 'delta']);
    finiteNumber(entry.before);
    finiteNumber(entry.after);
    finiteNumber(entry.delta);
  }
}

function sceneChange(value: unknown): void {
  const candidate = object(value);
  const kind = candidate.kind;
  if (kind === 'removed' || kind === 'added') {
    exactKeys(candidate, ['kind', 'instanceId', kind === 'removed' ? 'before' : 'after']);
    string(candidate.instanceId, 128);
    instance(candidate[kind === 'removed' ? 'before' : 'after']);
    return;
  }
  if (kind === 'type') {
    exactKeys(candidate, ['kind', 'instanceId', 'beforeTypeId', 'afterTypeId']);
    string(candidate.instanceId, 128); nullableString(candidate.beforeTypeId); nullableString(candidate.afterTypeId); return;
  }
  if (kind === 'relation') {
    exactKeys(candidate, ['kind', 'instanceId', 'beforeOwnerId', 'afterOwnerId']);
    string(candidate.instanceId, 128); nullableString(candidate.beforeOwnerId); nullableString(candidate.afterOwnerId); return;
  }
  if (kind === 'variant') {
    exactKeys(candidate, ['kind', 'instanceId', 'before', 'after']);
    string(candidate.instanceId, 128);
    if (![candidate.before, candidate.after].every((item) => [
      'standard', 'unsupported-oneof-1', 'component6-oneof-11', 'component6-oneof-1', 'unknown',
    ].includes(item as string))) throw failure();
    return;
  }
  if (kind === 'position' || kind === 'rotation' || kind === 'scale') {
    exactKeys(candidate, ['kind', 'instanceId', 'components']); string(candidate.instanceId, 128); vectorComponents(candidate.components); return;
  }
  if (kind === 'feature') {
    exactKeys(candidate, ['kind', 'instanceId', 'field', 'before', 'after']);
    string(candidate.instanceId, 128);
    if (!['transform', 'customProperties', 'signals', 'resources', 'bounds'].includes(candidate.field as string)) throw failure();
    featureSummary(candidate.before); featureSummary(candidate.after); return;
  }
  if (kind === 'unknown-fields') {
    if (candidate.scope === 'instance') {
      exactKeys(candidate, ['kind', 'scope', 'instanceId', 'beforeSha256', 'afterSha256']); string(candidate.instanceId, 128);
    } else if (candidate.scope === 'group') {
      exactKeys(candidate, ['kind', 'scope', 'groupId', 'beforeSha256', 'afterSha256']); string(candidate.groupId, 128);
    } else if (candidate.scope === 'root') exactKeys(candidate, ['kind', 'scope', 'beforeSha256', 'afterSha256']);
    else throw failure();
    sha256(candidate.beforeSha256); sha256(candidate.afterSha256); return;
  }
  if (kind === 'group-added' || kind === 'group-removed') {
    exactKeys(candidate, ['kind', 'groupId', kind === 'group-added' ? 'after' : 'before']); string(candidate.groupId, 128);
    group(candidate[kind === 'group-added' ? 'after' : 'before']); return;
  }
  if (kind === 'group-members' || kind === 'group-nested') {
    exactKeys(candidate, ['kind', 'groupId', 'added', 'removed']); string(candidate.groupId, 128);
    stringArray(candidate.added, SCENE_WORKER_MAX_INSTANCES); stringArray(candidate.removed, SCENE_WORKER_MAX_INSTANCES); return;
  }
  if (kind === 'group-relation') {
    exactKeys(candidate, ['kind', 'groupId', 'beforeParentGroupId', 'afterParentGroupId']); string(candidate.groupId, 128);
    nullableString(candidate.beforeParentGroupId); nullableString(candidate.afterParentGroupId); return;
  }
  if (kind === 'group-feature') {
    exactKeys(candidate, ['kind', 'groupId', 'field', 'before', 'after']); string(candidate.groupId, 128);
    if (!['transform', 'metadata'].includes(candidate.field as string)) throw failure();
    featureSummary(candidate.before); featureSummary(candidate.after); return;
  }
  if (kind === 'root-feature') {
    exactKeys(candidate, ['kind', 'field', 'beforeSha256', 'afterSha256']);
    if (!['signalRegistry', 'sceneMetadata'].includes(candidate.field as string)) throw failure();
    sha256(candidate.beforeSha256); sha256(candidate.afterSha256); return;
  }
  if (kind === 'evidence') {
    if (candidate.scope === 'instance') {
      exactKeys(candidate, ['kind', 'scope', 'instanceId', 'field', 'before', 'after']);
      string(candidate.instanceId, 128);
      if (!['instance', 'transform', 'customProperties', 'signals', 'resources', 'bounds', 'bounds.value'].includes(candidate.field as string)) throw failure();
      if (candidate.before !== null) evidence(candidate.before); if (candidate.after !== null) evidence(candidate.after); return;
    }
    if (candidate.scope === 'group') {
      exactKeys(candidate, ['kind', 'scope', 'groupId', 'field', 'before', 'after']); string(candidate.groupId, 128);
      if (!['group', 'transform', 'metadata'].includes(candidate.field as string)) throw failure();
      if (candidate.before !== null) evidence(candidate.before); if (candidate.after !== null) evidence(candidate.after); return;
    }
  }
  throw failure();
}

function diffOptions(value: unknown): asserts value is SceneDiffOptions {
  const candidate = object(value);
  const allowed = ['positionTolerance', 'rotationTolerance', 'scaleTolerance'];
  if (Object.keys(candidate).some((key) => !allowed.includes(key))) throw failure();
  for (const item of Object.values(candidate)) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw failure();
  }
}

export function parseSceneWorkerRequest(value: unknown): SceneWorkerRequest {
  const candidate = object(value);
  if (candidate.protocolVersion !== SCENE_WORKER_PROTOCOL_VERSION) throw failure();
  requestId(candidate.requestId);
  if (candidate.kind === 'process') {
    exactKeys(candidate, ['protocolVersion', 'kind', 'requestId', 'input']);
    processInput(candidate.input);
    return candidate as unknown as Extract<SceneWorkerRequest, { kind: 'process' }>;
  }
  if (candidate.kind === 'index') {
    exactKeys(candidate, ['protocolVersion', 'kind', 'requestId', 'snapshot']);
    snapshot(candidate.snapshot);
    return candidate as unknown as Extract<SceneWorkerRequest, { kind: 'index' }>;
  }
  if (candidate.kind === 'diff') {
    exactKeys(candidate, ['protocolVersion', 'kind', 'requestId', 'before', 'after', 'options']);
    snapshot(candidate.before);
    snapshot(candidate.after);
    diffOptions(candidate.options);
    return candidate as unknown as Extract<SceneWorkerRequest, { kind: 'diff' }>;
  }
  throw failure();
}

export function parseSceneWorkerResponse(value: unknown): SceneWorkerResponse {
  const candidate = object(value);
  if (candidate.protocolVersion !== SCENE_WORKER_PROTOCOL_VERSION) throw failure();
  requestId(candidate.requestId);
  if (candidate.kind === 'progress') {
    exactKeys(candidate, ['protocolVersion', 'kind', 'requestId', 'phase']);
    if (!PHASES.has(candidate.phase as SceneWorkerPhase)) throw failure();
    return candidate as unknown as Extract<SceneWorkerResponse, { kind: 'progress' }>;
  }
  if (candidate.kind === 'result') {
    exactKeys(candidate, ['protocolVersion', 'kind', 'requestId', 'operation', 'value']);
    if (candidate.operation !== 'process' && candidate.operation !== 'index' && candidate.operation !== 'diff') throw failure();
    if (candidate.operation === 'process') processResult(candidate.value);
    else if (candidate.operation === 'index') sceneIndex(candidate.value);
    else sceneDiff(candidate.value);
    return candidate as unknown as Extract<SceneWorkerResponse, { kind: 'result' }>;
  }
  if (candidate.kind === 'error') {
    exactKeys(candidate, ['protocolVersion', 'kind', 'requestId', 'code', 'message', 'nextActions', 'evidence']);
    if (!ERROR_CODES.has(candidate.code as ErrorCode) || !EVIDENCE.has(candidate.evidence as EvidenceLevel)) throw failure();
    string(candidate.message, 512);
    if (!Array.isArray(candidate.nextActions) || candidate.nextActions.length > 8) throw failure();
    for (const action of candidate.nextActions) string(action, 256);
    return candidate as unknown as Extract<SceneWorkerResponse, { kind: 'error' }>;
  }
  throw failure();
}
