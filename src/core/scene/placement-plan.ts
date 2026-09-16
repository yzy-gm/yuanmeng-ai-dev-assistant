import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import { aabbUnion, type AabbGeometry } from './spatial.js';
import { createSceneIndex, queryScene } from './index.js';
import type { FieldEvidence, SceneGroup, SceneInstance, SceneSnapshot, Transform, Vector3 } from './types.js';

export type SceneAxis = 'x' | 'y' | 'z';
export type TransformComponent = `position.${SceneAxis}` | `rotation.${SceneAxis}` | `scale.${SceneAxis}`;
export type PlacementOperationKind = 'floor-align' | 'axis-align' | 'equal-spacing' | 'grid' | 'rows' | 'columns' | 'batch-offset';

export type ScenePlacementRequest =
  | { kind: 'floor-align'; targetIds: string[]; supportId: string; preserveGroupRelative?: boolean }
  | { kind: 'axis-align'; targetIds: string[]; referenceId: string; axis: SceneAxis; anchor: 'position' | 'min' | 'center' | 'max'; preserveGroupRelative?: boolean }
  | { kind: 'equal-spacing'; targetIds: string[]; axis: SceneAxis; mode: 'position' | 'bounds-gap'; preserveGroupRelative?: boolean }
  | { kind: 'grid'; targetIds: string[]; rowAxis: SceneAxis; columnAxis: SceneAxis; columns: number; rowSpacing: number; columnSpacing: number; preserveGroupRelative?: boolean }
  | { kind: 'rows'; targetIds: string[]; axis: SceneAxis; spacing: number; preserveGroupRelative?: boolean }
  | { kind: 'columns'; targetIds: string[]; axis: SceneAxis; spacing: number; preserveGroupRelative?: boolean }
  | {
    kind: 'batch-offset'; targetIds: string[];
    components: { position?: Partial<Vector3>; rotation?: Partial<Vector3>; scale?: Partial<Vector3> };
    preserveGroupRelative?: boolean;
  };

export interface SceneTransformChange {
  instanceId: string;
  oldTransform: Transform;
  newTransform: Transform;
  delta: Transform;
  mask: TransformComponent[];
}

export interface ScenePlacementRisk {
  code: 'BOUNDS_UNAVAILABLE' | 'GROUP_EXPANDED' | 'NO_EFFECT';
  instanceIds: string[];
  message: string;
}

export interface ScenePlacementPlan {
  schemaVersion: 1;
  planId: string;
  snapshotId: string;
  bindingId: string;
  operation: PlacementOperationKind;
  requestedTargetIds: string[];
  affectedInstanceIds: string[];
  referenceIds: string[];
  status: 'ready' | 'evidence-insufficient';
  reasonCode: 'PREVIEW_ONLY' | 'BOUNDS_EVIDENCE_REQUIRED' | 'TRANSFORM_EVIDENCE_REQUIRED';
  execute: false;
  changes: SceneTransformChange[];
  rollback: { changes: SceneTransformChange[] };
  evidence: FieldEvidence[];
  risks: ScenePlacementRisk[];
}

interface PlacementUnit {
  key: string;
  instances: SceneInstance[];
  expanded: boolean;
}

const ZERO_VECTOR: Vector3 = Object.freeze({ x: 0, y: 0, z: 0 });

function trusted(evidence: FieldEvidence): boolean {
  return evidence.state === 'confirmed-calibration' || evidence.state === 'observed-repeatable';
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function copyTransform(value: Transform): Transform {
  return {
    position: { ...value.position },
    rotation: { ...value.rotation },
    scale: { ...value.scale },
  };
}

function requireUniqueInstance(snapshot: SceneSnapshot, instanceId: string): SceneInstance {
  const found = queryScene(createSceneIndex(snapshot), { instanceId });
  if (found.kind === 'not-found') {
    throw new ProductError('NOT_FOUND', `场景中没有实例 ${instanceId}。`, ['刷新场景后重试。'], 'STATIC_LOCAL');
  }
  if (found.kind === 'ambiguous') {
    throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `实例 ID ${instanceId} 重复，空间计划必须稳定返回 AMBIGUOUS。`, ['先消除重复 ID 或更换可信快照。'], 'STATIC_LOCAL');
  }
  return found.matches[0]!;
}

