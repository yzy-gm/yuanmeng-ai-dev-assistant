import { ProductError } from '../errors.js';
import type { AxisAlignedBounds, FieldEvidence, SceneInstance, Vector3 } from './types.js';

export interface AabbGeometry { min: Vector3; max: Vector3 }
export interface SpatialMover { instanceId: string; position: Vector3; bounds: AxisAlignedBounds }
export interface FloorAlignmentInput { support: AxisAlignedBounds & { instanceId: string }; movers: SpatialMover[] }
export interface SpatialMove { instanceId: string; from: Vector3; to: Vector3 }
export interface FloorAlignmentRisk { code: 'MOVER_BOUNDS_OVERLAP'; instanceIds: [string, string] }
export interface FloorAlignmentPlan {
  executable: boolean;
  reason: string | null;
  deltaZ: number | null;
  moves: SpatialMove[];
  rollback: { moves: SpatialMove[] };
  risks: FloorAlignmentRisk[];
  evidence: FieldEvidence[];
}

export interface SceneNearOptions { radius: number; limit: number }
export interface SceneNearMatch {
  instanceId: string;
  distance: number;
  method: 'bounds-bounds' | 'bounds-point' | 'point-bounds' | 'point-point';
  overlap: boolean;
}
export interface SceneNearResult { matches: SceneNearMatch[]; insufficientInstanceIds: string[] }

