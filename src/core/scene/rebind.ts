import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import { validateRegistryDocument, type RegistryDocument } from '../model.js';
import type { LuaIdReference, LuaSourceIndex } from '../lua/source-index.js';
import {
  applyProposal,
  createPatchProposal,
  type AppliedProposal,
  type PatchProposal,
} from '../patch/proposal.js';
import {
  validateSceneProbeEvidence,
  type PropertyMatchProbeEntry,
  type SceneProbeEvidenceDocument,
} from './probe-evidence.js';
import type { FieldEvidence, SceneGroup, SceneInstance, SceneSnapshot, Transform, Vector3 } from './types.js';

export type SceneRebindEvidenceCode =
  | 'ELEMENT_TYPE_MATCH'
  | 'OWNER_STRUCTURE_MATCH'
  | 'TRANSFORM_MATCH'
  | 'PROPERTY_PROBE_MATCH';

export interface SceneRebindCandidate {
  newId: string;
  score: number;
  evidence: SceneRebindEvidenceCode[];
}

export interface SceneRebindMapping {
  oldId: string;
  status: 'unique' | 'ambiguous' | 'insufficient';
  selectedNewId: string | null;
  candidates: SceneRebindCandidate[];
}

export interface SceneRebindPreview {
  schemaVersion: 1;
  previewId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  bindingId: string;
  role: SceneSnapshot['role'];
  adapterId: string;
  sourceSha256: string;
  snapshotStateSha256: string;
  registrySha256: string;
  mappings: SceneRebindMapping[];
  summary: { unique: number; ambiguous: number; insufficient: number };
}

export interface SceneRebindOptions {
  positionTolerance?: number;
  rotationTolerance?: number;
  scaleTolerance?: number;
  maxInstances?: number;
  maxCandidatePairs?: number;
  propertyEvidence?: {
    before: SceneProbeEvidenceDocument;
    after: SceneProbeEvidenceDocument;
  };
}

export interface LuaRebindReplacement {
  path: string;
  line: number;
  column: number;
  oldId: string;
  newId: string;
}

export interface LuaRebindPatchGuards {
  rebindPreviewId: string;
  mapFingerprint: string | null;
  sceneSnapshotId: string;
  sceneSourceSha256: string;
  sceneStateSha256: string;
  registrySha256: string;
  sourceSha256: string;
}

export interface LuaRebindPatchPreview {
  schemaVersion: 1;
  previewId: string;
  guards: LuaRebindPatchGuards;
  replacements: LuaRebindReplacement[];
  proposal: PatchProposal;
}

export interface CreateLuaRebindPatchInput {
  projectInstanceId: string;
  mapFingerprint: string | null;
  targetPath: string;
  source: string;
  sourceIndex: LuaSourceIndex;
  registry: RegistryDocument;
  currentSnapshot: SceneSnapshot;
  rebind: SceneRebindPreview;
  createdAt: string;
}

const DEFAULT_MAX_INSTANCES = 200_000;
const DEFAULT_MAX_CANDIDATE_PAIRS = 200_000;
const ID_COMPARE = (left: string, right: string): number => left.localeCompare(right, 'en');

function trusted(evidence: FieldEvidence): boolean {
  return evidence.state === 'confirmed-calibration' || evidence.state === 'observed-repeatable';
}

function tolerance(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0) {
    throw new ProductError('VALIDATION_FAILED', `${name} 必须是有限非负数。`, ['修正重绑容差后重新预览。'], 'STATIC_LOCAL');
  }
  return selected;
}

function positiveLimit(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new ProductError('VALIDATION_FAILED', `${name} 超出安全上限。`, ['缩小重绑范围。'], 'STATIC_LOCAL');
  }
  return selected;
}

function assertSameLineage(before: SceneSnapshot, after: SceneSnapshot): void {
  if (before.bindingId === after.bindingId && before.role === after.role && before.adapterId === after.adapterId) return;
  throw new ProductError(
    'SCENE_SOURCE_CONFLICT',
    '场景 ID 重绑只允许比较同一 binding、role 和 adapter lineage。',
    ['选择同一来源 lineage 的前后快照。'],
    'STATIC_LOCAL',
  );
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort(ID_COMPARE);
}

