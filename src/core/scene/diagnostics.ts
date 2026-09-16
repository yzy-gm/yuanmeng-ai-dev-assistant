import type { RegistryRecord } from '../model.js';
import { ProductError } from '../errors.js';
import { buildSceneRelations } from './hierarchy.js';
import type { FeatureState, FieldEvidence, SceneInstance, SceneSnapshot } from './types.js';

export type SceneInspectableField = 'transform' | 'customProperties' | 'signals' | 'resources' | 'bounds';
export type SceneFieldReasonCode = 'FIELD_OBSERVED' | 'EVIDENCE_INSUFFICIENT' | 'FIELD_UNSUPPORTED' | 'FIELD_ABSENT';

export interface SceneFieldInspection {
  field: SceneInspectableField;
  state: FeatureState<unknown>['state'];
  reasonCode: SceneFieldReasonCode;
  evidence: FieldEvidence | null;
  reason: string;
  nextAction: string | null;
  wirePaths?: string[];
  value?: unknown;
}

export interface SceneAuditFinding {
  severity: 'error' | 'warning' | 'info';
  reasonCode: string;
  message: string;
  instanceId: string | null;
  field: SceneInspectableField | null;
  nextAction: string | null;
}

export interface SceneAuditResult {
  snapshotId: string;
  summary: {
    errors: number;
    warnings: number;
    info: number;
    duplicateInstanceIds: number;
    snapshotIssues: number;
    registrySuspected: number;
  };
  /** 全量问题数；即使 findings 为紧凑示例，也不会丢失真实数量。 */
  totalFindingCount: number;
  /** findings 是否只保留了每组示例。 */
  truncated: boolean;
  findingGroups: SceneAuditFindingGroup[];
  findings: SceneAuditFinding[];
  /** 非问题型字段覆盖统计；避免为每个实例重复生成候选/不支持/缺失告警。 */
  coverage: SceneAuditFieldCoverage[];
}

export interface SceneAuditFieldCoverage {
  field: SceneInspectableField;
  observed: number;
  candidate: number;
  unsupported: number;
  absent: number;
}

export interface SceneAuditFindingGroup {
  severity: SceneAuditFinding['severity'];
  reasonCode: string;
  field: SceneInspectableField | null;
  count: number;
  sampleInstanceIds: string[];
  nextAction: string | null;
}

export interface SceneSpatialProblem {
  code:
    | 'AABB_VOLUME_OVERLAP'
    | 'BOUNDS_EVIDENCE_REQUIRED'
    | 'INVALID_AABB'
    | 'NON_FINITE_TRANSFORM'
    | 'TRANSFORM_OUT_OF_RANGE'
    | 'DUPLICATE_GROUP_MEMBER'
    | 'RELATION_PROBLEM'
    | 'SPATIAL_SCAN_TRUNCATED';
  severity: 'error' | 'warning' | 'info';
  certainty: 'confirmed' | 'needs-probe';
  instanceIds: string[];
  message: string;
  nextAction: string | null;
}

export interface SceneSpatialProblemResult {
  snapshotId: string;
  findings: SceneSpatialProblem[];
  truncated: boolean;
  summary: { confirmed: number; needsProbe: number };
}

export interface SceneSpatialProblemOptions {
  maxFindings?: number;
  maxPairChecks?: number;
  coordinateLimit?: number;
  scaleMinimum?: number;
  scaleMaximum?: number;
}

const FIELDS: readonly SceneInspectableField[] = ['transform', 'customProperties', 'signals', 'resources', 'bounds'];

function inspectFeature(field: SceneInspectableField, feature: FeatureState<unknown>): SceneFieldInspection {
  if (feature.state === 'observed') {
    return {
      field,
      state: feature.state,
      reasonCode: 'FIELD_OBSERVED',
      evidence: feature.evidence,
      reason: '该字段包含可追溯的观测值。',
      nextAction: null,
      value: feature.value,
    };
  }
  if (feature.state === 'candidate') {
    return {
      field,
      state: feature.state,
      reasonCode: 'EVIDENCE_INSUFFICIENT',
      evidence: feature.evidence,
      reason: '解析器只发现候选 wire 路径，不能确认字段值，也不能判定字段不存在。',
      nextAction: '运行对应只读探针或完成字段校准后重新读取。',
      wirePaths: [...feature.wirePaths].sort((left, right) => left.localeCompare(right, 'en')),
    };
  }
  if (feature.state === 'unsupported') {
    return {
      field,
      state: feature.state,
      reasonCode: 'FIELD_UNSUPPORTED',
      evidence: null,
      reason: feature.reason,
      nextAction: '升级或更换明确支持该字段的场景适配器。',
    };
  }
  return {
    field,
    state: feature.state,
    reasonCode: 'FIELD_ABSENT',
    evidence: null,
    reason: '当前快照明确记录该字段为 absent。',
    nextAction: null,
  };
}

