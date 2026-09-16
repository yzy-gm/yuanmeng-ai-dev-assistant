import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import type {
  FeatureState,
  FieldEvidence,
  SceneGroup,
  SceneInstance,
  SceneSnapshot,
  UnknownFieldSummary,
  Vector3,
} from './types.js';

export type VectorField = 'position' | 'rotation' | 'scale';
export type FeatureField = 'transform' | 'customProperties' | 'signals' | 'resources' | 'bounds';
export interface NumericDelta { before: number; after: number; delta: number }
export type VectorComponents = Partial<Record<keyof Vector3, NumericDelta>>;
export type FeatureSummary =
  | { state: 'observed'; valueSha256: string; count?: number }
  | { state: 'candidate'; wirePaths: string[] }
  | { state: 'unsupported'; reason: string }
  | { state: 'absent' };

export type SceneChange =
  | { kind: 'removed'; instanceId: string; before: SceneInstance }
  | { kind: 'added'; instanceId: string; after: SceneInstance }
  | { kind: 'type'; instanceId: string; beforeTypeId: string | null; afterTypeId: string | null }
  | { kind: 'relation'; instanceId: string; beforeOwnerId: string | null; afterOwnerId: string | null }
  | { kind: 'variant'; instanceId: string; before: SceneInstance['variant']; after: SceneInstance['variant'] }
  | { kind: VectorField; instanceId: string; components: VectorComponents }
  | { kind: 'feature'; instanceId: string; field: FeatureField; before: FeatureSummary; after: FeatureSummary }
  | { kind: 'unknown-fields'; scope: 'instance'; instanceId: string; beforeSha256: string; afterSha256: string }
  | { kind: 'unknown-fields'; scope: 'root'; beforeSha256: string; afterSha256: string }
  | { kind: 'group-added'; groupId: string; after: SceneGroup }
  | { kind: 'group-removed'; groupId: string; before: SceneGroup }
  | { kind: 'group-members'; groupId: string; added: string[]; removed: string[] }
  | { kind: 'group-nested'; groupId: string; added: string[]; removed: string[] }
  | { kind: 'group-relation'; groupId: string; beforeParentGroupId: string | null; afterParentGroupId: string | null }
  | { kind: 'group-feature'; groupId: string; field: 'transform' | 'metadata'; before: FeatureSummary; after: FeatureSummary }
  | { kind: 'root-feature'; field: 'signalRegistry' | 'sceneMetadata'; beforeSha256: string; afterSha256: string }
  | { kind: 'unknown-fields'; scope: 'group'; groupId: string; beforeSha256: string; afterSha256: string }
  | {
    kind: 'evidence'; scope: 'instance'; instanceId: string; field: 'instance' | FeatureField | 'bounds.value';
    before: FieldEvidence | null; after: FieldEvidence | null;
  }
  | {
    kind: 'evidence'; scope: 'group'; groupId: string; field: 'group' | 'transform' | 'metadata';
    before: FieldEvidence | null; after: FieldEvidence | null;
  };

export interface SceneDiffOptions {
  positionTolerance?: number;
  rotationTolerance?: number;
  scaleTolerance?: number;
}
export interface SceneDiff { fromSnapshotId: string; toSnapshotId: string; changes: SceneChange[] }

const FEATURE_FIELDS: readonly FeatureField[] = ['transform', 'customProperties', 'signals', 'resources', 'bounds'];
const CHANGE_ORDER: Readonly<Record<SceneChange['kind'], number>> = {
  removed: 0,
  added: 1,
  type: 2,
  relation: 3,
  variant: 4,
  position: 5,
  rotation: 6,
  scale: 7,
  feature: 8,
  'unknown-fields': 9,
  'group-removed': 10,
  'group-added': 11,
  'group-members': 12,
  'group-nested': 13,
  'group-relation': 14,
  'group-feature': 15,
  'root-feature': 16,
  evidence: 17,
};