function assertDuplicateSafe(snapshot: SceneSnapshot): void {
  const repeatedInstances = duplicates(snapshot.instances.map((item) => item.instanceId));
  const repeatedGroups = duplicates(snapshot.groups.map((item) => item.groupId));
  const repeatedMembers = snapshot.groups.flatMap((group) => (
    duplicates(group.memberIds).map((id) => `${group.groupId}:${id}`)
  ));
  if (repeatedInstances.length === 0 && repeatedGroups.length === 0 && repeatedMembers.length === 0) return;
  throw new ProductError(
    'SCENE_EVIDENCE_INSUFFICIENT',
    '场景快照包含重复实例、编组或编组成员，禁止生成 ID 重绑结论。',
    ['先在场景来源与解析结果中消除重复记录。'],
    'STATIC_LOCAL',
  );
}

function vectorWithin(left: Vector3, right: Vector3, limit: number): boolean {
  return Math.abs(left.x - right.x) <= limit
    && Math.abs(left.y - right.y) <= limit
    && Math.abs(left.z - right.z) <= limit;
}

function transformWithin(
  left: Transform,
  right: Transform,
  limits: { position: number; rotation: number; scale: number },
): boolean {
  return vectorWithin(left.position, right.position, limits.position)
    && vectorWithin(left.rotation, right.rotation, limits.rotation)
    && vectorWithin(left.scale, right.scale, limits.scale);
}

interface DirectOwnerSignature {
  kind: 'root' | 'group' | 'instance';
  memberCount?: number;
  nestedCount?: number;
  elementTypeId?: string | null;
}

interface GroupShape {
  memberCount: number;
  nestedCount: number;
}

interface OwnerSignature {
  direct: DirectOwnerSignature;
  memberships: GroupShape[];
}

function groupMemberships(groups: ReadonlyMap<string, SceneGroup>): ReadonlyMap<string, GroupShape[]> {
  const result = new Map<string, GroupShape[]>();
  for (const group of groups.values()) {
    if (!trusted(group.evidence)) continue;
    const shape = { memberCount: group.memberIds.length, nestedCount: group.nestedGroupIds.length };
    for (const memberId of group.memberIds) {
      const values = result.get(memberId) ?? [];
      values.push(shape);
      result.set(memberId, values);
    }
  }
  for (const values of result.values()) values.sort((left, right) => left.memberCount - right.memberCount || left.nestedCount - right.nestedCount);
  return result;
}

function ownerSignature(
  instance: SceneInstance,
  instances: ReadonlyMap<string, SceneInstance>,
  groups: ReadonlyMap<string, SceneGroup>,
  memberships: ReadonlyMap<string, GroupShape[]>,
): OwnerSignature | null {
  if (!trusted(instance.evidence)) return null;
  let direct: DirectOwnerSignature;
  if (instance.ownerId === null || instance.ownerId === instance.instanceId) direct = { kind: 'root' };
  else {
    const group = groups.get(instance.ownerId);
    if (group !== undefined && trusted(group.evidence)) {
      direct = { kind: 'group', memberCount: group.memberIds.length, nestedCount: group.nestedGroupIds.length };
    } else {
      const owner = instances.get(instance.ownerId);
      if (owner === undefined || !trusted(owner.evidence)) return null;
      direct = { kind: 'instance', elementTypeId: owner.elementTypeId };
    }
  }
  return { direct, memberships: [...(memberships.get(instance.instanceId) ?? [])] };
}

function ownerScore(left: OwnerSignature | null, right: OwnerSignature | null): number {
  if (left === null || right === null || stableJson(left) !== stableJson(right)) return 0;
  return left.direct.kind === 'root' && left.memberships.length === 0 ? 15 : 25;
}