function groupMap(snapshot: SceneSnapshot): Map<string, SceneGroup[]> {
  const values = new Map<string, SceneGroup[]>();
  for (const group of snapshot.groups) values.set(group.groupId, [...(values.get(group.groupId) ?? []), group]);
  return values;
}

function uniqueGroup(groups: ReadonlyMap<string, SceneGroup[]>, groupId: string): SceneGroup | null {
  const matches = groups.get(groupId) ?? [];
  if (matches.length > 1) {
    throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `编组 ID ${groupId} 重复，空间计划不能任取一条。`, ['先消除重复编组或更换可信快照。'], 'STATIC_LOCAL');
  }
  return matches[0] ?? null;
}

function groupInstances(
  snapshot: SceneSnapshot,
  groups: ReadonlyMap<string, SceneGroup[]>,
  group: SceneGroup,
): SceneInstance[] {
  const instanceIds = new Set<string>();
  const visitedGroups = new Set<string>();
  const pending = [group.groupId];
  while (pending.length > 0) {
    const groupId = pending.pop()!;
    if (visitedGroups.has(groupId)) continue;
    visitedGroups.add(groupId);
    const current = uniqueGroup(groups, groupId);
    if (current === null) {
      throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `嵌套编组 ${groupId} 不存在。`, ['复核 nestedGroupIds 关系。'], 'STATIC_LOCAL');
    }
    for (const memberId of current.memberIds) instanceIds.add(memberId);
    for (const instance of snapshot.instances) {
      if (instance.ownerId === current.groupId && instance.instanceId !== current.groupId) instanceIds.add(instance.instanceId);
    }
    for (let index = current.nestedGroupIds.length - 1; index >= 0; index -= 1) {
      pending.push(current.nestedGroupIds[index]!);
    }
  }
  const instances = [...instanceIds].map((id) => requireUniqueInstance(snapshot, id));
  if (instances.length === 0) {
    throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `编组 ${group.groupId} 没有可验证成员。`, ['复核编组成员关系。'], 'STATIC_LOCAL');
  }
  return instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en'));
}

/**
 * 返回编组全部叶子元件（包含任意层级子编组）。重复 ID、缺失成员和循环关系
 * 都沿用空间计划的严格证据门禁，禁止静默漏掉玩家拼装物的一部分。
 */
export function resolveSceneGroupMemberIds(snapshot: SceneSnapshot, groupId: string): string[] {
  const groups = groupMap(snapshot);
  const group = uniqueGroup(groups, groupId);
  if (group === null) {
    throw new ProductError('NOT_FOUND', `场景中没有编组 ${groupId}。`, ['刷新场景后重试。'], 'STATIC_LOCAL');
  }
  return groupInstances(snapshot, groups, group).map((instance) => instance.instanceId);
}