function validateTolerance(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ProductError('VALIDATION_FAILED', `${name} 必须是有限非负数。`, ['修正场景差异容差。'], 'STATIC_LOCAL');
  }
  return value;
}

function assertSameLineage(before: SceneSnapshot, after: SceneSnapshot): void {
  if (before.bindingId === after.bindingId && before.role === after.role && before.adapterId === after.adapterId) return;
  throw new ProductError(
    'SCENE_SOURCE_CONFLICT',
    '场景快照不属于同一 binding、role 和 adapter lineage。',
    ['选择同一场景来源绑定、来源角色与解析适配器生成的两份快照。'],
    'STATIC_LOCAL',
  );
}

function assertDuplicateSafe(snapshot: SceneSnapshot): void {
  for (const [label, values] of [
    ['实例', snapshot.instances.map((instance) => instance.instanceId)],
    ['编组', snapshot.groups.map((group) => group.groupId)],
  ] as const) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) duplicates.add(value);
      seen.add(value);
    }
    if (duplicates.size > 0) {
      throw new ProductError(
        'SCENE_EVIDENCE_INSUFFICIENT',
        `${label} ID 重复（${[...duplicates].sort((left, right) => left.localeCompare(right, 'en')).join('、')}），差异计算不能采用 last-write-wins。`,
        ['先消除重复 ID 或更换可信快照。'],
        'STATIC_LOCAL',
      );
    }
  }
}

function vectorComponents(before: Vector3, after: Vector3, tolerance: number): VectorComponents {
  const components: VectorComponents = {};
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = after[axis] - before[axis];
    if (Math.abs(delta) > tolerance) components[axis] = { before: before[axis], after: after[axis], delta };
  }
  return components;
}