function candidate(
  before: SceneInstance,
  after: SceneInstance,
  beforeInstances: ReadonlyMap<string, SceneInstance>,
  afterInstances: ReadonlyMap<string, SceneInstance>,
  beforeGroups: ReadonlyMap<string, SceneGroup>,
  afterGroups: ReadonlyMap<string, SceneGroup>,
  beforeMemberships: ReadonlyMap<string, GroupShape[]>,
  afterMemberships: ReadonlyMap<string, GroupShape[]>,
  limits: { position: number; rotation: number; scale: number },
  beforeProperties: ReadonlySet<string>,
  afterProperties: ReadonlySet<string>,
): SceneRebindCandidate | null {
  if (
    before.elementTypeId === null
    || before.elementTypeId !== after.elementTypeId
    || !trusted(before.evidence)
    || !trusted(after.evidence)
  ) return null;
  let score = 60;
  const evidence: SceneRebindEvidenceCode[] = ['ELEMENT_TYPE_MATCH'];
  const structureScore = ownerScore(
    ownerSignature(before, beforeInstances, beforeGroups, beforeMemberships),
    ownerSignature(after, afterInstances, afterGroups, afterMemberships),
  );
  if (structureScore > 0) {
    score += structureScore;
    evidence.push('OWNER_STRUCTURE_MATCH');
  }
  if (
    before.transform.state === 'observed'
    && after.transform.state === 'observed'
    && trusted(before.transform.evidence)
    && trusted(after.transform.evidence)
    && transformWithin(before.transform.value, after.transform.value, limits)
  ) {
    score += 20;
    evidence.push('TRANSFORM_MATCH');
  }
  if ([...beforeProperties].some((property) => afterProperties.has(property))) {
    score += 40;
    evidence.push('PROPERTY_PROBE_MATCH');
  }
  if (score < 80 || evidence.length < 2) return null;
  return { newId: after.instanceId, score, evidence };
}

function propertyEvidenceById(
  document: SceneProbeEvidenceDocument | undefined,
  snapshot: SceneSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (document === undefined) return new Map();
  validateSceneProbeEvidence(document);
  if (
    document.bindingId !== snapshot.bindingId
    || document.snapshotId !== snapshot.snapshotId
    || document.sceneSourceSha256 !== snapshot.sourceSha256
    || document.issues.length > 0
  ) {
    throw new ProductError(
      'SCENE_EVIDENCE_INSUFFICIENT',
      '属性探针不属于当前精确快照或包含冲突，不能用于 ID 重绑。',
      ['重新导入前后快照各自的无冲突属性探针。'],
      'STATIC_LOCAL',
    );
  }
  const result = new Map<string, Set<string>>();
  for (const entry of document.entries.filter((item): item is PropertyMatchProbeEntry => item.kind === 'property-match')) {
    const values = result.get(entry.id) ?? new Set<string>();
    values.add(`${entry.propertyType}\0${entry.propertyHash}`);
    result.set(entry.id, values);
  }
  return result;
}