function finiteVector(value: Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function validAabb(bounds: AabbGeometry): boolean {
  return finiteVector(bounds.min)
    && finiteVector(bounds.max)
    && bounds.min.x <= bounds.max.x
    && bounds.min.y <= bounds.max.y
    && bounds.min.z <= bounds.max.z;
}

function requireAabb(bounds: AabbGeometry): void {
  if (!validAabb(bounds)) {
    throw new ProductError('VALIDATION_FAILED', 'AABB 必须包含有限且 min 不大于 max 的坐标。', ['重新读取可信场景边界。'], 'STATIC_LOCAL');
  }
}

export function aabbCenter(bounds: AabbGeometry): Vector3 {
  requireAabb(bounds);
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}

export function aabbUnion(bounds: readonly AabbGeometry[]): AabbGeometry {
  if (bounds.length === 0) {
    throw new ProductError('VALIDATION_FAILED', 'AABB union 至少需要一个边界。', ['提供非空边界集合。'], 'STATIC_LOCAL');
  }
  for (const item of bounds) requireAabb(item);
  return {
    min: {
      x: Math.min(...bounds.map((item) => item.min.x)),
      y: Math.min(...bounds.map((item) => item.min.y)),
      z: Math.min(...bounds.map((item) => item.min.z)),
    },
    max: {
      x: Math.max(...bounds.map((item) => item.max.x)),
      y: Math.max(...bounds.map((item) => item.max.y)),
      z: Math.max(...bounds.map((item) => item.max.z)),
    },
  };
}

export function pointToAabbDistance(point: Vector3, bounds: AabbGeometry): number {
  requireAabb(bounds);
  if (!finiteVector(point)) {
    throw new ProductError('VALIDATION_FAILED', '空间点必须是有限坐标。', ['重新读取可信场景位置。'], 'STATIC_LOCAL');
  }
  const dx = Math.max(bounds.min.x - point.x, 0, point.x - bounds.max.x);
  const dy = Math.max(bounds.min.y - point.y, 0, point.y - bounds.max.y);
  const dz = Math.max(bounds.min.z - point.z, 0, point.z - bounds.max.z);
  return Math.hypot(dx, dy, dz);
}

export function aabbOverlap(left: AabbGeometry, right: AabbGeometry): boolean {
  requireAabb(left);
  requireAabb(right);
  return left.min.x <= right.max.x && left.max.x >= right.min.x
    && left.min.y <= right.max.y && left.max.y >= right.min.y
    && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

export function aabbSpacing(left: AabbGeometry, right: AabbGeometry): number {
  requireAabb(left);
  requireAabb(right);
  const dx = Math.max(left.min.x - right.max.x, right.min.x - left.max.x, 0);
  const dy = Math.max(left.min.y - right.max.y, right.min.y - left.max.y, 0);
  const dz = Math.max(left.min.z - right.max.z, right.min.z - left.max.z, 0);
  return Math.hypot(dx, dy, dz);
}

function trusted(evidence: FieldEvidence): boolean {
  return evidence.state === 'confirmed-calibration' || evidence.state === 'observed-repeatable';
}

type SpatialCapability = { kind: 'bounds'; bounds: AxisAlignedBounds } | { kind: 'point'; point: Vector3 };

function capability(instance: SceneInstance): SpatialCapability | null {
  if (
    instance.bounds.state === 'observed'
    && trusted(instance.bounds.evidence)
    && trusted(instance.bounds.value.evidence)
    && validAabb(instance.bounds.value)
  ) return { kind: 'bounds', bounds: instance.bounds.value };
  if (
    instance.transform.state === 'observed'
    && trusted(instance.transform.evidence)
    && finiteVector(instance.transform.value.position)
  ) return { kind: 'point', point: instance.transform.value.position };
  return null;
}

function pointDistance(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function spatialDistance(left: SpatialCapability, right: SpatialCapability): Omit<SceneNearMatch, 'instanceId'> {
  if (left.kind === 'bounds' && right.kind === 'bounds') {
    const distance = aabbSpacing(left.bounds, right.bounds);
    return { distance, method: 'bounds-bounds', overlap: aabbOverlap(left.bounds, right.bounds) };
  }
  if (left.kind === 'bounds' && right.kind === 'point') {
    const distance = pointToAabbDistance(right.point, left.bounds);
    return { distance, method: 'bounds-point', overlap: distance === 0 };
  }
  if (left.kind === 'point' && right.kind === 'bounds') {
    const distance = pointToAabbDistance(left.point, right.bounds);
    return { distance, method: 'point-bounds', overlap: distance === 0 };
  }
  if (left.kind === 'point' && right.kind === 'point') {
    const distance = pointDistance(left.point, right.point);
    return { distance, method: 'point-point', overlap: distance === 0 };
  }
  throw new ProductError('INTERNAL_ERROR', '未处理的空间能力组合。', ['报告当前场景快照与适配器版本。'], 'STATIC_LOCAL');
}

export function findNearbySceneInstances(
  target: SceneInstance,
  candidates: readonly SceneInstance[],
  options: SceneNearOptions,
): SceneNearResult {
  if (!Number.isFinite(options.radius) || options.radius < 0 || options.radius > 1_000_000_000) {
    throw new ProductError('VALIDATION_FAILED', 'scene-near radius 必须是有限非负数。', ['使用有界查询半径。'], 'STATIC_LOCAL');
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
    throw new ProductError('VALIDATION_FAILED', 'scene-near limit 必须是 1 到 1000 的整数。', ['使用有界结果数量。'], 'STATIC_LOCAL');
  }
  const targetCapability = capability(target);
  if (targetCapability === null) {
    throw new ProductError(
      'SCENE_EVIDENCE_INSUFFICIENT',
      '目标实例既没有可信 AABB，也没有可信位置，不能执行空间邻近查询。',
      ['先刷新场景或运行只读测量探针，绝不要用零坐标代替。'],
      'STATIC_LOCAL',
    );
  }
  const matches: SceneNearMatch[] = [];
  const insufficientInstanceIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.instanceId === target.instanceId) continue;
    const candidateCapability = capability(candidate);
    if (candidateCapability === null) {
      insufficientInstanceIds.push(candidate.instanceId);
      continue;
    }
    const distance = spatialDistance(targetCapability, candidateCapability);
    if (distance.distance <= options.radius) matches.push({ instanceId: candidate.instanceId, ...distance });
  }
  matches.sort((left, right) => left.distance - right.distance || left.instanceId.localeCompare(right.instanceId, 'en'));
  insufficientInstanceIds.sort((left, right) => left.localeCompare(right, 'en'));
  return { matches: matches.slice(0, options.limit), insufficientInstanceIds };
}

function strictVolumeOverlap(left: AabbGeometry, right: AabbGeometry): boolean {
  return left.min.x < right.max.x && left.max.x > right.min.x
    && left.min.y < right.max.y && left.max.y > right.min.y
    && left.min.z < right.max.z && left.max.z > right.min.z;
}

export function createFloorAlignmentPlan(input: FloorAlignmentInput): FloorAlignmentPlan {
  if (input.movers.length === 0) {
    return { executable: false, reason: '没有待移动实例。', deltaZ: null, moves: [], rollback: { moves: [] }, risks: [], evidence: [input.support.evidence] };
  }
  const supportTop = input.support.max.z;
  const moverBottom = Math.min(...input.movers.map((mover) => mover.bounds.min.z));
  if (!Number.isFinite(supportTop) || !Number.isFinite(moverBottom)) {
    return { executable: false, reason: '空间边界包含非有限值。', deltaZ: null, moves: [], rollback: { moves: [] }, risks: [], evidence: [input.support.evidence] };
  }
  const deltaZ = supportTop - moverBottom;
  const moves = input.movers.map((mover) => ({
    instanceId: mover.instanceId,
    from: { ...mover.position },
    to: { x: mover.position.x, y: mover.position.y, z: mover.position.z + deltaZ },
  }));
  const risks: FloorAlignmentRisk[] = [];
  for (let leftIndex = 0; leftIndex < input.movers.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < input.movers.length; rightIndex += 1) {
      const left = input.movers[leftIndex]!;
      const right = input.movers[rightIndex]!;
      if (!strictVolumeOverlap(left.bounds, right.bounds)) continue;
      risks.push({ code: 'MOVER_BOUNDS_OVERLAP', instanceIds: [left.instanceId, right.instanceId].sort() as [string, string] });
    }
  }
  risks.sort((left, right) => left.instanceIds.join('\0').localeCompare(right.instanceIds.join('\0'), 'en'));
  return {
    executable: true,
    reason: null,
    deltaZ,
    moves,
    rollback: {
      moves: moves.map((move) => ({ instanceId: move.instanceId, from: { ...move.to }, to: { ...move.from } })),
    },
    risks,
    evidence: [input.support.evidence, ...input.movers.map((mover) => mover.bounds.evidence)],
  };
}