function normalizedValue(field: string, value: unknown): unknown {
  if (field !== 'bounds' || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const bounds = value as { min?: unknown; max?: unknown };
  return { min: bounds.min, max: bounds.max };
}

function featureSummary(field: string, feature: FeatureState<unknown>): FeatureSummary {
  if (feature.state === 'candidate') return { state: 'candidate', wirePaths: [...feature.wirePaths].sort() };
  if (feature.state === 'unsupported') return { state: 'unsupported', reason: feature.reason };
  if (feature.state === 'absent') return { state: 'absent' };
  const value = normalizedValue(field, feature.value);
  return {
    state: 'observed',
    ...(Array.isArray(value) ? { count: value.length } : {}),
    valueSha256: sha256Hex(stableJson(value)),
  };
}

function featureEvidence(feature: FeatureState<unknown>): FieldEvidence | null {
  return feature.state === 'observed' || feature.state === 'candidate' ? feature.evidence : null;
}

function equal(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function unknownHash(fields: readonly UnknownFieldSummary[]): string {
  return sha256Hex(stableJson([...fields].sort((left, right) => (
    left.path.localeCompare(right.path, 'en')
    || left.wireType - right.wireType
    || left.length - right.length
    || left.sha256.localeCompare(right.sha256, 'en')
  ))));
}

function setChange(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: [...afterSet].filter((value) => !beforeSet.has(value)).sort((left, right) => left.localeCompare(right, 'en')),
    removed: [...beforeSet].filter((value) => !afterSet.has(value)).sort((left, right) => left.localeCompare(right, 'en')),
  };
}

function changeKey(change: SceneChange): string {
  if ('instanceId' in change) return change.instanceId;
  if ('groupId' in change) return change.groupId;
  return '';
}

function changeField(change: SceneChange): string {
  if (change.kind === 'feature' || change.kind === 'group-feature' || change.kind === 'root-feature' || change.kind === 'evidence') return change.field;
  if (change.kind === 'unknown-fields') return change.scope;
  return '';
}

export function diffSceneSnapshots(before: SceneSnapshot, after: SceneSnapshot, options: SceneDiffOptions = {}): SceneDiff {
  assertSameLineage(before, after);
  assertDuplicateSafe(before);
  assertDuplicateSafe(after);
  const tolerances = {
    position: validateTolerance(options.positionTolerance ?? 0.0001, 'positionTolerance'),
    rotation: validateTolerance(options.rotationTolerance ?? 0.0001, 'rotationTolerance'),
    scale: validateTolerance(options.scaleTolerance ?? 0.0001, 'scaleTolerance'),
  };
  const beforeById = new Map(before.instances.map((instance) => [instance.instanceId, instance]));
  const afterById = new Map(after.instances.map((instance) => [instance.instanceId, instance]));
  const changes: SceneChange[] = [];
  for (const instance of before.instances) if (!afterById.has(instance.instanceId)) changes.push({ kind: 'removed', instanceId: instance.instanceId, before: instance });
  for (const instance of after.instances) if (!beforeById.has(instance.instanceId)) changes.push({ kind: 'added', instanceId: instance.instanceId, after: instance });
  const sharedIds = [...beforeById.keys()].filter((id) => afterById.has(id)).sort((left, right) => left.localeCompare(right, 'en'));
  for (const instanceId of sharedIds) {
    const left = beforeById.get(instanceId)!;
    const right = afterById.get(instanceId)!;
    if (left.elementTypeId !== right.elementTypeId) changes.push({ kind: 'type', instanceId, beforeTypeId: left.elementTypeId, afterTypeId: right.elementTypeId });
    if (left.ownerId !== right.ownerId) changes.push({ kind: 'relation', instanceId, beforeOwnerId: left.ownerId, afterOwnerId: right.ownerId });
    if (left.variant !== right.variant) changes.push({ kind: 'variant', instanceId, before: left.variant, after: right.variant });
    if (left.transform.state === 'observed' && right.transform.state === 'observed') {
      for (const field of ['position', 'rotation', 'scale'] as const) {
        const components = vectorComponents(left.transform.value[field], right.transform.value[field], tolerances[field]);
        if (Object.keys(components).length > 0) changes.push({ kind: field, instanceId, components });
      }
    }
    for (const field of FEATURE_FIELDS) {
      const leftFeature = left[field] as FeatureState<unknown>;
      const rightFeature = right[field] as FeatureState<unknown>;
      const beforeSummary = featureSummary(field, leftFeature);
      const afterSummary = featureSummary(field, rightFeature);
      const vectorValuesHandled = field === 'transform'
        && leftFeature.state === 'observed'
        && rightFeature.state === 'observed';
      if (!vectorValuesHandled && !equal(beforeSummary, afterSummary)) {
        changes.push({ kind: 'feature', instanceId, field, before: beforeSummary, after: afterSummary });
      }
      const beforeEvidence = featureEvidence(leftFeature);
      const afterEvidence = featureEvidence(rightFeature);
      if (!equal(beforeEvidence, afterEvidence)) {
        changes.push({ kind: 'evidence', scope: 'instance', instanceId, field, before: beforeEvidence, after: afterEvidence });
      }
    }
    if (
      left.bounds.state === 'observed'
      && right.bounds.state === 'observed'
      && !equal(left.bounds.value.evidence, right.bounds.value.evidence)
    ) {
      changes.push({
        kind: 'evidence',
        scope: 'instance',
        instanceId,
        field: 'bounds.value',
        before: left.bounds.value.evidence,
        after: right.bounds.value.evidence,
      });
    }
    if (!equal(left.evidence, right.evidence)) {
      changes.push({ kind: 'evidence', scope: 'instance', instanceId, field: 'instance', before: left.evidence, after: right.evidence });
    }
    const beforeUnknown = unknownHash(left.unknownFields);
    const afterUnknown = unknownHash(right.unknownFields);
    if (beforeUnknown !== afterUnknown) changes.push({ kind: 'unknown-fields', scope: 'instance', instanceId, beforeSha256: beforeUnknown, afterSha256: afterUnknown });
  }

  const beforeGroups = new Map(before.groups.map((group) => [group.groupId, group]));
  const afterGroups = new Map(after.groups.map((group) => [group.groupId, group]));
  for (const group of before.groups) if (!afterGroups.has(group.groupId)) changes.push({ kind: 'group-removed', groupId: group.groupId, before: group });
  for (const group of after.groups) if (!beforeGroups.has(group.groupId)) changes.push({ kind: 'group-added', groupId: group.groupId, after: group });
  for (const groupId of [...beforeGroups.keys()].filter((id) => afterGroups.has(id)).sort((left, right) => left.localeCompare(right, 'en'))) {
    const left = beforeGroups.get(groupId)!;
    const right = afterGroups.get(groupId)!;
    const members = setChange(left.memberIds, right.memberIds);
    if (members.added.length > 0 || members.removed.length > 0) changes.push({ kind: 'group-members', groupId, ...members });
    const nested = setChange(left.nestedGroupIds, right.nestedGroupIds);
    if (nested.added.length > 0 || nested.removed.length > 0) changes.push({ kind: 'group-nested', groupId, ...nested });
    if ((left.parentGroupId ?? null) !== (right.parentGroupId ?? null)) changes.push({
      kind: 'group-relation', groupId,
      beforeParentGroupId: left.parentGroupId ?? null,
      afterParentGroupId: right.parentGroupId ?? null,
    });
    for (const field of ['transform', 'metadata'] as const) {
      const leftFeature = left[field] ?? { state: 'absent' as const };
      const rightFeature = right[field] ?? { state: 'absent' as const };
      const beforeSummary = featureSummary(field, leftFeature);
      const afterSummary = featureSummary(field, rightFeature);
      if (!equal(beforeSummary, afterSummary)) changes.push({ kind: 'group-feature', groupId, field, before: beforeSummary, after: afterSummary });
      const beforeEvidence = featureEvidence(leftFeature);
      const afterEvidence = featureEvidence(rightFeature);
      if (!equal(beforeEvidence, afterEvidence)) changes.push({ kind: 'evidence', scope: 'group', groupId, field, before: beforeEvidence, after: afterEvidence });
    }
    const beforeGroupUnknown = unknownHash(left.unknownFields ?? []);
    const afterGroupUnknown = unknownHash(right.unknownFields ?? []);
    if (beforeGroupUnknown !== afterGroupUnknown) changes.push({
      kind: 'unknown-fields', scope: 'group', groupId,
      beforeSha256: beforeGroupUnknown, afterSha256: afterGroupUnknown,
    });
    if (!equal(left.evidence, right.evidence)) changes.push({ kind: 'evidence', scope: 'group', groupId, field: 'group', before: left.evidence, after: right.evidence });
  }
  const beforeRootUnknown = unknownHash(before.unknownFields);
  const afterRootUnknown = unknownHash(after.unknownFields);
  if (beforeRootUnknown !== afterRootUnknown) changes.push({ kind: 'unknown-fields', scope: 'root', beforeSha256: beforeRootUnknown, afterSha256: afterRootUnknown });
  for (const field of ['signalRegistry', 'sceneMetadata'] as const) {
    const beforeSha256 = sha256Hex(stableJson(before[field] ?? null));
    const afterSha256 = sha256Hex(stableJson(after[field] ?? null));
    if (beforeSha256 !== afterSha256) changes.push({ kind: 'root-feature', field, beforeSha256, afterSha256 });
  }

  changes.sort((left, right) => (
    CHANGE_ORDER[left.kind] - CHANGE_ORDER[right.kind]
    || changeKey(left).localeCompare(changeKey(right), 'en')
    || changeField(left).localeCompare(changeField(right), 'en')
    || stableJson(left).localeCompare(stableJson(right), 'en')
  ));
  return { fromSnapshotId: before.snapshotId, toSnapshotId: after.snapshotId, changes };
}