export function buildSceneRebindPreview(
  before: SceneSnapshot,
  after: SceneSnapshot,
  registry: RegistryDocument,
  options: SceneRebindOptions = {},
): SceneRebindPreview {
  assertSameLineage(before, after);
  assertDuplicateSafe(before);
  assertDuplicateSafe(after);
  validateRegistryDocument(registry);
  const maxInstances = positiveLimit(options.maxInstances, DEFAULT_MAX_INSTANCES, 'maxInstances', DEFAULT_MAX_INSTANCES);
  if (before.instances.length > maxInstances || after.instances.length > maxInstances) {
    throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景 ID 重绑实例数超过安全上限。', ['缩小场景范围。'], 'STATIC_LOCAL');
  }
  const maxCandidatePairs = positiveLimit(
    options.maxCandidatePairs,
    DEFAULT_MAX_CANDIDATE_PAIRS,
    'maxCandidatePairs',
    10_000_000,
  );
  const limits = {
    position: tolerance(options.positionTolerance, 0.01, 'positionTolerance'),
    rotation: tolerance(options.rotationTolerance, 0.01, 'rotationTolerance'),
    scale: tolerance(options.scaleTolerance, 0.001, 'scaleTolerance'),
  };
  const beforeInstances = new Map(before.instances.map((item) => [item.instanceId, item]));
  const afterInstances = new Map(after.instances.map((item) => [item.instanceId, item]));
  const beforeGroups = new Map(before.groups.map((item) => [item.groupId, item]));
  const afterGroups = new Map(after.groups.map((item) => [item.groupId, item]));
  const beforeMemberships = groupMemberships(beforeGroups);
  const afterMemberships = groupMemberships(afterGroups);
  const beforeProperties = propertyEvidenceById(options.propertyEvidence?.before, before);
  const afterProperties = propertyEvidenceById(options.propertyEvidence?.after, after);
  if (
    options.propertyEvidence !== undefined
    && options.propertyEvidence.before.projectInstanceId !== options.propertyEvidence.after.projectInstanceId
  ) {
    throw new ProductError(
      'SCENE_SOURCE_CONFLICT',
      '前后属性探针不属于同一工程实例。',
      ['重新导入同一工程的前后属性探针。'],
      'STATIC_LOCAL',
    );
  }
  const addedByType = new Map<string, SceneInstance[]>();
  for (const item of after.instances) {
    if (beforeInstances.has(item.instanceId) || item.elementTypeId === null) continue;
    const values = addedByType.get(item.elementTypeId) ?? [];
    values.push(item);
    addedByType.set(item.elementTypeId, values);
  }
  for (const values of addedByType.values()) values.sort((left, right) => ID_COMPARE(left.instanceId, right.instanceId));
  const removed = before.instances
    .filter((item) => !afterInstances.has(item.instanceId))
    .sort((left, right) => ID_COMPARE(left.instanceId, right.instanceId));
  let pairCount = 0;
  const mappings = removed.map((old): SceneRebindMapping => {
    const possible = old.elementTypeId === null ? [] : addedByType.get(old.elementTypeId) ?? [];
    pairCount += possible.length;
    if (pairCount > maxCandidatePairs) {
      throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景 ID 重绑候选对超过安全上限。', ['缩小范围或拆分重绑批次。'], 'STATIC_LOCAL');
    }
    const candidates = possible
      .map((item) => candidate(
        old,
        item,
        beforeInstances,
        afterInstances,
        beforeGroups,
        afterGroups,
        beforeMemberships,
        afterMemberships,
        limits,
        beforeProperties.get(old.instanceId) ?? new Set<string>(),
        afterProperties.get(item.instanceId) ?? new Set<string>(),
      ))
      .filter((item): item is SceneRebindCandidate => item !== null)
      .sort((left, right) => right.score - left.score || ID_COMPARE(left.newId, right.newId));
    const status = candidates.length === 1 ? 'unique' : candidates.length > 1 ? 'ambiguous' : 'insufficient';
    return { oldId: old.instanceId, status, selectedNewId: status === 'unique' ? candidates[0]!.newId : null, candidates };
  });
  const selectedCounts = new Map<string, number>();
  for (const mapping of mappings) {
    if (mapping.selectedNewId !== null) {
      selectedCounts.set(mapping.selectedNewId, (selectedCounts.get(mapping.selectedNewId) ?? 0) + 1);
    }
  }
  for (const mapping of mappings) {
    if (mapping.selectedNewId !== null && (selectedCounts.get(mapping.selectedNewId) ?? 0) > 1) {
      mapping.status = 'ambiguous';
      mapping.selectedNewId = null;
    }
  }
  const summary = {
    unique: mappings.filter((item) => item.status === 'unique').length,
    ambiguous: mappings.filter((item) => item.status === 'ambiguous').length,
    insufficient: mappings.filter((item) => item.status === 'insufficient').length,
  };
  const identity = {
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    bindingId: after.bindingId,
    role: after.role,
    adapterId: after.adapterId,
    sourceSha256: after.sourceSha256,
    snapshotStateSha256: sha256Hex(stableJson(after)),
    registrySha256: sha256Hex(stableJson(registry)),
    mappings,
    summary,
  };
  return { schemaVersion: 1, previewId: sha256Hex(stableJson(identity)), ...identity };
}

function rebindIdentity(preview: SceneRebindPreview): Omit<SceneRebindPreview, 'schemaVersion' | 'previewId'> {
  return {
    fromSnapshotId: preview.fromSnapshotId,
    toSnapshotId: preview.toSnapshotId,
    bindingId: preview.bindingId,
    role: preview.role,
    adapterId: preview.adapterId,
    sourceSha256: preview.sourceSha256,
    snapshotStateSha256: preview.snapshotStateSha256,
    registrySha256: preview.registrySha256,
    mappings: preview.mappings,
    summary: preview.summary,
  };
}

function assertRebindPreview(preview: SceneRebindPreview): void {
  if (preview.schemaVersion !== 1 || sha256Hex(stableJson(rebindIdentity(preview))) !== preview.previewId) {
    throw new ProductError('VALIDATION_FAILED', '场景 ID 重绑预览身份哈希无效。', ['重新生成重绑预览。'], 'STATIC_LOCAL');
  }
  if (preview.mappings.some((item) => item.status !== 'unique' || item.selectedNewId === null)) {
    throw new ProductError(
      'SCENE_EVIDENCE_INSUFFICIENT',
      '重绑预览仍包含歧义或证据不足项，禁止生成 Lua 补丁。',
      ['先逐项补足证据，直到每个旧 ID 都只有一个候选。'],
      'STATIC_LOCAL',
    );
  }
}

