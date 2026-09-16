import { ProductError } from '../errors.js';
import { buildSceneRelations } from './hierarchy.js';
import { aabbCenter, aabbUnion, type AabbGeometry } from './spatial.js';
import type { AxisAlignedBounds, FieldEvidence, SceneInstance, SceneSnapshot, Vector3 } from './types.js';

export type SceneGeometryRequest =
  | { operation: 'bounds'; targetId: string }
  | { operation: 'contact'; targetId: string; supportId: string; tolerance?: number }
  | { operation: 'overlaps'; targetIds: string[] };

export interface SceneGeometryTarget {
  targetId: string;
  kind: 'instance' | 'group';
  memberInstanceIds: string[];
  bounds: AabbGeometry;
  center: Vector3;
  size: Vector3;
  evidence: FieldEvidence[];
}

export interface SceneGeometryOverlap {
  leftTargetId: string;
  leftInstanceId: string;
  rightTargetId: string;
  rightInstanceId: string;
}

export type SceneGeometryResult =
  | { operation: 'bounds'; target: SceneGeometryTarget }
  | {
    operation: 'contact';
    target: SceneGeometryTarget;
    support: SceneGeometryTarget;
    contact: {
      status: 'aligned' | 'floating' | 'penetrating' | 'no-horizontal-overlap';
      deltaZ: number;
      tolerance: number;
      horizontalOverlap: boolean;
      targetBottomZ: number;
      supportTopZ: number;
    };
  }
  | { operation: 'overlaps'; targets: SceneGeometryTarget[]; overlaps: SceneGeometryOverlap[] };

function trusted(evidence: FieldEvidence): boolean {
  return evidence.state === 'confirmed-calibration' || evidence.state === 'observed-repeatable';
}

function requireTrustedBounds(instance: SceneInstance): AxisAlignedBounds {
  if (
    instance.bounds.state !== 'observed'
    || !trusted(instance.bounds.evidence)
    || !trusted(instance.bounds.value.evidence)
  ) {
    throw new ProductError(
      'SCENE_EVIDENCE_INSUFFICIENT',
      `实例 ${instance.instanceId} 缺少可信的已观察包围盒，不能生成场景几何结论。`,
      ['刷新场景快照或运行只读测量探针；不要用位置点或零坐标代替边界。'],
      'STATIC_LOCAL',
    );
  }
  return instance.bounds.value;
}

function resolveTarget(snapshot: SceneSnapshot, targetId: string): { target: SceneGeometryTarget; instances: SceneInstance[] } {
  const instanceMatches = snapshot.instances.filter((item) => item.instanceId === targetId);
  const groupMatches = snapshot.groups.filter((item) => item.groupId === targetId);
  if (instanceMatches.length + groupMatches.length === 0) {
    throw new ProductError('NOT_FOUND', `场景中不存在实例或编组 ${targetId}。`, ['刷新当前场景快照后重试。'], 'STATIC_LOCAL');
  }
  if (instanceMatches.length + groupMatches.length !== 1) {
    throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `ID ${targetId} 对应多条实例或编组记录。`, ['消除重复或使用唯一 ID。'], 'STATIC_LOCAL');
  }

  let instances: SceneInstance[];
  let kind: SceneGeometryTarget['kind'];
  if (instanceMatches.length === 1) {
    instances = [instanceMatches[0]!];
    kind = 'instance';
  } else {
    kind = 'group';
    const relations = buildSceneRelations(snapshot);
    const uniqueInstances = new Map<string, SceneInstance>();
    const duplicateInstanceIds = new Set<string>();
    for (const instance of snapshot.instances) {
      if (uniqueInstances.has(instance.instanceId)) duplicateInstanceIds.add(instance.instanceId);
      else uniqueInstances.set(instance.instanceId, instance);
    }
    for (const id of duplicateInstanceIds) uniqueInstances.delete(id);
    const uniqueGroups = new Map<string, SceneSnapshot['groups'][number]>();
    const duplicateGroupIds = new Set<string>();
    for (const group of snapshot.groups) {
      if (uniqueGroups.has(group.groupId)) duplicateGroupIds.add(group.groupId);
      else uniqueGroups.set(group.groupId, group);
    }
    for (const id of duplicateGroupIds) uniqueGroups.delete(id);
    const memberIds = new Set<string>();
    const visitedGroups = new Set<string>();
    const stack = [targetId];
    while (stack.length > 0) {
      const groupId = stack.pop()!;
      if (visitedGroups.has(groupId)) continue;
      visitedGroups.add(groupId);
      const group = uniqueGroups.get(groupId);
      if (group === undefined) continue;
      for (const memberId of group.memberIds) memberIds.add(memberId);
      for (const nestedGroupId of group.nestedGroupIds) stack.push(nestedGroupId);
    }
    for (const descendantId of relations.descendantsOf(targetId)) if (uniqueInstances.has(descendantId)) memberIds.add(descendantId);
    const missing = [...memberIds].filter((id) => !uniqueInstances.has(id)).sort((a, b) => a.localeCompare(b, 'en'));
    if (missing.length > 0) {
      throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `编组 ${targetId} 含缺失或重复实例：${missing.join(',')}`, ['刷新场景并检查编组成员。'], 'STATIC_LOCAL');
    }
    instances = [...memberIds].sort((a, b) => a.localeCompare(b, 'en')).map((id) => uniqueInstances.get(id)!);
    if (instances.length === 0) {
      throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `编组 ${targetId} 没有可确认的成员实例。`, ['检查编组关系与场景快照。'], 'STATIC_LOCAL');
    }
  }

  const measured = instances.map((instance) => ({ instance, bounds: requireTrustedBounds(instance) }));
  const union = aabbUnion(measured.map((item) => item.bounds));
  const center = aabbCenter(union);
  const size = {
    x: union.max.x - union.min.x,
    y: union.max.y - union.min.y,
    z: union.max.z - union.min.z,
  };
  return {
    instances,
    target: {
      targetId,
      kind,
      memberInstanceIds: measured.map((item) => item.instance.instanceId),
      bounds: union,
      center,
      size,
      evidence: measured.flatMap((item) => [item.instance.bounds.state === 'observed' ? item.instance.bounds.evidence : item.instance.evidence, item.bounds.evidence]),
    },
  };
}