function resolveUnits(snapshot: SceneSnapshot, targetIds: readonly string[], preserveGroups: boolean): PlacementUnit[] {
  if (targetIds.length === 0) {
    throw new ProductError('VALIDATION_FAILED', '空间计划至少需要一个目标。', ['提供实例或编组 ID。'], 'STATIC_LOCAL');
  }
  const groups = groupMap(snapshot);
  const units = new Map<string, PlacementUnit>();
  for (const targetId of targetIds) {
    const directGroup = uniqueGroup(groups, targetId);
    let values: SceneInstance[];
    let expanded = false;
    if (directGroup !== null) {
      values = groupInstances(snapshot, groups, directGroup);
      expanded = true;
    } else {
      const target = requireUniqueInstance(snapshot, targetId);
      const ownerGroup = preserveGroups && target.ownerId !== null ? uniqueGroup(groups, target.ownerId) : null;
      if (ownerGroup !== null && ownerGroup.memberIds.includes(target.instanceId)) {
        values = groupInstances(snapshot, groups, ownerGroup);
        expanded = values.length > 1;
      } else {
        values = [target];
      }
    }
    const key = values.map((instance) => instance.instanceId).sort((left, right) => left.localeCompare(right, 'en')).join('\0');
    if (!units.has(key)) units.set(key, { key, instances: values, expanded });
  }
  const resolved = [...units.values()];
  const ownerByInstance = new Map<string, string>();
  for (const unit of resolved) for (const instance of unit.instances) {
    const owner = ownerByInstance.get(instance.instanceId);
    if (owner !== undefined && owner !== unit.key) {
      throw new ProductError(
        'SCENE_EVIDENCE_INSUFFICIENT',
        `目标单元在实例 ${instance.instanceId} 处重叠，不能生成多条冲突变换。`,
        ['移除重叠目标，或改为选择共同上级编组。'],
        'STATIC_LOCAL',
      );
    }
    ownerByInstance.set(instance.instanceId, unit.key);
  }
  return resolved;
}

function transformOf(instance: SceneInstance): Transform | null {
  if (instance.transform.state !== 'observed' || !trusted(instance.transform.evidence)) return null;
  const value = instance.transform.value;
  return Object.values(value).every((vector) => (
    typeof vector === 'object'
    && vector !== null
    && Object.values(vector).every((component) => typeof component === 'number' && finite(component))
  )) ? value : null;
}

function boundsOf(instance: SceneInstance): AabbGeometry | null {
  if (
    instance.bounds.state !== 'observed'
    || !trusted(instance.bounds.evidence)
    || !trusted(instance.bounds.value.evidence)
  ) return null;
  return instance.bounds.value;
}

function unitPosition(unit: PlacementUnit, axis: SceneAxis): number | null {
  const values = unit.instances.map(transformOf);
  if (values.some((value) => value === null)) return null;
  return values.reduce((total, value) => total + value!.position[axis], 0) / values.length;
}

function unitBounds(unit: PlacementUnit): AabbGeometry | null {
  const values = unit.instances.map(boundsOf);
  if (values.some((value) => value === null)) return null;
  return aabbUnion(values as AabbGeometry[]);
}

function unitCoordinate(unit: PlacementUnit, axis: SceneAxis, anchor: 'position' | 'min' | 'center' | 'max'): number | null {
  if (anchor === 'position') return unitPosition(unit, axis);
  const bounds = unitBounds(unit);
  if (bounds === null) return null;
  if (anchor === 'min') return bounds.min[axis];
  if (anchor === 'max') return bounds.max[axis];
  return (bounds.min[axis] + bounds.max[axis]) / 2;
}

function evidenceFor(units: readonly PlacementUnit[], includeBounds: boolean): FieldEvidence[] {
  const byKey = new Map<string, FieldEvidence>();
  for (const instance of units.flatMap((unit) => unit.instances)) {
    if (instance.transform.state === 'observed') byKey.set(stableJson(instance.transform.evidence), instance.transform.evidence);
    if (includeBounds && instance.bounds.state === 'observed') {
      byKey.set(stableJson(instance.bounds.evidence), instance.bounds.evidence);
      byKey.set(stableJson(instance.bounds.value.evidence), instance.bounds.value.evidence);
    }
  }
  return [...byKey.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'));
}

function emptyTransform(): Transform {
  return { position: { ...ZERO_VECTOR }, rotation: { ...ZERO_VECTOR }, scale: { ...ZERO_VECTOR } };
}

function makeChange(instance: SceneInstance, delta: Partial<Record<keyof Transform, Partial<Vector3>>>): SceneTransformChange {
  const current = transformOf(instance);
  if (current === null) throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `实例 ${instance.instanceId} 缺少可信 transform。`, ['刷新场景或完成 transform 校准。'], 'STATIC_LOCAL');
  const next = copyTransform(current);
  const normalizedDelta = emptyTransform();
  const mask: TransformComponent[] = [];
  for (const field of ['position', 'rotation', 'scale'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = delta[field]?.[axis];
      if (value === undefined) continue;
      if (!finite(value)) throw new ProductError('VALIDATION_FAILED', '空间计划分量必须是有限数值。', ['修正布局参数。'], 'STATIC_LOCAL');
      next[field][axis] += value;
      normalizedDelta[field][axis] = value;
      mask.push(`${field}.${axis}`);
    }
  }
  return { instanceId: instance.instanceId, oldTransform: copyTransform(current), newTransform: next, delta: normalizedDelta, mask };
}

