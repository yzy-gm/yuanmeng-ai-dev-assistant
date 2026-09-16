import { TextDecoder } from 'node:util';

import { sha256Hex, stableJson } from '../hash.js';
import { ProductError } from '../errors.js';
import { bytesForField, fixed32Float, parseWireDocument, type SceneWireField } from './wire.js';
import { SCENE_WORKER_MAX_GROUPS, SCENE_WORKER_MAX_INSTANCES } from './worker-protocol.js';
import type {
  FieldEvidence,
  FeatureState,
  NormalizeSceneOptions,
  SceneGroup,
  SceneInstance,
  SceneIssue,
  SceneMetadata,
  SceneSnapshot,
  Transform,
  UnknownFieldSummary,
  Vector3,
} from './types.js';

// 适配器 ID 也是同源缓存的语义版本。任何会改变规范化结果的校准都必须递增，
// 否则相同 LayerData 的旧快照会被误复用。
export const SCENE_ADAPTER_ID = 'ym-layerdata-observed-v6';

export function sceneSnapshotNeedsAdapterRefresh(snapshot: Pick<SceneSnapshot, 'adapterId'>): boolean {
  return snapshot.adapterId !== SCENE_ADAPTER_ID;
}
const OBSERVED_EVIDENCE: FieldEvidence = Object.freeze({
  state: 'observed-repeatable',
  source: 'controlled-local-calibration',
  confidence: 0.9,
});
const CANDIDATE_EVIDENCE: FieldEvidence = Object.freeze({
  state: 'inferred-candidate',
  source: 'wire-location-only',
  confidence: 0.25,
});
const UNKNOWN_EVIDENCE: FieldEvidence = Object.freeze({
  state: 'unknown',
  source: 'not-calibrated',
  confidence: 0,
});

function fields(fields: readonly SceneWireField[], fieldNumber: number): SceneWireField[] {
  return fields.filter((field) => field.fieldNumber === fieldNumber);
}

function first(fieldsToSearch: readonly SceneWireField[], fieldNumber: number): SceneWireField | null {
  return fieldsToSearch.find((field) => field.fieldNumber === fieldNumber) ?? null;
}

function message(payload: Uint8Array, field: SceneWireField | null): { payload: Uint8Array; fields: SceneWireField[] } | null {
  if (field?.value.kind !== 'bytes') return null;
  const nestedPayload = bytesForField(payload, field);
  const document = parseWireDocument(nestedPayload);
  return { payload: nestedPayload, fields: document.fields };
}

function decimal(field: SceneWireField | null): string | null {
  return field?.value.kind === 'varint' ? field.value.unsignedDecimal : null;
}

function vector(payload: Uint8Array, field: SceneWireField | null): Vector3 | null {
  const nested = message(payload, field);
  if (nested === null) return null;
  const xField = first(nested.fields, 1);
  const yField = first(nested.fields, 2);
  const zField = first(nested.fields, 3);
  if (xField?.value.kind !== 'fixed32' || yField?.value.kind !== 'fixed32' || zField?.value.kind !== 'fixed32') return null;
  const value = { x: fixed32Float(xField), y: fixed32Float(yField), z: fixed32Float(zField) };
  return Object.values(value).every(Number.isFinite) ? value : null;
}

function nestedField(
  start: { payload: Uint8Array; fields: SceneWireField[] } | null,
  path: readonly number[],
): { payload: Uint8Array; fields: SceneWireField[] } | null {
  let current = start;
  for (const fieldNumber of path) current = current === null ? null : message(current.payload, first(current.fields, fieldNumber));
  return current;
}

function commonBaseFromInstance(
  instancePayload: Uint8Array,
  instanceFields: SceneWireField[],
): { base: { payload: Uint8Array; fields: SceneWireField[] } | null; variant: SceneInstance['variant'] } {
  const component6 = message(instancePayload, first(instanceFields, 6));
  if (component6 === null) return { base: null, variant: 'unknown' };
  if (first(component6.fields, 11) !== null) {
    return { base: nestedField(component6, [11, 1]), variant: 'component6-oneof-11' };
  }
  if (first(component6.fields, 1) !== null) {
    return { base: nestedField(component6, [1, 1, 1, 1]), variant: 'component6-oneof-1' };
  }
  return { base: null, variant: 'unknown' };
}