export function inspectSceneInstanceFields(instance: SceneInstance): SceneFieldInspection[] {
  return FIELDS.map((field) => inspectFeature(field, instance[field] as FeatureState<unknown>));
}

function findingKey(finding: SceneAuditFinding): string {
  return [finding.severity, finding.reasonCode, finding.instanceId ?? '', finding.field ?? '', finding.message].join('\0');
}

function findingGroupKey(finding: SceneAuditFinding): string {
  return [finding.severity, finding.reasonCode, finding.field ?? '', finding.nextAction ?? ''].join('\0');
}

function groupAuditFindings(
  findings: readonly SceneAuditFinding[],
  sampleLimit: number,
): SceneAuditFindingGroup[] {
  const groups = new Map<string, SceneAuditFindingGroup>();
  for (const finding of findings) {
    const key = findingGroupKey(finding);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        severity: finding.severity,
        reasonCode: finding.reasonCode,
        field: finding.field,
        count: 0,
        sampleInstanceIds: [],
        nextAction: finding.nextAction,
      };
      groups.set(key, group);
    }
    group.count += 1;
    if (
      finding.instanceId !== null
      && group.sampleInstanceIds.length < sampleLimit
      && !group.sampleInstanceIds.includes(finding.instanceId)
    ) group.sampleInstanceIds.push(finding.instanceId);
  }
  return [...groups.values()].sort((left, right) => (
    ({ error: 0, warning: 1, info: 2 } as const)[left.severity]
    - ({ error: 0, warning: 1, info: 2 } as const)[right.severity]
    || left.reasonCode.localeCompare(right.reasonCode, 'en')
    || (left.field ?? '').localeCompare(right.field ?? '', 'en')
  ));
}

/**
 * 将逐实例审计压缩为每类少量示例，避免把成千上万条同类证据缺口塞给 AI。
 * 完整数量始终保留；调用方可显式请求详细模式取得原始 findings。
 */
export function compactSceneAuditResult(
  audit: SceneAuditResult,
  options: { examplesPerGroup?: number } = {},
): SceneAuditResult {
  const examplesPerGroup = options.examplesPerGroup ?? 1;
  if (!Number.isInteger(examplesPerGroup) || examplesPerGroup < 1 || examplesPerGroup > 20) {
    throw new ProductError('VALIDATION_FAILED', '审计每组示例数必须是 1 到 20 的整数。', [], 'STATIC_LOCAL');
  }
  const groupCounts = new Map<string, number>();
  const findings = audit.findings.filter((finding) => {
    const key = findingGroupKey(finding);
    const count = groupCounts.get(key) ?? 0;
    if (count >= examplesPerGroup) return false;
    groupCounts.set(key, count + 1);
    return true;
  });
  return {
    ...audit,
    findings,
    truncated: findings.length < audit.totalFindingCount,
    findingGroups: groupAuditFindings(audit.findings, examplesPerGroup),
  };
}