function blockedPlan(
  snapshot: SceneSnapshot,
  request: ScenePlacementRequest,
  units: readonly PlacementUnit[],
  referenceIds: string[],
  reasonCode: 'BOUNDS_EVIDENCE_REQUIRED' | 'TRANSFORM_EVIDENCE_REQUIRED',
  evidenceUnits: readonly PlacementUnit[] = units,
): ScenePlacementPlan {
  const affected = units.flatMap((unit) => unit.instances.map((instance) => instance.instanceId)).sort((left, right) => left.localeCompare(right, 'en'));
  const risks: ScenePlacementRisk[] = [{
    code: reasonCode === 'BOUNDS_EVIDENCE_REQUIRED' ? 'BOUNDS_UNAVAILABLE' : 'NO_EFFECT',
    instanceIds: affected,
    message: reasonCode === 'BOUNDS_EVIDENCE_REQUIRED' ? '缺少可信边界，不能猜测尺寸或边缘。' : '缺少可信变换，不能生成坐标计划。',
  }];
  return finalize(snapshot, request, affected, referenceIds, 'evidence-insufficient', reasonCode, [], evidenceFor(evidenceUnits, true), risks);
}

function finalize(
  snapshot: SceneSnapshot,
  request: ScenePlacementRequest,
  affectedInstanceIds: string[],
  referenceIds: string[],
  status: ScenePlacementPlan['status'],
  reasonCode: ScenePlacementPlan['reasonCode'],
  changes: SceneTransformChange[],
  evidence: FieldEvidence[],
  risks: ScenePlacementRisk[],
): ScenePlacementPlan {
  const orderedChanges = [...changes].sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en'));
  const rollback = orderedChanges.map((change) => ({
    instanceId: change.instanceId,
    oldTransform: copyTransform(change.newTransform),
    newTransform: copyTransform(change.oldTransform),
    delta: {
      position: { x: -change.delta.position.x, y: -change.delta.position.y, z: -change.delta.position.z },
      rotation: { x: -change.delta.rotation.x, y: -change.delta.rotation.y, z: -change.delta.rotation.z },
      scale: { x: -change.delta.scale.x, y: -change.delta.scale.y, z: -change.delta.scale.z },
    },
    mask: [...change.mask],
  }));
  const content = {
    schemaVersion: 1 as const,
    snapshotId: snapshot.snapshotId,
    bindingId: snapshot.bindingId,
    operation: request.kind,
    requestedTargetIds: [...request.targetIds],
    affectedInstanceIds: [...new Set(affectedInstanceIds)].sort((left, right) => left.localeCompare(right, 'en')),
    referenceIds: [...referenceIds].sort((left, right) => left.localeCompare(right, 'en')),
    status,
    reasonCode,
    execute: false as const,
    changes: orderedChanges,
    rollback: { changes: rollback },
    evidence,
    risks,
  };
  return { ...content, planId: sha256Hex(stableJson(content)) };
}