function strictVolumeOverlap(left: AabbGeometry, right: AabbGeometry): boolean {
  return left.min.x < right.max.x && left.max.x > right.min.x
    && left.min.y < right.max.y && left.max.y > right.min.y
    && left.min.z < right.max.z && left.max.z > right.min.z;
}

function horizontalOverlap(left: AabbGeometry, right: AabbGeometry): boolean {
  return left.min.x < right.max.x && left.max.x > right.min.x
    && left.min.y < right.max.y && left.max.y > right.min.y;
}

export function querySceneGeometry(snapshot: SceneSnapshot, request: SceneGeometryRequest): SceneGeometryResult {
  if (request.operation === 'bounds') return { operation: request.operation, target: resolveTarget(snapshot, request.targetId).target };
  if (request.operation === 'contact') {
    const tolerance = request.tolerance ?? 0.1;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1_000_000) {
      throw new ProductError('VALIDATION_FAILED', '贴合容差必须是 0 到 1000000 的有限数值。', ['使用与地图单位匹配的小容差。'], 'STATIC_LOCAL');
    }
    const target = resolveTarget(snapshot, request.targetId).target;
    const support = resolveTarget(snapshot, request.supportId).target;
    const overlapsXY = horizontalOverlap(target.bounds, support.bounds);
    const deltaZ = target.bounds.min.z - support.bounds.max.z;
    const status = !overlapsXY
      ? 'no-horizontal-overlap'
      : Math.abs(deltaZ) <= tolerance ? 'aligned' : deltaZ > 0 ? 'floating' : 'penetrating';
    return {
      operation: request.operation,
      target,
      support,
      contact: {
        status,
        deltaZ,
        tolerance,
        horizontalOverlap: overlapsXY,
        targetBottomZ: target.bounds.min.z,
        supportTopZ: support.bounds.max.z,
      },
    };
  }
  const targetIds = [...new Set(request.targetIds)];
  if (targetIds.length < 2 || targetIds.length > 100) {
    throw new ProductError('VALIDATION_FAILED', '穿插检查必须提供 2 到 100 个不同目标。', ['缩小检查范围。'], 'STATIC_LOCAL');
  }
  const resolved = targetIds.map((targetId) => resolveTarget(snapshot, targetId));
  const overlaps: SceneGeometryOverlap[] = [];
  for (let leftIndex = 0; leftIndex < resolved.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < resolved.length; rightIndex += 1) {
      const left = resolved[leftIndex]!;
      const right = resolved[rightIndex]!;
      for (const leftInstance of left.instances) {
        for (const rightInstance of right.instances) {
          if (leftInstance.instanceId === rightInstance.instanceId) continue;
          if (!strictVolumeOverlap(requireTrustedBounds(leftInstance), requireTrustedBounds(rightInstance))) continue;
          overlaps.push({
            leftTargetId: left.target.targetId,
            leftInstanceId: leftInstance.instanceId,
            rightTargetId: right.target.targetId,
            rightInstanceId: rightInstance.instanceId,
          });
        }
      }
    }
  }
  overlaps.sort((left, right) => [left.leftTargetId, left.leftInstanceId, left.rightTargetId, left.rightInstanceId].join('\0')
    .localeCompare([right.leftTargetId, right.leftInstanceId, right.rightTargetId, right.rightInstanceId].join('\0'), 'en'));
  return { operation: request.operation, targets: resolved.map((item) => item.target), overlaps };
}