export function auditSceneSnapshot(
  snapshot: SceneSnapshot,
  options: { registryRecords?: readonly RegistryRecord[] } = {},
): SceneAuditResult {
  const findings: SceneAuditFinding[] = [];
  const coverage = new Map<SceneInspectableField, SceneAuditFieldCoverage>(FIELDS.map((field) => [field, {
    field, observed: 0, candidate: 0, unsupported: 0, absent: 0,
  }]));
  const byId = new Map<string, number>();
  for (const instance of snapshot.instances) byId.set(instance.instanceId, (byId.get(instance.instanceId) ?? 0) + 1);
  const duplicateIds = [...byId.entries()].filter(([, count]) => count > 1).sort(([left], [right]) => left.localeCompare(right, 'en'));
  for (const [instanceId, count] of duplicateIds) {
    findings.push({
      severity: 'error',
      reasonCode: 'DUPLICATE_INSTANCE_ID',
      message: `实例 ID ${instanceId} 在快照中出现 ${count} 次，精确查询必须视为歧义。`,
      instanceId,
      field: null,
      nextAction: '检查场景来源或解析适配器，不要任取其中一条记录。',
    });
  }
  for (const issue of snapshot.issues) {
    findings.push({
      severity: issue.code === 'DUPLICATE_INSTANCE' || issue.code === 'RELATION_CYCLE' ? 'error' : 'warning',
      reasonCode: `SNAPSHOT_${issue.code}`,
      message: issue.message,
      instanceId: issue.instanceId,
      field: null,
      nextAction: '按快照 issue 检查场景源；静态审计不会自动修复。',
    });
  }
  for (const instance of snapshot.instances) {
    if (instance.variant === 'unsupported-oneof-1' || instance.variant === 'unknown') {
      findings.push({
        severity: 'warning',
        reasonCode: 'UNSUPPORTED_INSTANCE_VARIANT',
        message: `实例 ${instance.instanceId} 使用未完整支持的 variant：${instance.variant}。`,
        instanceId: instance.instanceId,
        field: null,
        nextAction: '保留原始来源并使用支持该 variant 的适配器复核。',
      });
    }
    for (const field of inspectSceneInstanceFields(instance)) {
      const counts = coverage.get(field.field)!;
      counts[field.state] += 1;
    }
  }
  const suspected = (options.registryRecords ?? []).filter((record) => (
    record.validity === 'suspected-change'
    && (record.kind === 'scene-instance' || record.kind === 'element-type' || record.kind === 'scene-layer')
  )).sort((left, right) => left.recordId.localeCompare(right.recordId, 'en'));
  for (const record of suspected) {
    findings.push({
      severity: 'warning',
      reasonCode: 'REGISTRY_SUSPECTED_CHANGE',
      message: `场景台账记录 ${record.recordId} 处于 suspected-change。`,
      instanceId: record.kind === 'scene-instance' ? record.value : null,
      field: null,
      nextAction: '用当前权威场景快照复核该记录，勿把 suspected-change 当作已确认。',
    });
  }
  const severityOrder = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((left, right) => (
    severityOrder[left.severity] - severityOrder[right.severity]
    || findingKey(left).localeCompare(findingKey(right), 'en')
  ));
  return {
    snapshotId: snapshot.snapshotId,
    summary: {
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
      duplicateInstanceIds: duplicateIds.length,
      snapshotIssues: snapshot.issues.length,
      registrySuspected: suspected.length,
    },
    totalFindingCount: findings.length,
    truncated: false,
    findingGroups: groupAuditFindings(findings, 5),
    findings,
    coverage: [...coverage.values()],
  };
}

function trustedEvidence(evidence: FieldEvidence): boolean {
  return evidence.state === 'confirmed-calibration' || evidence.state === 'observed-repeatable';
}