function registryHash(registry: RegistryDocument): string {
  validateRegistryDocument(registry);
  return sha256Hex(stableJson(registry));
}

function assertCurrentScene(preview: SceneRebindPreview, snapshot: SceneSnapshot): void {
  if (
    snapshot.snapshotId !== preview.toSnapshotId
    || snapshot.sourceSha256 !== preview.sourceSha256
    || snapshot.bindingId !== preview.bindingId
    || snapshot.role !== preview.role
    || snapshot.adapterId !== preview.adapterId
    || sha256Hex(stableJson(snapshot)) !== preview.snapshotStateSha256
  ) {
    throw new ProductError(
      'SCENE_SOURCE_CONFLICT',
      '当前场景快照已偏离重绑预览。',
      ['基于当前快照重新生成重绑预览。'],
      'STATIC_LOCAL',
    );
  }
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function offset(starts: readonly number[], line: number, column: number, sourceLength: number): number {
  const start = starts[line - 1];
  if (start === undefined || !Number.isSafeInteger(column) || column < 1) {
    throw new ProductError('UNSAFE_LUA_NODE', 'Lua 引用范围无效，不能安全生成重绑补丁。', ['重新建立 Lua 索引。'], 'STATIC_LOCAL');
  }
  const result = start + column - 1;
  if (result < 0 || result > sourceLength) {
    throw new ProductError('UNSAFE_LUA_NODE', 'Lua 引用越过文件边界。', ['重新建立 Lua 索引。'], 'STATIC_LOCAL');
  }
  return result;
}

interface LocatedReplacement extends LuaRebindReplacement {
  start: number;
  end: number;
  token: string;
}

function locateReference(
  source: string,
  starts: readonly number[],
  reference: LuaIdReference,
  newId: string,
): LocatedReplacement {
  const start = offset(starts, reference.line, reference.column, source.length);
  const end = offset(starts, reference.endLine, reference.endColumn, source.length);
  if (end <= start) {
    throw new ProductError('UNSAFE_LUA_NODE', 'Lua 引用范围为空或反向。', ['重新建立 Lua 索引。'], 'STATIC_LOCAL');
  }
  const token = source.slice(start, end);
  const quoted = /^(['"])(\d+)\1$/u.exec(token);
  const valid = token === reference.value || (quoted !== null && quoted[2] === reference.value);
  if (!valid) {
    throw new ProductError(
      'HASH_CONFLICT',
      'Lua 索引范围与当前源码不一致，已停止生成补丁。',
      ['重新索引当前 Lua 源码后再预览。'],
      'STATIC_LOCAL',
    );
  }
  const replacementToken = quoted === null ? newId : `${quoted[1]}${newId}${quoted[1]}`;
  return {
    path: reference.path,
    line: reference.line,
    column: reference.column,
    oldId: reference.value,
    newId,
    start,
    end,
    token: replacementToken,
  };
}

function replaceSource(source: string, located: readonly LocatedReplacement[]): string {
  let result = source;
  let nextStart = source.length + 1;
  for (const item of [...located].sort((left, right) => right.start - left.start)) {
    if (item.end > nextStart) {
      throw new ProductError('UNSAFE_LUA_NODE', 'Lua 重绑引用范围发生重叠。', ['重新建立 Lua 索引。'], 'STATIC_LOCAL');
    }
    result = `${result.slice(0, item.start)}${item.token}${result.slice(item.end)}`;
    nextStart = item.start;
  }
  return result;
}

export function createLuaRebindPatchPreview(input: CreateLuaRebindPatchInput): LuaRebindPatchPreview {
  assertRebindPreview(input.rebind);
  assertCurrentScene(input.rebind, input.currentSnapshot);
  const currentRegistrySha256 = registryHash(input.registry);
  if (currentRegistrySha256 !== input.rebind.registrySha256) {
    throw new ProductError('HASH_CONFLICT', '注册中心在重绑预览后已变化。', ['重新生成重绑预览。'], 'STATIC_LOCAL');
  }
  if (!input.sourceIndex.files.some((file) => file.path === input.targetPath)) {
    throw new ProductError('HASH_CONFLICT', 'Lua 索引不包含当前补丁目标。', ['重新索引目标 Lua 文件。'], 'STATIC_LOCAL');
  }
  const starts = lineStarts(input.source);
  const located: LocatedReplacement[] = [];
  const locationKeys = new Set<string>();
  for (const mapping of input.rebind.mappings) {
    const newId = mapping.selectedNewId!;
    const records = input.registry.records.filter((record) => (
      record.kind === 'scene-instance'
      && record.value === mapping.oldId
      && record.projectInstanceId === input.projectInstanceId
      && record.mapFingerprint === input.mapFingerprint
      && record.validity !== 'invalid'
    ));
    if (records.length !== 1) {
      throw new ProductError(
        'SCENE_EVIDENCE_INSUFFICIENT',
        '旧场景 ID 在当前注册中心中不是唯一可用记录。',
        ['清理重复或无效的场景实例台账后重试。'],
        'STATIC_LOCAL',
      );
    }
    for (const reference of input.sourceIndex.idReferences) {
      if (
        reference.path !== input.targetPath
        || reference.value !== mapping.oldId
        || reference.registryKind !== 'scene-instance'
        || reference.evidence.source !== 'registry'
        || reference.evidence.recordId !== records[0]!.recordId
      ) continue;
      const key = `${reference.path}\0${reference.line}\0${reference.column}\0${reference.endLine}\0${reference.endColumn}`;
      if (locationKeys.has(key)) continue;
      locationKeys.add(key);
      located.push(locateReference(input.source, starts, reference, newId));
    }
  }
  if (located.length === 0) {
    throw new ProductError('NOT_FOUND', '目标 Lua 文件中没有可安全重绑的注册中心引用。', ['检查目标文件与当前 Lua 索引。'], 'STATIC_LOCAL');
  }
  located.sort((left, right) => left.start - right.start);
  const proposal = createPatchProposal({
    projectInstanceId: input.projectInstanceId,
    targetPath: input.targetPath,
    originalContent: input.source,
    newContent: replaceSource(input.source, located),
    summary: `场景实例 ID 重绑预览（${located.length} 处）`,
    createdAt: input.createdAt,
  });
  const guards: LuaRebindPatchGuards = {
    rebindPreviewId: input.rebind.previewId,
    mapFingerprint: input.mapFingerprint,
    sceneSnapshotId: input.currentSnapshot.snapshotId,
    sceneSourceSha256: input.currentSnapshot.sourceSha256,
    sceneStateSha256: sha256Hex(stableJson(input.currentSnapshot)),
    registrySha256: currentRegistrySha256,
    sourceSha256: proposal.originalSha256!,
  };
  const replacements = located.map(({ path, line, column, oldId, newId }) => ({ path, line, column, oldId, newId }));
  const previewIdentity = { guards, replacements, proposalId: proposal.proposalId };
  return { schemaVersion: 1, previewId: sha256Hex(stableJson(previewIdentity)), guards, replacements, proposal };
}

export function assertLuaRebindPatchGuards(
  preview: LuaRebindPatchPreview,
  current: { registry: RegistryDocument; snapshot: SceneSnapshot },
): void {
  const previewIdentity = { guards: preview.guards, replacements: preview.replacements, proposalId: preview.proposal.proposalId };
  if (preview.schemaVersion !== 1 || sha256Hex(stableJson(previewIdentity)) !== preview.previewId) {
    throw new ProductError('VALIDATION_FAILED', 'Lua 重绑补丁预览身份哈希无效。', ['重新生成补丁预览。'], 'STATIC_LOCAL');
  }
  if (registryHash(current.registry) !== preview.guards.registrySha256) {
    throw new ProductError('HASH_CONFLICT', '注册中心在补丁预览后已变化。', ['重新生成补丁预览。'], 'STATIC_LOCAL');
  }
  if (
    current.snapshot.snapshotId !== preview.guards.sceneSnapshotId
    || current.snapshot.sourceSha256 !== preview.guards.sceneSourceSha256
    || sha256Hex(stableJson(current.snapshot)) !== preview.guards.sceneStateSha256
  ) {
    throw new ProductError('SCENE_SOURCE_CONFLICT', '当前场景快照在补丁预览后已变化。', ['重新生成重绑与补丁预览。'], 'STATIC_LOCAL');
  }
}

export async function applyLuaRebindPatch(
  root: string,
  preview: LuaRebindPatchPreview,
  current: { registry: RegistryDocument; snapshot: SceneSnapshot },
  confirmed: boolean,
): Promise<AppliedProposal> {
  assertLuaRebindPatchGuards(preview, current);
  return applyProposal(root, preview.proposal, confirmed);
}