function groupRisks(units: readonly PlacementUnit[]): ScenePlacementRisk[] {
  return units.filter((unit) => unit.expanded).map((unit) => ({
    code: 'GROUP_EXPANDED' as const,
    instanceIds: unit.instances.map((instance) => instance.instanceId),
    message: '目标属于编组；计划已展开全部成员并应用同一位置偏移，以保持组内相对结构。',
  }));
}

function translateUnits(units: readonly PlacementUnit[], deltas: readonly Partial<Vector3>[]): SceneTransformChange[] {
  return units.flatMap((unit, index) => unit.instances.map((instance) => makeChange(instance, { position: deltas[index]! })));
}

export function createScenePlacementPlan(snapshot: SceneSnapshot, request: ScenePlacementRequest): ScenePlacementPlan {
  const preserveGroups = request.preserveGroupRelative !== false;
  const units = resolveUnits(snapshot, request.targetIds, preserveGroups);
  const allTransforms = units.flatMap((unit) => unit.instances).every((instance) => transformOf(instance) !== null);
  if (!allTransforms) return blockedPlan(snapshot, request, units, [], 'TRANSFORM_EVIDENCE_REQUIRED');
  const risks = groupRisks(units);
  let referenceIds: string[] = [];
  let changes: SceneTransformChange[];
  let includeBounds = false;
  let planEvidenceUnits: readonly PlacementUnit[] = units;

  if (request.kind === 'floor-align') {
    const references = resolveUnits(snapshot, [request.supportId], preserveGroups);
    planEvidenceUnits = [...units, ...references];
    referenceIds = references.flatMap((unit) => unit.instances.map((instance) => instance.instanceId));
    includeBounds = true;
    const supportBounds = unitBounds(references[0]!);
    const targetBounds = units.map(unitBounds);
    if (supportBounds === null || targetBounds.some((value) => value === null)) {
      return blockedPlan(snapshot, request, units, referenceIds, 'BOUNDS_EVIDENCE_REQUIRED', planEvidenceUnits);
    }
    changes = translateUnits(units, targetBounds.map((bounds) => ({ z: supportBounds.max.z - bounds!.min.z })));
  } else if (request.kind === 'batch-offset') {
    const hasAny = ['position', 'rotation', 'scale'].some((field) => Object.keys(request.components[field as keyof typeof request.components] ?? {}).length > 0);
    if (!hasAny) throw new ProductError('VALIDATION_FAILED', 'batch-offset 至少需要一个变换分量。', ['提供 position/rotation/scale 偏移。'], 'STATIC_LOCAL');
    changes = units.flatMap((unit) => unit.instances.map((instance) => makeChange(instance, request.components)));
  } else if (request.kind === 'axis-align') {
    const references = resolveUnits(snapshot, [request.referenceId], preserveGroups);
    planEvidenceUnits = [...units, ...references];
    referenceIds = references.flatMap((unit) => unit.instances.map((instance) => instance.instanceId));
    includeBounds = request.anchor !== 'position';
    const reference = unitCoordinate(references[0]!, request.axis, request.anchor);
    const coordinates = units.map((unit) => unitCoordinate(unit, request.axis, request.anchor));
    if (reference === null || coordinates.some((value) => value === null)) {
      return blockedPlan(snapshot, request, units, referenceIds, includeBounds ? 'BOUNDS_EVIDENCE_REQUIRED' : 'TRANSFORM_EVIDENCE_REQUIRED', planEvidenceUnits);
    }
    changes = translateUnits(units, coordinates.map((value) => ({ [request.axis]: reference - value! })));
  } else if (request.kind === 'equal-spacing') {
    if (units.length < 3) throw new ProductError('VALIDATION_FAILED', '等间距至少需要三个目标单元。', ['增加目标或改用 rows/columns。'], 'STATIC_LOCAL');
    includeBounds = request.mode === 'bounds-gap';
    if (request.mode === 'position') {
      const positions = units.map((unit) => unitPosition(unit, request.axis));
      if (positions.some((value) => value === null)) return blockedPlan(snapshot, request, units, [], 'TRANSFORM_EVIDENCE_REQUIRED');
      const sorted = units.map((unit, index) => ({ unit, index, value: positions[index]! })).sort((left, right) => left.value - right.value || left.unit.key.localeCompare(right.unit.key, 'en'));
      const step = (sorted.at(-1)!.value - sorted[0]!.value) / (sorted.length - 1);
      const deltas = units.map((): Partial<Vector3> => ({}));
      sorted.forEach((item, index) => { deltas[item.index] = { [request.axis]: sorted[0]!.value + step * index - item.value }; });
      changes = translateUnits(units, deltas);
    } else {
      const bounds = units.map(unitBounds);
      if (bounds.some((value) => value === null)) return blockedPlan(snapshot, request, units, [], 'BOUNDS_EVIDENCE_REQUIRED');
      const sorted = units.map((unit, index) => ({ unit, index, bounds: bounds[index]! })).sort((left, right) => left.bounds.min[request.axis] - right.bounds.min[request.axis] || left.unit.key.localeCompare(right.unit.key, 'en'));
      const spanMin = sorted[0]!.bounds.min[request.axis];
      const spanMax = sorted.at(-1)!.bounds.max[request.axis];
      const size = sorted.reduce((total, item) => total + item.bounds.max[request.axis] - item.bounds.min[request.axis], 0);
      const gap = (spanMax - spanMin - size) / (sorted.length - 1);
      let cursor = spanMin;
      const deltas = units.map((): Partial<Vector3> => ({}));
      for (const item of sorted) {
        deltas[item.index] = { [request.axis]: cursor - item.bounds.min[request.axis] };
        cursor += item.bounds.max[request.axis] - item.bounds.min[request.axis] + gap;
      }
      changes = translateUnits(units, deltas);
    }
  } else if (request.kind === 'grid') {
    if (request.rowAxis === request.columnAxis) throw new ProductError('VALIDATION_FAILED', '网格行轴与列轴不能相同。', ['选择两个不同坐标轴。'], 'STATIC_LOCAL');
    if (!Number.isInteger(request.columns) || request.columns < 1 || request.columns > 1000 || !finite(request.rowSpacing) || !finite(request.columnSpacing)) {
      throw new ProductError('VALIDATION_FAILED', '网格列数与间距参数无效。', ['使用 1..1000 列和有限间距。'], 'STATIC_LOCAL');
    }
    const rowStart = Math.min(...units.map((unit) => unitPosition(unit, request.rowAxis)!));
    const columnStart = Math.min(...units.map((unit) => unitPosition(unit, request.columnAxis)!));
    const deltas = units.map((unit, index) => ({
      [request.rowAxis]: rowStart + Math.floor(index / request.columns) * request.rowSpacing - unitPosition(unit, request.rowAxis)!,
      [request.columnAxis]: columnStart + (index % request.columns) * request.columnSpacing - unitPosition(unit, request.columnAxis)!,
    }));
    changes = translateUnits(units, deltas);
  } else {
    if (!finite(request.spacing)) throw new ProductError('VALIDATION_FAILED', '行列间距必须是有限值。', ['修正 spacing。'], 'STATIC_LOCAL');
    const start = Math.min(...units.map((unit) => unitPosition(unit, request.axis)!));
    changes = translateUnits(units, units.map((unit, index) => ({
      [request.axis]: start + index * request.spacing - unitPosition(unit, request.axis)!,
    })));
  }

  const affected = changes.map((change) => change.instanceId);
  if (changes.every((change) => change.mask.every((component) => {
    const [field, axis] = component.split('.') as [keyof Transform, SceneAxis];
    return change.delta[field][axis] === 0;
  }))) risks.push({ code: 'NO_EFFECT', instanceIds: affected, message: '所有目标已经位于计划位置。' });
  return finalize(snapshot, request, affected, referenceIds, 'ready', 'PREVIEW_ONLY', changes, evidenceFor(planEvidenceUnits, includeBounds), risks);
}