function transformFromCommonBase(commonBase: { payload: Uint8Array; fields: SceneWireField[] } | null): FeatureState<Transform> {
  const transformCarrier = commonBase === null ? null : message(commonBase.payload, first(commonBase.fields, 1));
  if (transformCarrier === null) return { state: 'unsupported', reason: '缺少已校准的 transform carrier。' };
  const position = vector(transformCarrier.payload, first(transformCarrier.fields, 1));
  const rotation = vector(transformCarrier.payload, first(transformCarrier.fields, 2));
  const scale = vector(transformCarrier.payload, first(transformCarrier.fields, 3));
  if (position === null || rotation === null || scale === null) return { state: 'unsupported', reason: 'transform vec3 结构与已校准路径不一致。' };
  return { state: 'observed', value: { position, rotation, scale }, evidence: OBSERVED_EVIDENCE };
}

function safeText(payload: Uint8Array, field: SceneWireField | null): string | null {
  if (field?.value.kind !== 'bytes' || field.value.length === 0 || field.value.length > 512) return null;
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytesForField(payload, field));
    if (value.trim() === '' || [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return (codePoint >= 0 && codePoint <= 8) || codePoint === 11 || codePoint === 12
        || (codePoint >= 14 && codePoint <= 31) || codePoint === 127;
    })) return null;
    // 编程元件的附加数据可能含口令/令牌；解析边界直接拒绝高风险文本，绝不先落盘再隐藏。
    if (/(?:password|passwd|pwd|passphrase|token|secret|authorization|bearer|api[_-]?key|access[_-]?key|credential|cookie|session|private[_-]?key|密码|口令|密钥)/iu.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function customPropertiesFromCommonBase(
  commonBase: { payload: Uint8Array; fields: SceneWireField[] } | null,
): FeatureState<Array<{ key: string; value: unknown }>> {
  if (commonBase === null) return { state: 'candidate', wirePaths: [], evidence: CANDIDATE_EVIDENCE };
  const values = fields(commonBase.fields, 23).flatMap((propertyField) => {
    const property = message(commonBase.payload, propertyField);
    if (property === null) return [];
    const key = safeText(property.payload, first(property.fields, 2));
    if (key === null) return [];
    const valueUnion = message(property.payload, first(property.fields, 7));
    const numericCarrier = valueUnion === null ? null : message(valueUnion.payload, first(valueUnion.fields, 2));
    const numericField = numericCarrier === null ? undefined : first(numericCarrier.fields, 11);
    const numericValue = numericField?.value.kind === 'fixed32' ? fixed32Float(numericField) : null;
    return [{
      key,
      value: numericValue === null || !Number.isFinite(numericValue)
        ? { kind: 'unrecognized' }
        : { kind: 'number', value: numericValue },
    }];
  });
  return values.length === 0
    ? { state: 'candidate', wirePaths: ['component.commonBase.field23'], evidence: CANDIDATE_EVIDENCE }
    : { state: 'observed', value: values, evidence: OBSERVED_EVIDENCE };
}

function signalsFromCommonBase(
  commonBase: { payload: Uint8Array; fields: SceneWireField[] } | null,
): FeatureState<Array<{ name: string }>> {
  if (commonBase === null) return { state: 'candidate', wirePaths: [], evidence: CANDIDATE_EVIDENCE };
  const names = fields(commonBase.fields, 12)
    .map((field) => safeText(commonBase.payload, field))
    .filter((value): value is string => value !== null);
  const unique = [...new Set(names)].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return unique.length === 0
    ? { state: 'candidate', wirePaths: ['component.commonBase.field12'], evidence: CANDIDATE_EVIDENCE }
    : { state: 'observed', value: unique.map((name) => ({ name })), evidence: OBSERVED_EVIDENCE };
}

function unknownSummaries(
  payload: Uint8Array,
  fieldsToSummarize: readonly SceneWireField[],
  recognized: ReadonlySet<number>,
  prefix: string,
): UnknownFieldSummary[] {
  return fieldsToSummarize.flatMap((field) => {
    if (recognized.has(field.fieldNumber)) return [];
    const encoded = payload.subarray(field.startOffset, field.endOffset);
    return [{
      path: `${prefix}${field.path.slice(1)}`,
      wireType: field.wireType,
      length: encoded.byteLength,
      sha256: sha256Hex(encoded),
    }];
  }).slice(0, 256);
}

function normalizeInstance(payload: Uint8Array, bucketElementTypeId: string | null, issues: SceneIssue[]): SceneInstance | null {
  const document = parseWireDocument(payload);
  const instanceId = decimal(first(document.fields, 2));
  if (instanceId === null) return null;
  const elementTypeId = decimal(first(document.fields, 1)) ?? bucketElementTypeId;
  const ownerId = decimal(first(document.fields, 3));
  const { base: commonBase, variant } = commonBaseFromInstance(payload, document.fields);
  const transform = transformFromCommonBase(commonBase);
  if (variant === 'unknown') {
    issues.push({ code: 'UNSUPPORTED_INSTANCE_VARIANT', message: `实例 ${instanceId} 使用尚未校准的组件分支。`, instanceId });
  }
  return {
    instanceId,
    elementTypeId,
    ownerId,
    variant,
    evidence: OBSERVED_EVIDENCE,
    transform,
    customProperties: customPropertiesFromCommonBase(commonBase),
    signals: signalsFromCommonBase(commonBase),
    resources: { state: 'candidate', wirePaths: [], evidence: CANDIDATE_EVIDENCE },
    // 当前适配器尚未校准尺寸/包围字段。没有命中不等于编辑器中明确不存在，
    // 因此必须保留为 unknown candidate，禁止误报为 absent。
    bounds: { state: 'candidate', wirePaths: [], evidence: UNKNOWN_EVIDENCE },
    unknownFields: [
      // 未识别的 component oneof 不能因为外层 field 6 已知就被吞掉；保留
      // 完整 field span/hash，后续校准只能基于摘要重新比对，不能猜内部语义。
      ...unknownSummaries(
        payload,
        document.fields,
        new Set(variant === 'unknown' ? [1, 2, 3] : [1, 2, 3, 6]),
        `instances[${instanceId}]`,
      ),
      ...(commonBase === null ? [] : unknownSummaries(
        commonBase.payload,
        commonBase.fields,
        new Set([1, 12, 23]),
        `instances[${instanceId}].commonBase`,
      )),
      ...(message(payload, first(document.fields, 6)) === null ? [] : unknownSummaries(
        message(payload, first(document.fields, 6))!.payload,
        message(payload, first(document.fields, 6))!.fields,
        new Set(variant === 'component6-oneof-11' || variant === 'component6-oneof-1' ? [11, 1] : []),
        `instances[${instanceId}].component6`,
      )),
    ].slice(0, 256),
  };
}

interface RawSceneGroup {
  groupId: string;
  memberIds: string[];
  parentGroupId: string | null;
  directChildGroupIds: string[];
  transform: FeatureState<Transform>;
  opaqueRef: string | null;
  unknownFields: UnknownFieldSummary[];
}

function normalizeGroup(payload: Uint8Array): RawSceneGroup | null {
  const document = parseWireDocument(payload);
  const groupId = decimal(first(document.fields, 1));
  if (groupId === null) return null;
  const memberIds = fields(document.fields, 3).flatMap((field) => {
    const value = decimal(field);
    return value === null ? [] : [value];
  });
  // 受控场景差分表明 field 2 是“当前编组的父编组”，不是当前编组包含的子编组。
  // 先保留父引用，完成全部编组读取后再反向建立 parent.nestedGroupIds。
  const parentGroupId = decimal(first(document.fields, 2));
  const directChildGroupIds = fields(document.fields, 4).flatMap((field) => {
    const value = decimal(field);
    return value === null ? [] : [value];
  });
  const transformCarrier = message(payload, first(document.fields, 7));
  let transform: FeatureState<Transform> = { state: 'absent' };
  if (transformCarrier !== null) {
    const position = vector(transformCarrier.payload, first(transformCarrier.fields, 1));
    const rotation = vector(transformCarrier.payload, first(transformCarrier.fields, 2));
    const scale = vector(transformCarrier.payload, first(transformCarrier.fields, 3));
    transform = position === null || rotation === null || scale === null
      ? { state: 'unsupported', reason: '编组 transform 结构与已校准路径不一致。' }
      : { state: 'observed', value: { position, rotation, scale }, evidence: OBSERVED_EVIDENCE };
  }
  return {
    groupId,
    memberIds,
    parentGroupId,
    directChildGroupIds,
    transform,
    opaqueRef: decimal(first(document.fields, 6)),
    unknownFields: unknownSummaries(payload, document.fields, new Set([1, 2, 3, 4, 6, 7]), `groups[${groupId}]`),
  };
}

interface GroupMetadataRecord {
  groupId: string;
  opaqueRef: string | null;
  rawKind: string | null;
  labelCandidate: string | null;
  unknownFields: UnknownFieldSummary[];
}

function normalizeGroupMetadata(payload: Uint8Array): GroupMetadataRecord | null {
  const document = parseWireDocument(payload);
  const groupId = decimal(first(document.fields, 2));
  if (groupId === null) return null;
  return {
    groupId,
    opaqueRef: decimal(first(document.fields, 1)),
    rawKind: decimal(first(document.fields, 5)),
    labelCandidate: safeText(payload, first(document.fields, 4)),
    unknownFields: unknownSummaries(payload, document.fields, new Set([1, 2, 4, 5]), `groupMetadata[${groupId}]`),
  };
}

function normalizeSignalRegistry(payload: Uint8Array, rootFields: readonly SceneWireField[]): NonNullable<SceneSnapshot['signalRegistry']> {
  const records = fields(rootFields, 9).flatMap((signalField) => {
    const record = message(payload, signalField);
    if (record === null) return [];
    const name = safeText(record.payload, first(record.fields, 1));
    if (name === null) return [];
    return [{
      name,
      unknownRefCount: fields(record.fields, 3).length,
      unknownFields: unknownSummaries(record.payload, record.fields, new Set([1, 3]), `signalRegistry[${name}]`),
    }];
  });
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  const retained = records.map((record) => {
    const duplicate = (counts.get(record.name) ?? 0) > 1;
    const unknownFields = record.unknownFields.length === 0 ? undefined : record.unknownFields;
    return duplicate
      ? { ...record, ambiguous: true, ...(unknownFields === undefined ? {} : { unknownFields }) }
      : unknownFields === undefined
        ? { name: record.name, unknownRefCount: record.unknownRefCount }
        : { name: record.name, unknownRefCount: record.unknownRefCount, unknownFields };
  });
  return retained.length === 0
    ? { state: 'candidate', wirePaths: ['$.9[]'], evidence: CANDIDATE_EVIDENCE }
    : { state: 'observed', value: retained.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')), evidence: OBSERVED_EVIDENCE };
}

function observedText(payload: Uint8Array, rootFields: readonly SceneWireField[], fieldNumber: number): FeatureState<string> {
  const value = safeText(payload, first(rootFields, fieldNumber));
  return value === null
    ? { state: 'candidate', wirePaths: [`$.${fieldNumber}[]`], evidence: CANDIDATE_EVIDENCE }
    : { state: 'observed', value, evidence: OBSERVED_EVIDENCE };
}

function normalizeSceneMetadata(
  payload: Uint8Array,
  rootFields: readonly SceneWireField[],
  instances: readonly SceneInstance[],
  issues: SceneIssue[],
): SceneMetadata {
  const indexIds: string[] = [];
  const rawStatusValues = new Set<string>();
  const indexUnknownFields: UnknownFieldSummary[] = [];
  for (const indexField of fields(rootFields, 7)) {
    const record = message(payload, indexField);
    if (record === null) continue;
    const id = decimal(first(record.fields, 1));
    if (id !== null) indexIds.push(id);
    const rawStatus = decimal(first(record.fields, 2));
    if (rawStatus !== null) rawStatusValues.add(rawStatus);
    indexUnknownFields.push(...unknownSummaries(record.payload, record.fields, new Set([1, 2]), `sceneMetadata.instanceIndex[]`));
  }
  const instanceIds = new Set(instances.map((instance) => instance.instanceId));
  const counts = new Map<string, number>();
  for (const id of indexIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort((a, b) => a.localeCompare(b, 'en'));
  const indexSet = new Set(indexIds);
  const missingInstanceIds = [...instanceIds].filter((id) => !indexSet.has(id)).sort((a, b) => a.localeCompare(b, 'en'));
  const extraInstanceIds = [...indexSet].filter((id) => !instanceIds.has(id)).sort((a, b) => a.localeCompare(b, 'en'));
  for (const id of duplicateIds) issues.push({ code: 'INSTANCE_INDEX_DUPLICATE', message: `实例索引中的 ID ${id} 重复。`, instanceId: id });
  for (const id of missingInstanceIds) issues.push({ code: 'INSTANCE_INDEX_MISSING', message: `实例 ${id} 没有对应的根级索引记录。`, instanceId: id });
  for (const id of extraInstanceIds) issues.push({ code: 'INSTANCE_INDEX_EXTRA', message: `根级索引记录 ${id} 没有对应实例。`, instanceId: id });
  return {
    layerName: observedText(payload, rootFields, 2),
    editorVersionCandidate: observedText(payload, rootFields, 11),
    instanceIndex: indexIds.length === 0
      ? { state: 'candidate', wirePaths: ['$.7[]'], evidence: CANDIDATE_EVIDENCE }
      : {
        state: 'observed',
        value: {
          entryCount: indexIds.length,
          duplicateIds,
          missingInstanceIds,
          extraInstanceIds,
          rawStatusValues: [...rawStatusValues].sort((a, b) => a.localeCompare(b, 'en')),
          ...(indexUnknownFields.length === 0 ? {} : { unknownFields: indexUnknownFields.slice(0, 256) }),
        },
        evidence: OBSERVED_EVIDENCE,
      },
  };
}

export function normalizeObservedScene(payload: Uint8Array, options: NormalizeSceneOptions): SceneSnapshot {
  const maxInstances = options.limits?.maxInstances ?? SCENE_WORKER_MAX_INSTANCES;
  const maxGroups = options.limits?.maxGroups ?? SCENE_WORKER_MAX_GROUPS;
  if (
    !Number.isSafeInteger(maxInstances) || maxInstances < 1 || maxInstances > SCENE_WORKER_MAX_INSTANCES
    || !Number.isSafeInteger(maxGroups) || maxGroups < 1 || maxGroups > SCENE_WORKER_MAX_GROUPS
  ) {
    throw new ProductError('VALIDATION_FAILED', '场景规范化限额无效。', ['使用后台任务允许的安全限额。'], 'STATIC_LOCAL');
  }
  const root = parseWireDocument(payload);
  const instances: SceneInstance[] = [];
  const rawGroups: RawSceneGroup[] = [];
  const groupMetadata = new Map<string, GroupMetadataRecord>();
  const issues: SceneIssue[] = [];
  for (const bodyField of fields(root.fields, 5)) {
    const body = message(payload, bodyField);
    if (body === null) continue;
    for (const bucketField of fields(body.fields, 24)) {
      const bucket = message(body.payload, bucketField);
      if (bucket === null) continue;
      const bucketElementTypeId = decimal(first(bucket.fields, 1));
      for (const instanceField of fields(bucket.fields, 2)) {
        if (instanceField.value.kind !== 'bytes') continue;
        const normalized = normalizeInstance(bytesForField(bucket.payload, instanceField), bucketElementTypeId, issues);
        if (normalized !== null) {
          if (instances.length >= maxInstances) {
            throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景实例数量超过后台任务上限。', ['减少场景规模或拆分地图后重试。'], 'STATIC_LOCAL');
          }
          instances.push(normalized);
        }
      }
    }
    for (const groupField of fields(body.fields, 2)) {
      if (groupField.value.kind !== 'bytes') continue;
      const normalized = normalizeGroup(bytesForField(body.payload, groupField));
      if (normalized !== null) {
        if (rawGroups.length >= maxGroups) {
          throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景编组数量超过后台任务上限。', ['减少编组规模或拆分地图后重试。'], 'STATIC_LOCAL');
        }
        rawGroups.push(normalized);
      }
    }
  }
  for (const metadataField of fields(root.fields, 6)) {
    if (metadataField.value.kind !== 'bytes') continue;
    const normalized = normalizeGroupMetadata(bytesForField(payload, metadataField));
    if (normalized !== null && !groupMetadata.has(normalized.groupId)) groupMetadata.set(normalized.groupId, normalized);
  }
  if (instances.length === 0) {
    throw new ProductError('UNSUPPORTED_SCENE_SCHEMA', '未找到已校准的场景实例结构。', ['保留文件并运行匿名字段校准。'], 'STATIC_LOCAL');
  }
  const groupCounts = new Map<string, number>();
  for (const group of rawGroups) groupCounts.set(group.groupId, (groupCounts.get(group.groupId) ?? 0) + 1);
  const nestedByParent = new Map<string, string[]>();
  for (const group of rawGroups) {
    if (
      group.parentGroupId === null
      || groupCounts.get(group.groupId) !== 1
      || groupCounts.get(group.parentGroupId) !== 1
    ) continue;
    nestedByParent.set(group.parentGroupId, [...(nestedByParent.get(group.parentGroupId) ?? []), group.groupId]);
  }
  for (const group of rawGroups) {
    for (const childId of group.directChildGroupIds) {
      const childMatches = rawGroups.filter((candidate) => candidate.groupId === childId);
      if (childMatches.length === 1) {
        const childParent = childMatches[0]!.parentGroupId;
        if (childParent !== null && childParent !== group.groupId) {
          issues.push({
            code: 'GROUP_RELATION_CONFLICT',
            message: `编组 ${group.groupId} 声明直接子编组 ${childId}，但子编组的父引用是 ${childParent}。`,
            instanceId: childId,
          });
        }
      }
    }
  }
  const groups: SceneGroup[] = rawGroups.map((group) => ({
    groupId: group.groupId,
    memberIds: group.memberIds,
    nestedGroupIds: [...new Set([...group.directChildGroupIds, ...(nestedByParent.get(group.groupId) ?? [])])]
      .sort((left, right) => left.localeCompare(right, 'en')),
    evidence: OBSERVED_EVIDENCE,
    parentGroupId: group.parentGroupId,
    transform: group.transform,
    metadata: (() => {
      const record = groupMetadata.get(group.groupId);
      if (record === undefined) return { state: 'absent' } as const;
      return {
        state: 'observed' as const,
        value: {
          opaqueRef: record.opaqueRef ?? group.opaqueRef,
          rawKind: record.rawKind,
          labelCandidate: record.labelCandidate,
          ...(record.unknownFields.length === 0 ? {} : { unknownFields: record.unknownFields }),
        },
        evidence: CANDIDATE_EVIDENCE,
      };
    })(),
    unknownFields: group.unknownFields,
  }));
  instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en'));
  groups.sort((left, right) => left.groupId.localeCompare(right.groupId, 'en'));
  const duplicateIds = new Set<string>();
  for (let index = 1; index < instances.length; index += 1) if (instances[index - 1]!.instanceId === instances[index]!.instanceId) duplicateIds.add(instances[index]!.instanceId);
  for (const instanceId of duplicateIds) issues.push({ code: 'DUPLICATE_INSTANCE', message: `实例 ID ${instanceId} 重复。`, instanceId });
  const sceneMetadata = normalizeSceneMetadata(payload, root.fields, instances, issues);
  const unknownFields = unknownSummaries(payload, root.fields, new Set([2, 5, 6, 7, 9, 11]), '$');
  const identity = stableJson({ adapterId: SCENE_ADAPTER_ID, bindingId: options.bindingId, role: options.role, sourceSha256: options.sourceSha256 });
  return {
    schemaVersion: 1,
    snapshotId: sha256Hex(identity),
    bindingId: options.bindingId,
    role: options.role,
    sourceSha256: options.sourceSha256,
    observedAt: options.observedAt,
    adapterId: SCENE_ADAPTER_ID,
    instances,
    groups,
    issues,
    unknownFields,
    signalRegistry: normalizeSignalRegistry(payload, root.fields),
    sceneMetadata,
  };
}