function finiteVector(value: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function validBounds(instance: SceneInstance): instance is SceneInstance & { bounds: Extract<SceneInstance['bounds'], { state: 'observed' }> } {
  if (
    instance.bounds.state !== 'observed'
    || !trustedEvidence(instance.bounds.evidence)
    || !trustedEvidence(instance.bounds.value.evidence)
  ) return false;
  const { min, max } = instance.bounds.value;
  return finiteVector(min) && finiteVector(max) && min.x <= max.x && min.y <= max.y && min.z <= max.z;
}

function strictBoundsOverlap(
  left: Extract<SceneInstance['bounds'], { state: 'observed' }>['value'],
  right: Extract<SceneInstance['bounds'], { state: 'observed' }>['value'],
): boolean {
  return left.min.x < right.max.x && left.max.x > right.min.x
    && left.min.y < right.max.y && left.max.y > right.min.y
    && left.min.z < right.max.z && left.max.z > right.min.z;
}

/**
 * 只把可信 AABB/transform 形成的结论标为 confirmed；缺少边界时明确要求探针，绝不用零尺寸猜测。
 * 扫描和输出均有硬上限，超限时返回 evidence-insufficient 诊断而不是卡住 Extension Host。
 */
export function analyzeSceneSpatialProblems(
  snapshot: SceneSnapshot,
  options: SceneSpatialProblemOptions = {},
): SceneSpatialProblemResult {
  const maxFindings = options.maxFindings ?? 1_000;
  const maxPairChecks = options.maxPairChecks ?? 200_000;
  const coordinateLimit = options.coordinateLimit ?? 1_000_000_000;
  const scaleMinimum = options.scaleMinimum ?? 0.000001;
  const scaleMaximum = options.scaleMaximum ?? 1_000_000;
  if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > 10_000) throw new RangeError('maxFindings must be 1..10000');
  if (!Number.isInteger(maxPairChecks) || maxPairChecks < 1 || maxPairChecks > 10_000_000) throw new RangeError('maxPairChecks must be 1..10000000');
  if (![coordinateLimit, scaleMinimum, scaleMaximum].every((value) => Number.isFinite(value) && value > 0) || scaleMinimum > scaleMaximum) {
    throw new RangeError('spatial transform limits are invalid');
  }

  const findings: SceneSpatialProblem[] = [];
  let truncated = false;
  const append = (finding: SceneSpatialProblem): boolean => {
    if (findings.length >= maxFindings) {
      truncated = true;
      return false;
    }
    findings.push(finding);
    return true;
  };

  for (const group of snapshot.groups) {
    const counts = new Map<string, number>();
    for (const id of group.memberIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, count] of counts) if (count > 1) append({
      code: 'DUPLICATE_GROUP_MEMBER', severity: 'error', certainty: 'confirmed', instanceIds: [id],
      message: `编组 ${group.groupId} 重复包含成员 ${id}（${count} 次）。`,
      nextAction: '在官方编辑器复核编组成员；静态检查不会自动修改。',
    });
  }
  for (const issue of buildSceneRelations(snapshot).issues) append({
    code: 'RELATION_PROBLEM',
    severity: issue.code === 'RELATION_CYCLE' || issue.code === 'DUPLICATE_INSTANCE' || issue.code === 'DUPLICATE_GROUP' ? 'error' : 'warning',
    certainty: 'confirmed',
    instanceIds: issue.instanceId === null ? [] : [issue.instanceId],
    message: issue.message,
    nextAction: '在场景树和官方编辑器中复核该层级关系。',
  });

  const bounded: Array<SceneInstance & { bounds: Extract<SceneInstance['bounds'], { state: 'observed' }> }> = [];
  for (const instance of snapshot.instances) {
    if (instance.transform.state === 'observed') {
      const transform = instance.transform.value;
      if (![transform.position, transform.rotation, transform.scale].every(finiteVector)) append({
        code: 'NON_FINITE_TRANSFORM', severity: 'error', certainty: 'confirmed', instanceIds: [instance.instanceId],
        message: `实例 ${instance.instanceId} 的 transform 含非有限数值。`, nextAction: '重新读取场景或修复来源数据。',
      });
      else if (
        Object.values(transform.position).some((value) => Math.abs(value) > coordinateLimit)
        || Object.values(transform.scale).some((value) => Math.abs(value) < scaleMinimum || Math.abs(value) > scaleMaximum)
      ) append({
        code: 'TRANSFORM_OUT_OF_RANGE', severity: 'warning', certainty: 'confirmed', instanceIds: [instance.instanceId],
        message: `实例 ${instance.instanceId} 的位置或缩放超出当前检查边界。`, nextAction: '在设置的地图边界下复核该变换。',
      });
    }
    if (validBounds(instance)) {
      bounded.push(instance);
    } else if (instance.bounds.state === 'observed' && trustedEvidence(instance.bounds.evidence)) {
      append({
        code: 'INVALID_AABB', severity: 'error', certainty: 'confirmed', instanceIds: [instance.instanceId],
        message: `实例 ${instance.instanceId} 的可信 AABB 数值无效。`, nextAction: '重新测量该实例边界。',
      });
    } else {
      append({
        code: 'BOUNDS_EVIDENCE_REQUIRED', severity: 'info', certainty: 'needs-probe', instanceIds: [instance.instanceId],
        message: `实例 ${instance.instanceId} 缺少可信包围，无法确认悬空、下沉或重叠。`, nextAction: '运行只读边界/射线探针。',
      });
    }
  }

  bounded.sort((left, right) => left.bounds.value.min.x - right.bounds.value.min.x || left.instanceId.localeCompare(right.instanceId, 'en'));
  const active: typeof bounded = [];
  let pairChecks = 0;
  overlapScan: for (const current of bounded) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index]!.bounds.value.max.x <= current.bounds.value.min.x) active.splice(index, 1);
    }
    for (const other of active) {
      pairChecks += 1;
      if (pairChecks > maxPairChecks) {
        truncated = true;
        break overlapScan;
      }
      if (!strictBoundsOverlap(other.bounds.value, current.bounds.value)) continue;
      if (!append({
        code: 'AABB_VOLUME_OVERLAP', severity: 'warning', certainty: 'confirmed',
        instanceIds: [other.instanceId, current.instanceId].sort((left, right) => left.localeCompare(right, 'en')),
        message: `实例 ${other.instanceId} 与 ${current.instanceId} 的可信 AABB 明显体积重叠。`,
        nextAction: '确认重叠是否属于预期组合；否则生成空间计划。',
      })) break overlapScan;
    }
    active.push(current);
  }
  if (truncated && findings.length < maxFindings) findings.push({
    code: 'SPATIAL_SCAN_TRUNCATED', severity: 'warning', certainty: 'needs-probe', instanceIds: [],
    message: '空间问题扫描达到有界上限，未检查的对象不能判定为无问题。', nextAction: '缩小目标范围或提高受控扫描上限。',
  });
  const certaintyOrder = { confirmed: 0, 'needs-probe': 1 } as const;
  findings.sort((left, right) => certaintyOrder[left.certainty] - certaintyOrder[right.certainty]
    || left.code.localeCompare(right.code, 'en') || left.instanceIds.join('\0').localeCompare(right.instanceIds.join('\0'), 'en'));
  return {
    snapshotId: snapshot.snapshotId,
    findings,
    truncated,
    summary: {
      confirmed: findings.filter((finding) => finding.certainty === 'confirmed').length,
      needsProbe: findings.filter((finding) => finding.certainty === 'needs-probe').length,
    },
  };
}
