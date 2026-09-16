import { TextDecoder } from 'node:util';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

import { ProductError } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';

export type SceneProbePurpose = 'measurement' | 'property' | 'alignment';

export interface SceneProbeContext {
  projectInstanceId: string;
  bindingId: string;
  snapshotId: string;
  sceneSourceSha256: string;
}

/**
 * 为用户显式登记的单个实例建立 runtime-only 探针上下文。
 * snapshotId 是本次登记记录的稳定上下文哈希，不代表完整场景快照；
 * 这样日志仍能绑定工程、登记记录和源摘要，同时不会伪造 LayerData 快照。
 */
export function createRuntimeOnlyProbeContext(
  projectInstanceId: string,
  recordId: string,
  sourceSha256: string,
): SceneProbeContext {
  if (!UUID_PATTERN.test(projectInstanceId) || !SHA256_PATTERN.test(sourceSha256) || recordId.trim() === '') {
    throw new ProductError('VALIDATION_FAILED', 'runtime-only 探针上下文无效。', ['重新显式登记当前场景实例 ID。'], 'STATIC_LOCAL');
  }
  return {
    projectInstanceId,
    bindingId: sourceSha256,
    snapshotId: sha256Hex(`runtime-only\0${recordId}`),
    sceneSourceSha256: sourceSha256,
  };
}

export interface SceneProbeIssue {
  line: number;
  marker: 'YMAI_SCENE_PROBE' | 'YMAI_SCENE_CAPABILITY' | 'YMAI_SCENE_FIELD' | 'YMAI_SCENE_GROUP' | 'YMAI_PROPERTY_MATCH' | 'YMAI_AUTO_ALIGN' | null;
  code:
    | 'LINE_TOO_LONG'
    | 'MALFORMED_ENTRY'
    | 'UNKNOWN_KEY'
    | 'DUPLICATE_KEY'
    | 'INVALID_ID_SET'
    | 'NON_FINITE_NUMBER'
    | 'DUPLICATE_ENTRY'
    | 'CONFLICTING_ENTRY';
  message: string;
}

interface BoundEntry {
  line: number;
  token: string;
  snapshotId: string;
  sceneSourceSha256: string;
}

export interface MeasurementProbeEntry extends BoundEntry {
  kind: 'measurement';
  selectionIds: string[];
  id: string;
  status: 'ok';
  elementTypeId: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  sizeBox: [number, number, number];
  meshCenter: [number, number, number];
  visible: boolean;
  physics: boolean;
  collision: boolean;
  canBeGrabbed: boolean;
  parentId: string | null;
  childCount: number;
}

export interface PropertyMatchProbeEntry extends BoundEntry {
  kind: 'property-match';
  selectionIds: string[];
  id: string;
  status: 'match';
  propertyHash: string;
  propertyType: string;
}

export interface CapabilityProbeEntry extends BoundEntry {
  kind: 'capability';
  selectionIds: string[];
  id: string;
  status: 'ok';
  characterState: ObjectFamilyProbeState;
  creatureState: ObjectFamilyProbeState;
  elementState: ObjectFamilyProbeState;
  logicElementState: ObjectFamilyProbeState;
  playerState: ObjectFamilyProbeState;
  triggerBoxState: ObjectFamilyProbeState;
  triggerSampleState: 'ok' | 'not-applicable' | 'error';
  triggerSample: [number, number, number] | null;
}

export interface SceneRuntimeCapabilityEvidence {
  instanceId: string;
  snapshotId: string;
  sceneSourceSha256: string;
  importedAt: string;
  /** Optional only for evidence imported before six-family probing was introduced. */
  characterState?: ObjectFamilyProbeState;
  /** Optional only for evidence imported before six-family probing was introduced. */
  creatureState?: ObjectFamilyProbeState;
  elementState: ObjectFamilyProbeState;
  logicElementState: ObjectFamilyProbeState;
  /** Optional only for evidence imported before six-family probing was introduced. */
  playerState?: ObjectFamilyProbeState;
  triggerBoxState: ObjectFamilyProbeState;
  triggerSampleState: CapabilityProbeEntry['triggerSampleState'];
  triggerSample: [number, number, number] | null;
  fields: Partial<Record<SceneFieldProbeName, Pick<SceneFieldProbeEntry, 'status' | 'value'>>>;
  fieldConflicts: SceneFieldProbeName[];
}

export type CapabilityEvidenceResolution =
  | { state: 'unique'; evidence: SceneRuntimeCapabilityEvidence }
  | { state: 'conflict'; evidence: null };

export type ObjectFamilyProbeState = 'present' | 'absent' | 'error';

export type SceneFieldProbeName =
  | 'type' | 'position' | 'rotation' | 'scale' | 'sizeBox' | 'meshCenter'
  | 'visible' | 'physics' | 'collision' | 'canBeGrabbed' | 'parent' | 'childCount';

export type SceneFieldProbeValue =
  | { kind: 'id'; value: string }
  | { kind: 'vector'; value: [number, number, number] }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'optional-id'; value: string | null }
  | { kind: 'count'; value: number };

export interface SceneFieldProbeEntry extends BoundEntry {
  kind: 'field-capability';
  selectionIds: string[];
  id: string;
  field: SceneFieldProbeName;
  status: 'ok' | 'error' | 'not-applicable';
  value: SceneFieldProbeValue | null;
}

export interface GroupStructureProbeEntry extends BoundEntry {
  kind: 'group-structure';
  selectionIds: string[];
  groupId: string;
  status: 'ok';
  immediateSuccess: boolean;
  recursiveSuccess: boolean;
  immediateCount: number;
  recursiveCount: number;
  immediateIds: string[];
  recursiveIds: string[];
  truncated: boolean;
  staticDirectIds: string[];
  staticNestedGroupIds: string[];
}

export interface AlignmentPlanProbeEntry extends BoundEntry {
  kind: 'alignment-plan';
  supportId: string;
  moverIds: string[];
  status: 'planned';
  supportTopZ: number;
  lowestZ: number;
  deltaZ: number;
}

export type SceneProbeEntry = MeasurementProbeEntry | CapabilityProbeEntry | SceneFieldProbeEntry | GroupStructureProbeEntry | PropertyMatchProbeEntry | AlignmentPlanProbeEntry;

export interface SceneProbeEvidenceDocument extends SceneProbeContext {
  schemaVersion: 1;
  sourceHash: string;
  importedAt: string;
  entries: SceneProbeEntry[];
  issues: SceneProbeIssue[];
}

export interface AlignmentPlanEvidence {
  token: string;
  supportId: string;
  moverIds: string[];
  supportTopZ: number;
  lowestZ: number;
  deltaZ: number;
}

export interface ParseSceneProbeOptions {
  context: SceneProbeContext;
  importedAt?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID_PATTERN = /^\d{1,20}$/u;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LINE_LENGTH = 4096;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;
const MARKER_PATTERN = /\[(YMAI_SCENE_PROBE|YMAI_SCENE_CAPABILITY|YMAI_SCENE_FIELD|YMAI_SCENE_GROUP|YMAI_PROPERTY_MATCH|YMAI_AUTO_ALIGN)\]/u;
const PROPERTY_TYPES = new Set([
  'Bool', 'Number', 'String', 'Color', 'Vector', 'Element', 'Particle', 'ChainParticle', 'Audio', 'Image',
  'CharacterPart', 'Animation', 'RechargeAbility', 'Prop', 'CustomUI',
]);
const ISSUE_CODES = new Set<SceneProbeIssue['code']>([
  'LINE_TOO_LONG', 'MALFORMED_ENTRY', 'UNKNOWN_KEY', 'DUPLICATE_KEY', 'INVALID_ID_SET',
  'NON_FINITE_NUMBER', 'DUPLICATE_ENTRY', 'CONFLICTING_ENTRY',
]);

const KEYS = {
  YMAI_SCENE_PROBE: new Set([
    'token', 'snapshot', 'source', 'selection', 'id', 'status', 'type', 'position', 'rotation', 'scale',
    'sizeBox', 'meshCenter', 'visible', 'physics', 'collision', 'canBeGrabbed', 'parent', 'childCount',
  ]),
  YMAI_SCENE_CAPABILITY: new Set([
    'token', 'snapshot', 'source', 'selection', 'id', 'status', 'characterState', 'creatureState',
    'elementState', 'logicElementState', 'playerState', 'triggerBoxState',
    'triggerSampleState', 'triggerSample',
  ]),
  YMAI_SCENE_FIELD: new Set([
    'token', 'snapshot', 'source', 'selection', 'id', 'field', 'status', 'value',
  ]),
  YMAI_SCENE_GROUP: new Set([
    'token', 'snapshot', 'source', 'selection', 'group', 'status', 'immediateSuccess', 'recursiveSuccess',
    'immediateCount', 'recursiveCount', 'immediate', 'recursive', 'truncated', 'staticDirect', 'staticNested',
  ]),
  YMAI_PROPERTY_MATCH: new Set([
    'token', 'snapshot', 'source', 'selection', 'id', 'status', 'propertyHash', 'propertyType',
  ]),
  YMAI_AUTO_ALIGN: new Set([
    'token', 'snapshot', 'source', 'support', 'movers', 'status', 'supportTopZ', 'lowestZ', 'deltaZ',
    'expectedDeltaZ', 'currentDeltaZ', 'reason',
  ]),
} as const;

function insufficient(message: string): never {
  throw new ProductError(
    'SCENE_EVIDENCE_INSUFFICIENT',
    message,
    ['重新生成当前快照的只读探针，并导入同一次试玩日志。'],
    'STATIC_LOCAL',
  );
}

function validateContext(context: SceneProbeContext): void {
  if (
    !UUID_PATTERN.test(context.projectInstanceId)
    || !SHA256_PATTERN.test(context.bindingId)
    || !SHA256_PATTERN.test(context.snapshotId)
    || !SHA256_PATTERN.test(context.sceneSourceSha256)
  ) {
    throw new ProductError('VALIDATION_FAILED', '场景探针上下文字段无效。', ['重新读取当前场景快照。'], 'STATIC_LOCAL');
  }
}

function normalizeIds(ids: readonly string[]): string[] {
  if (ids.length === 0 || ids.some((id) => !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new ProductError('VALIDATION_FAILED', '探针选择集必须是非空、无重复的十进制实例 ID。', ['重新选择当前场景元件。'], 'STATIC_LOCAL');
  }
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

export function createSceneProbeToken(
  context: SceneProbeContext,
  purpose: SceneProbePurpose,
  selectedIds: readonly string[],
): string {
  validateContext(context);
  const ids = normalizeIds(selectedIds);
  return sha256Hex([
    context.projectInstanceId,
    context.bindingId,
    context.snapshotId,
    context.sceneSourceSha256,
    purpose,
    ids.join(','),
  ].join('\0'));
}

export function containsSceneProbeMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_LOG_BYTES) return false;
  try {
    return MARKER_PATTERN.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

function issue(
  issues: SceneProbeIssue[],
  line: number,
  marker: SceneProbeIssue['marker'],
  code: SceneProbeIssue['code'],
  message: string,
): void {
  issues.push({ line, marker, code, message });
}

function parseFields(
  text: string,
  line: number,
  marker: keyof typeof KEYS,
  issues: SceneProbeIssue[],
): Map<string, string> | null {
  const fields = new Map<string, string>();
  let valid = true;
  for (const part of text.trim().split(/\s+/u).filter(Boolean)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([^\s=]+)$/u.exec(part);
    if (match === null) {
      issue(issues, line, marker, 'MALFORMED_ENTRY', '字段必须使用 key=value 且值不得包含空白。');
      valid = false;
      continue;
    }
    const key = match[1]!;
    if (!KEYS[marker].has(key as never)) {
      issue(issues, line, marker, 'UNKNOWN_KEY', `不允许的字段：${key}`);
      valid = false;
      continue;
    }
    if (fields.has(key)) {
      issue(issues, line, marker, 'DUPLICATE_KEY', `字段重复：${key}`);
      valid = false;
      continue;
    }
    fields.set(key, match[2]!);
  }
  return valid ? fields : null;
}

function required(fields: ReadonlyMap<string, string>, key: string): string | null {
  return fields.get(key) ?? null;
}

function parseId(value: string | null): string | null {
  return value !== null && ID_PATTERN.test(value) ? value : null;
}

function parseIdSet(value: string | null): string[] | null {
  if (value === null) return null;
  const ids = value.split(',');
  if (ids.length === 0 || ids.some((id) => !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) return null;
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

function parseFinite(value: string | null): number | null {
  if (value === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_ABSOLUTE_NUMBER ? parsed : null;
}

function parseVector(value: string | null): [number, number, number] | null {
  if (value === null) return null;
  const values = value.split(',').map((item) => parseFinite(item));
  return values.length === 3 && values.every((item) => item !== null)
    ? values as [number, number, number]
    : null;
}

function parseBoolean(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

function parseObjectFamilyState(value: string | null): ObjectFamilyProbeState | null {
  return value === 'present' || value === 'absent' || value === 'error' ? value : null;
}

function validateBinding(
  fields: ReadonlyMap<string, string>,
  context: SceneProbeContext,
  purpose: SceneProbePurpose,
  selectedIds: readonly string[],
): { token: string; snapshotId: string; sceneSourceSha256: string } {
  const snapshotId = required(fields, 'snapshot');
  const sceneSourceSha256 = required(fields, 'source');
  const token = required(fields, 'token');
  if (snapshotId === null || sceneSourceSha256 === null || token === null) insufficient('场景探针日志缺少绑定字段。');
  if (snapshotId !== context.snapshotId) insufficient('场景探针日志来自旧快照。');
  if (sceneSourceSha256 !== context.sceneSourceSha256) insufficient('场景探针日志的场景源哈希不匹配。');
  if (!SHA256_PATTERN.test(token) || token !== createSceneProbeToken(context, purpose, selectedIds)) {
    insufficient('场景探针 token 与当前快照或选择集不匹配。');
  }
  return { token, snapshotId, sceneSourceSha256 };
}

function parseMeasurement(
  fields: ReadonlyMap<string, string>,
  line: number,
  context: SceneProbeContext,
  issues: SceneProbeIssue[],
): MeasurementProbeEntry | null {
  const startIssues = issues.length;
  const selectionIds = parseIdSet(required(fields, 'selection'));
  const id = parseId(required(fields, 'id'));
  if (selectionIds === null || id === null || !selectionIds.includes(id)) {
    issue(issues, line, 'YMAI_SCENE_PROBE', 'INVALID_ID_SET', '测量条目的选择集或实例 ID 无效。');
    return null;
  }
  const bound = validateBinding(fields, context, 'measurement', selectionIds);
  if (required(fields, 'status') !== 'ok') {
    issue(issues, line, 'YMAI_SCENE_PROBE', 'MALFORMED_ENTRY', '只有 status=ok 的测量可形成证据。');
    return null;
  }
  const elementTypeId = parseId(required(fields, 'type'));
  const position = parseVector(required(fields, 'position'));
  const rotation = parseVector(required(fields, 'rotation'));
  const scale = parseVector(required(fields, 'scale'));
  const sizeBox = parseVector(required(fields, 'sizeBox'));
  const meshCenter = parseVector(required(fields, 'meshCenter'));
  const visible = parseBoolean(required(fields, 'visible'));
  const physics = parseBoolean(required(fields, 'physics'));
  const collision = parseBoolean(required(fields, 'collision'));
  const canBeGrabbed = parseBoolean(required(fields, 'canBeGrabbed'));
  const parentText = required(fields, 'parent');
  const parentId = parentText === 'none' ? null : parseId(parentText);
  const childCount = parseFinite(required(fields, 'childCount'));
  if (
    elementTypeId === null || position === null || rotation === null || scale === null || sizeBox === null
    || meshCenter === null || visible === null || physics === null || collision === null || canBeGrabbed === null
    || (parentText !== 'none' && parentId === null) || childCount === null || !Number.isInteger(childCount) || childCount < 0
  ) issue(issues, line, 'YMAI_SCENE_PROBE', 'NON_FINITE_NUMBER', '测量字段缺失、非有限或类型无效。');
  if (issues.length !== startIssues) return null;
  return {
    kind: 'measurement', line, ...bound, selectionIds, id, status: 'ok', elementTypeId: elementTypeId!,
    position: position!, rotation: rotation!, scale: scale!, sizeBox: sizeBox!, meshCenter: meshCenter!,
    visible: visible!, physics: physics!, collision: collision!, canBeGrabbed: canBeGrabbed!, parentId,
    childCount: childCount!,
  };
}

function parseCapability(
  fields: ReadonlyMap<string, string>,
  line: number,
  context: SceneProbeContext,
  issues: SceneProbeIssue[],
): CapabilityProbeEntry | null {
  const selectionIds = parseIdSet(required(fields, 'selection'));
  const id = parseId(required(fields, 'id'));
  if (selectionIds === null || id === null || !selectionIds.includes(id)) {
    issue(issues, line, 'YMAI_SCENE_CAPABILITY', 'INVALID_ID_SET', '对象分类条目的选择集或实例 ID 无效。');
    return null;
  }
  const bound = validateBinding(fields, context, 'measurement', selectionIds);
  // Older private probes only emitted Element/LogicElement/TriggerBox. Treat
  // newly introduced families as unknown (error), never as a false absence.
  const characterState = fields.has('characterState')
    ? parseObjectFamilyState(required(fields, 'characterState')) : 'error';
  const creatureState = fields.has('creatureState')
    ? parseObjectFamilyState(required(fields, 'creatureState')) : 'error';
  const elementState = parseObjectFamilyState(required(fields, 'elementState'));
  const logicElementState = parseObjectFamilyState(required(fields, 'logicElementState'));
  const playerState = fields.has('playerState')
    ? parseObjectFamilyState(required(fields, 'playerState')) : 'error';
  const triggerBoxState = parseObjectFamilyState(required(fields, 'triggerBoxState'));
  const triggerSampleState = required(fields, 'triggerSampleState');
  const triggerSampleText = required(fields, 'triggerSample');
  const triggerSample = triggerSampleText === 'invalid' ? null : parseVector(triggerSampleText);
  if (
    required(fields, 'status') !== 'ok'
    || characterState === null || creatureState === null || elementState === null
    || logicElementState === null || playerState === null || triggerBoxState === null
    || (triggerSampleState !== 'ok' && triggerSampleState !== 'not-applicable' && triggerSampleState !== 'error')
    || (triggerSampleText !== 'invalid' && triggerSample === null)
    || (triggerSampleState === 'ok' && (triggerBoxState !== 'present' || triggerSample === null))
    || (triggerSampleState !== 'ok' && triggerSample !== null)
  ) {
    issue(issues, line, 'YMAI_SCENE_CAPABILITY', 'MALFORMED_ENTRY', '对象分类字段无效。');
    return null;
  }
  return {
    kind: 'capability', line, ...bound, selectionIds, id, status: 'ok',
    characterState, creatureState, elementState, logicElementState, playerState,
    triggerBoxState, triggerSampleState, triggerSample,
  };
}

const SCENE_FIELD_NAMES = new Set<SceneFieldProbeName>([
  'type', 'position', 'rotation', 'scale', 'sizeBox', 'meshCenter',
  'visible', 'physics', 'collision', 'canBeGrabbed', 'parent', 'childCount',
]);

function parseSceneFieldValue(field: SceneFieldProbeName, text: string): SceneFieldProbeValue | null {
  if (field === 'type') {
    const value = parseId(text);
    return value === null ? null : { kind: 'id', value };
  }
  if (field === 'position' || field === 'rotation' || field === 'scale' || field === 'sizeBox' || field === 'meshCenter') {
    const value = parseVector(text);
    return value === null ? null : { kind: 'vector', value };
  }
  if (field === 'visible' || field === 'physics' || field === 'collision' || field === 'canBeGrabbed') {
    const value = parseBoolean(text);
    return value === null ? null : { kind: 'boolean', value };
  }
  if (field === 'parent') {
    if (text === 'none') return { kind: 'optional-id', value: null };
    const value = parseId(text);
    return value === null ? null : { kind: 'optional-id', value };
  }
  const value = parseCount(text);
  return value === null ? null : { kind: 'count', value };
}

function parseSceneField(
  fields: ReadonlyMap<string, string>,
  line: number,
  context: SceneProbeContext,
  issues: SceneProbeIssue[],
): SceneFieldProbeEntry | null {
  const selectionIds = parseIdSet(required(fields, 'selection'));
  const id = parseId(required(fields, 'id'));
  const fieldText = required(fields, 'field');
  const status = required(fields, 'status');
  const valueText = required(fields, 'value');
  if (selectionIds === null || id === null || !selectionIds.includes(id)) {
    issue(issues, line, 'YMAI_SCENE_FIELD', 'INVALID_ID_SET', '字段探针的选择集或实例 ID 无效。');
    return null;
  }
  if (fieldText === null || !SCENE_FIELD_NAMES.has(fieldText as SceneFieldProbeName)
    || (status !== 'ok' && status !== 'error' && status !== 'not-applicable') || valueText === null) {
    issue(issues, line, 'YMAI_SCENE_FIELD', 'MALFORMED_ENTRY', '字段探针名称、状态或值无效。');
    return null;
  }
  const field = fieldText as SceneFieldProbeName;
  const value = status === 'ok' ? parseSceneFieldValue(field, valueText) : valueText === 'invalid' ? null : undefined;
  if (value === null && status === 'ok' || value === undefined) {
    issue(issues, line, 'YMAI_SCENE_FIELD', 'MALFORMED_ENTRY', '字段探针值与字段类型或状态不匹配。');
    return null;
  }
  const bound = validateBinding(fields, context, 'measurement', selectionIds);
  return { kind: 'field-capability', line, ...bound, selectionIds, id, field, status, value };
}

function parseOptionalIdSet(value: string | null): string[] | null {
  return value === 'none' ? [] : parseIdSet(value);
}

function parseCount(value: string | null): number | null {
  const parsed = parseFinite(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseGroupStructure(
  fields: ReadonlyMap<string, string>,
  line: number,
  context: SceneProbeContext,
  issues: SceneProbeIssue[],
): GroupStructureProbeEntry | null {
  const selectionIds = parseIdSet(required(fields, 'selection'));
  const groupId = parseId(required(fields, 'group'));
  if (selectionIds === null || groupId === null || !selectionIds.includes(groupId)) {
    issue(issues, line, 'YMAI_SCENE_GROUP', 'INVALID_ID_SET', '编组条目的选择集或编组 ID 无效。');
    return null;
  }
  const bound = validateBinding(fields, context, 'measurement', selectionIds);
  const immediateSuccess = parseBoolean(required(fields, 'immediateSuccess'));
  const recursiveSuccess = parseBoolean(required(fields, 'recursiveSuccess'));
  const immediateCount = parseCount(required(fields, 'immediateCount'));
  const recursiveCount = parseCount(required(fields, 'recursiveCount'));
  const immediateIds = parseOptionalIdSet(required(fields, 'immediate'));
  const recursiveIds = parseOptionalIdSet(required(fields, 'recursive'));
  const truncated = parseBoolean(required(fields, 'truncated'));
  const staticDirectIds = parseOptionalIdSet(required(fields, 'staticDirect'));
  const staticNestedGroupIds = parseOptionalIdSet(required(fields, 'staticNested'));
  if (
    required(fields, 'status') !== 'ok'
    || immediateSuccess === null || recursiveSuccess === null || immediateCount === null || recursiveCount === null
    || immediateIds === null || recursiveIds === null || truncated === null
    || staticDirectIds === null || staticNestedGroupIds === null
    || immediateIds.length > immediateCount || recursiveIds.length > recursiveCount
    || (!truncated && (immediateIds.length !== immediateCount || recursiveIds.length !== recursiveCount))
  ) {
    issue(issues, line, 'YMAI_SCENE_GROUP', 'MALFORMED_ENTRY', '编组查询字段无效或数量不一致。');
    return null;
  }
  return {
    kind: 'group-structure', line, ...bound, selectionIds, groupId, status: 'ok',
    immediateSuccess, recursiveSuccess, immediateCount, recursiveCount, immediateIds, recursiveIds, truncated,
    staticDirectIds, staticNestedGroupIds,
  };
}

function parseProperty(
  fields: ReadonlyMap<string, string>,
  line: number,
  context: SceneProbeContext,
  issues: SceneProbeIssue[],
): PropertyMatchProbeEntry | null {
  const selectionIds = parseIdSet(required(fields, 'selection'));
  const id = parseId(required(fields, 'id'));
  if (selectionIds === null || id === null || !selectionIds.includes(id)) {
    issue(issues, line, 'YMAI_PROPERTY_MATCH', 'INVALID_ID_SET', '属性匹配条目的选择集或实例 ID 无效。');
    return null;
  }
  const bound = validateBinding(fields, context, 'property', selectionIds);
  const propertyHash = required(fields, 'propertyHash');
  const propertyType = required(fields, 'propertyType');
  if (
    required(fields, 'status') !== 'match'
    || propertyHash === null || !SHA256_PATTERN.test(propertyHash)
    || propertyType === null || !PROPERTY_TYPES.has(propertyType)
  ) {
    issue(issues, line, 'YMAI_PROPERTY_MATCH', 'MALFORMED_ENTRY', '属性匹配字段无效。');
    return null;
  }
  return { kind: 'property-match', line, ...bound, selectionIds, id, status: 'match', propertyHash, propertyType };
}

function parseAlignment(
  fields: ReadonlyMap<string, string>,
  line: number,
  context: SceneProbeContext,
  issues: SceneProbeIssue[],
): AlignmentPlanProbeEntry | null {
  const supportId = parseId(required(fields, 'support'));
  const moverIds = parseIdSet(required(fields, 'movers'));
  if (supportId === null || moverIds === null || moverIds.includes(supportId)) {
    issue(issues, line, 'YMAI_AUTO_ALIGN', 'INVALID_ID_SET', '贴地证据的承载面或移动集合无效。');
  }
  const supportTopZ = parseFinite(required(fields, 'supportTopZ'));
  const lowestZ = parseFinite(required(fields, 'lowestZ'));
  const deltaZ = parseFinite(required(fields, 'deltaZ'));
  if (supportTopZ === null || lowestZ === null || deltaZ === null) {
    issue(issues, line, 'YMAI_AUTO_ALIGN', 'NON_FINITE_NUMBER', '贴地计划必须包含有限且有界的测量数值。');
  }
  if (supportId === null || moverIds === null || moverIds.includes(supportId) || supportTopZ === null || lowestZ === null || deltaZ === null) return null;
  const bound = validateBinding(fields, context, 'alignment', [supportId, ...moverIds]);
  if (required(fields, 'status') !== 'planned') {
    issue(issues, line, 'YMAI_AUTO_ALIGN', 'MALFORMED_ENTRY', '只有 status=planned 的贴地计划可形成执行证据。');
    return null;
  }
  return { kind: 'alignment-plan', line, ...bound, supportId, moverIds, status: 'planned', supportTopZ, lowestZ, deltaZ };
}

function entryKey(entry: SceneProbeEntry): string {
  if (entry.kind === 'measurement') return `measurement\0${entry.id}`;
  if (entry.kind === 'capability') return `capability\0${entry.id}`;
  if (entry.kind === 'field-capability') return `field\0${entry.id}\0${entry.field}`;
  if (entry.kind === 'group-structure') return `group\0${entry.groupId}`;
  if (entry.kind === 'property-match') return `property\0${entry.propertyHash}\0${entry.id}`;
  return `alignment\0${entry.supportId}\0${entry.moverIds.join(',')}`;
}

function comparable(entry: SceneProbeEntry): string {
  const rest: Partial<SceneProbeEntry> = { ...entry };
  delete rest.line;
  return stableJson(rest);
}

export function parseSceneProbeLog(bytes: Uint8Array, options: ParseSceneProbeOptions): SceneProbeEvidenceDocument {
  validateContext(options.context);
  if (bytes.byteLength > MAX_LOG_BYTES) {
    throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景探针日志超过 4 MiB 上限。', ['缩小到本次探针日志片段。'], 'STATIC_LOCAL');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  } catch (error) {
    throw new ProductError('INVALID_UTF8', '场景探针日志不是有效 UTF-8。', ['将日志转换为 UTF-8。'], 'STATIC_LOCAL', error);
  }
  const importedAt = options.importedAt ?? new Date().toISOString();
  if (!importedAt.endsWith('Z') || !Number.isFinite(Date.parse(importedAt))) {
    throw new ProductError('VALIDATION_FAILED', '场景证据导入时间无效。', ['使用 UTC ISO 8601 时间。'], 'STATIC_LOCAL');
  }
  const entries: SceneProbeEntry[] = [];
  const issues: SceneProbeIssue[] = [];
  const byKey = new Map<string, SceneProbeEntry>();
  let markerCount = 0;
  for (const [index, raw] of text.split('\n').entries()) {
    const markerMatch = MARKER_PATTERN.exec(raw);
    if (markerMatch === null) continue;
    markerCount += 1;
    const line = index + 1;
    const marker = markerMatch[1] as keyof typeof KEYS;
    if (raw.length > MAX_LINE_LENGTH) {
      issue(issues, line, marker, 'LINE_TOO_LONG', '场景探针日志行超过 4096 字符。');
      continue;
    }
    const fields = parseFields(raw.slice(markerMatch.index + markerMatch[0].length), line, marker, issues);
    if (fields === null) continue;
    const entry = marker === 'YMAI_SCENE_PROBE'
      ? parseMeasurement(fields, line, options.context, issues)
      : marker === 'YMAI_SCENE_CAPABILITY'
        ? parseCapability(fields, line, options.context, issues)
        : marker === 'YMAI_SCENE_FIELD'
          ? parseSceneField(fields, line, options.context, issues)
          : marker === 'YMAI_SCENE_GROUP'
            ? parseGroupStructure(fields, line, options.context, issues)
            : marker === 'YMAI_PROPERTY_MATCH'
              ? parseProperty(fields, line, options.context, issues)
              : parseAlignment(fields, line, options.context, issues);
    if (entry === null) continue;
    const key = entryKey(entry);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      issue(
        issues,
        line,
        marker,
        comparable(existing) === comparable(entry) ? 'DUPLICATE_ENTRY' : 'CONFLICTING_ENTRY',
        comparable(existing) === comparable(entry) ? '重复的场景探针证据。' : '同一目标出现互相冲突的场景探针证据。',
      );
      continue;
    }
    byKey.set(key, entry);
    entries.push(entry);
  }
  if (markerCount === 0) insufficient('日志中没有场景探针标记。');
  return { schemaVersion: 1, sourceHash: sha256Hex(bytes), importedAt, ...options.context, entries, issues };
}

function sameContext(document: SceneProbeEvidenceDocument, context: SceneProbeContext): boolean {
  return document.projectInstanceId === context.projectInstanceId
    && document.bindingId === context.bindingId
    && document.snapshotId === context.snapshotId
    && document.sceneSourceSha256 === context.sceneSourceSha256;
}

function capabilityComparable(value: SceneRuntimeCapabilityEvidence): string {
  return stableJson({
    instanceId: value.instanceId,
    snapshotId: value.snapshotId,
    sceneSourceSha256: value.sceneSourceSha256,
    characterState: value.characterState ?? 'error',
    creatureState: value.creatureState ?? 'error',
    elementState: value.elementState,
    logicElementState: value.logicElementState,
    playerState: value.playerState ?? 'error',
    triggerBoxState: value.triggerBoxState,
    triggerSampleState: value.triggerSampleState,
    triggerSample: value.triggerSample,
  });
}

function cloneFieldValue(value: SceneFieldProbeValue | null): SceneFieldProbeValue | null {
  if (value === null) return null;
  return value.kind === 'vector'
    ? { kind: 'vector', value: [...value.value] }
    : { ...value };
}

/**
 * Resolves imported object-family observations for one exact scene revision.
 * Errors and conflicting logs remain explicit uncertainty; they are never
 * coerced into an "absent" capability.
 */
export function resolveCapabilityEvidenceDocuments(
  documents: readonly SceneProbeEvidenceDocument[],
  context: SceneProbeContext,
): Map<string, CapabilityEvidenceResolution> {
  validateContext(context);
  const candidates = new Map<string, SceneRuntimeCapabilityEvidence[]>();
  const fieldCandidates = new Map<string, Map<SceneFieldProbeName, Array<Pick<SceneFieldProbeEntry, 'status' | 'value'>>>>();
  for (const document of documents) {
    if (!sameContext(document, context) || document.issues.length > 0) continue;
    for (const entry of document.entries) {
      if (entry.kind === 'field-capability') {
        const fields = fieldCandidates.get(entry.id) ?? new Map();
        const values = fields.get(entry.field) ?? [];
        values.push({ status: entry.status, value: cloneFieldValue(entry.value) });
        fields.set(entry.field, values);
        fieldCandidates.set(entry.id, fields);
        continue;
      }
      if (entry.kind !== 'capability') continue;
      const evidence: SceneRuntimeCapabilityEvidence = {
        instanceId: entry.id,
        snapshotId: entry.snapshotId,
        sceneSourceSha256: entry.sceneSourceSha256,
        importedAt: document.importedAt,
        characterState: entry.characterState,
        creatureState: entry.creatureState,
        elementState: entry.elementState,
        logicElementState: entry.logicElementState,
        playerState: entry.playerState,
        triggerBoxState: entry.triggerBoxState,
        triggerSampleState: entry.triggerSampleState,
        triggerSample: entry.triggerSample === null ? null : [...entry.triggerSample],
        fields: {},
        fieldConflicts: [],
      };
      const values = candidates.get(entry.id) ?? [];
      values.push(evidence);
      candidates.set(entry.id, values);
    }
  }
  const resolved = new Map<string, CapabilityEvidenceResolution>();
  for (const [instanceId, values] of candidates) {
    const fingerprints = new Set(values.map(capabilityComparable));
    if (fingerprints.size !== 1) {
      resolved.set(instanceId, { state: 'conflict', evidence: null });
      continue;
    }
    const selected = [...values].sort((left, right) => (
      right.importedAt.localeCompare(left.importedAt) || capabilityComparable(left).localeCompare(capabilityComparable(right), 'en')
    ))[0]!;
    const fields: ReadonlyMap<
      SceneFieldProbeName,
      Array<Pick<SceneFieldProbeEntry, 'status' | 'value'>>
    > = fieldCandidates.get(instanceId) ?? new Map();
    for (const [field, fieldValues] of fields) {
      const fingerprints = new Set(fieldValues.map((value) => stableJson(value)));
      if (fingerprints.size !== 1) {
        selected.fieldConflicts.push(field);
        continue;
      }
      const fieldValue = fieldValues[0]!;
      selected.fields[field] = { status: fieldValue.status, value: cloneFieldValue(fieldValue.value) };
    }
    selected.fieldConflicts.sort((left, right) => left.localeCompare(right, 'en'));
    resolved.set(instanceId, { state: 'unique', evidence: selected });
  }
  return resolved;
}

export function requireAlignmentPlanEvidence(
  document: SceneProbeEvidenceDocument,
  context: SceneProbeContext,
  supportId: string,
  moverIds: readonly string[],
): AlignmentPlanEvidence {
  validateContext(context);
  const movers = normalizeIds(moverIds);
  if (!ID_PATTERN.test(supportId) || movers.includes(supportId) || !sameContext(document, context) || document.issues.length > 0) {
    insufficient('贴地计划证据不足、存在冲突或不属于当前精确快照。');
  }
  const expectedToken = createSceneProbeToken(context, 'alignment', [supportId, ...movers]);
  const matches = document.entries.filter((entry): entry is AlignmentPlanProbeEntry => (
    entry.kind === 'alignment-plan'
    && entry.supportId === supportId
    && entry.moverIds.length === movers.length
    && entry.moverIds.every((id, index) => id === movers[index])
    && entry.token === expectedToken
  ));
  if (matches.length !== 1) insufficient('没有找到当前承载面和移动集合的唯一成功贴地计划。');
  const match = matches[0]!;
  return {
    token: match.token,
    supportId: match.supportId,
    moverIds: [...match.moverIds],
    supportTopZ: match.supportTopZ,
    lowestZ: match.lowestZ,
    deltaZ: match.deltaZ,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && [...expected].sort().every((key, index) => key === actual[index]);
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NUMBER;
}

function validStoredIdSet(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) return false;
  const normalized = parseIdSet(value.join(','));
  return normalized !== null && normalized.every((id, index) => id === value[index]);
}

function validStoredOptionalIdSet(value: unknown): value is string[] {
  return (Array.isArray(value) && value.length === 0) || validStoredIdSet(value);
}

function validStoredEntry(value: unknown): value is SceneProbeEntry {
  const entry = object(value);
  if (entry === null || !Number.isInteger(entry.line) || (entry.line as number) < 1) return false;
  const common = typeof entry.token === 'string' && SHA256_PATTERN.test(entry.token)
    && typeof entry.snapshotId === 'string' && SHA256_PATTERN.test(entry.snapshotId)
    && typeof entry.sceneSourceSha256 === 'string' && SHA256_PATTERN.test(entry.sceneSourceSha256);
  if (!common) return false;
  if (entry.kind === 'field-capability') {
    const field = entry.field as SceneFieldProbeName;
    const status = entry.status;
    const storedValue = object(entry.value);
    const validValue = status === 'ok' && storedValue !== null && (
      (field === 'type' && exactKeys(storedValue, ['kind', 'value']) && storedValue.kind === 'id' && typeof storedValue.value === 'string' && parseId(storedValue.value) !== null)
      || ((field === 'position' || field === 'rotation' || field === 'scale' || field === 'sizeBox' || field === 'meshCenter')
        && exactKeys(storedValue, ['kind', 'value']) && storedValue.kind === 'vector'
        && Array.isArray(storedValue.value) && storedValue.value.length === 3 && storedValue.value.every(validNumber))
      || ((field === 'visible' || field === 'physics' || field === 'collision' || field === 'canBeGrabbed')
        && exactKeys(storedValue, ['kind', 'value']) && storedValue.kind === 'boolean' && typeof storedValue.value === 'boolean')
      || (field === 'parent' && exactKeys(storedValue, ['kind', 'value']) && storedValue.kind === 'optional-id'
        && (storedValue.value === null || (typeof storedValue.value === 'string' && parseId(storedValue.value) !== null)))
      || (field === 'childCount' && exactKeys(storedValue, ['kind', 'value']) && storedValue.kind === 'count'
        && Number.isInteger(storedValue.value) && (storedValue.value as number) >= 0)
    );
    return exactKeys(entry, [
      'kind', 'line', 'token', 'snapshotId', 'sceneSourceSha256', 'selectionIds', 'id', 'field', 'status', 'value',
    ])
      && validStoredIdSet(entry.selectionIds)
      && parseId(entry.id as string) !== null && entry.selectionIds.includes(entry.id as string)
      && typeof entry.field === 'string' && SCENE_FIELD_NAMES.has(field)
      && (status === 'ok' || status === 'error' || status === 'not-applicable')
      && (status === 'ok' ? validValue : entry.value === null);
  }
  if (entry.kind === 'alignment-plan') {
    return exactKeys(entry, [
      'kind', 'line', 'token', 'snapshotId', 'sceneSourceSha256', 'supportId', 'moverIds', 'status',
      'supportTopZ', 'lowestZ', 'deltaZ',
    ])
      && entry.status === 'planned'
      && parseId(entry.supportId as string) !== null
      && validStoredIdSet(entry.moverIds) && !entry.moverIds.includes(entry.supportId as string)
      && validNumber(entry.supportTopZ) && validNumber(entry.lowestZ) && validNumber(entry.deltaZ);
  }
  if (entry.kind === 'capability') {
    return exactKeys(entry, [
      'kind', 'line', 'token', 'snapshotId', 'sceneSourceSha256', 'selectionIds', 'id', 'status',
      'characterState', 'creatureState', 'elementState', 'logicElementState', 'playerState',
      'triggerBoxState', 'triggerSampleState', 'triggerSample',
    ])
      && entry.status === 'ok'
      && validStoredIdSet(entry.selectionIds)
      && parseId(entry.id as string) !== null && entry.selectionIds.includes(entry.id as string)
      && [entry.characterState, entry.creatureState, entry.elementState, entry.logicElementState, entry.playerState, entry.triggerBoxState]
        .every((state) => state === 'present' || state === 'absent' || state === 'error')
      && (entry.triggerSampleState === 'ok' || entry.triggerSampleState === 'not-applicable' || entry.triggerSampleState === 'error')
      && (entry.triggerSample === null || (
        Array.isArray(entry.triggerSample) && entry.triggerSample.length === 3 && entry.triggerSample.every(validNumber)
      ))
      && (entry.triggerSampleState === 'ok'
        ? entry.triggerBoxState === 'present' && entry.triggerSample !== null
        : entry.triggerSample === null);
  }
  if (entry.kind === 'group-structure') {
    return exactKeys(entry, [
      'kind', 'line', 'token', 'snapshotId', 'sceneSourceSha256', 'selectionIds', 'groupId', 'status',
      'immediateSuccess', 'recursiveSuccess', 'immediateCount', 'recursiveCount', 'immediateIds', 'recursiveIds',
      'truncated', 'staticDirectIds', 'staticNestedGroupIds',
    ])
      && entry.status === 'ok'
      && validStoredIdSet(entry.selectionIds)
      && parseId(entry.groupId as string) !== null && entry.selectionIds.includes(entry.groupId as string)
      && typeof entry.immediateSuccess === 'boolean' && typeof entry.recursiveSuccess === 'boolean'
      && Number.isInteger(entry.immediateCount) && (entry.immediateCount as number) >= 0
      && Number.isInteger(entry.recursiveCount) && (entry.recursiveCount as number) >= 0
      && validStoredOptionalIdSet(entry.immediateIds) && validStoredOptionalIdSet(entry.recursiveIds)
      && typeof entry.truncated === 'boolean'
      && validStoredOptionalIdSet(entry.staticDirectIds) && validStoredOptionalIdSet(entry.staticNestedGroupIds)
      && entry.immediateIds.length <= (entry.immediateCount as number)
      && entry.recursiveIds.length <= (entry.recursiveCount as number)
      && (entry.truncated || (
        entry.immediateIds.length === entry.immediateCount && entry.recursiveIds.length === entry.recursiveCount
      ));
  }
  if (entry.kind === 'property-match') {
    return exactKeys(entry, [
      'kind', 'line', 'token', 'snapshotId', 'sceneSourceSha256', 'selectionIds', 'id', 'status',
      'propertyHash', 'propertyType',
    ])
      && entry.status === 'match'
      && validStoredIdSet(entry.selectionIds)
      && parseId(entry.id as string) !== null && entry.selectionIds.includes(entry.id as string)
      && typeof entry.propertyHash === 'string' && SHA256_PATTERN.test(entry.propertyHash)
      && typeof entry.propertyType === 'string' && PROPERTY_TYPES.has(entry.propertyType);
  }
  if (entry.kind !== 'measurement') return false;
  return exactKeys(entry, [
    'kind', 'line', 'token', 'snapshotId', 'sceneSourceSha256', 'selectionIds', 'id', 'status', 'elementTypeId',
    'position', 'rotation', 'scale', 'sizeBox', 'meshCenter', 'visible', 'physics', 'collision', 'canBeGrabbed',
    'parentId', 'childCount',
  ])
    && entry.status === 'ok'
    && validStoredIdSet(entry.selectionIds)
    && parseId(entry.id as string) !== null && entry.selectionIds.includes(entry.id as string)
    && parseId(entry.elementTypeId as string) !== null
    && [entry.position, entry.rotation, entry.scale, entry.sizeBox, entry.meshCenter].every((vector) => (
      Array.isArray(vector) && vector.length === 3 && vector.every(validNumber)
    ))
    && [entry.visible, entry.physics, entry.collision, entry.canBeGrabbed].every((flag) => typeof flag === 'boolean')
    && (entry.parentId === null || parseId(entry.parentId as string) !== null)
    && Number.isInteger(entry.childCount) && (entry.childCount as number) >= 0;
}

export function validateSceneProbeEvidence(value: unknown): asserts value is SceneProbeEvidenceDocument {
  const document = object(value);
  if (
    document === null
    || !exactKeys(document, [
      'schemaVersion', 'sourceHash', 'importedAt', 'projectInstanceId', 'bindingId', 'snapshotId',
      'sceneSourceSha256', 'entries', 'issues',
    ])
    || document.schemaVersion !== 1
    || typeof document.sourceHash !== 'string' || !SHA256_PATTERN.test(document.sourceHash)
    || typeof document.importedAt !== 'string' || !document.importedAt.endsWith('Z') || !Number.isFinite(Date.parse(document.importedAt))
    || typeof document.projectInstanceId !== 'string' || !UUID_PATTERN.test(document.projectInstanceId)
    || typeof document.bindingId !== 'string' || !SHA256_PATTERN.test(document.bindingId)
    || typeof document.snapshotId !== 'string' || !SHA256_PATTERN.test(document.snapshotId)
    || typeof document.sceneSourceSha256 !== 'string' || !SHA256_PATTERN.test(document.sceneSourceSha256)
    || !Array.isArray(document.entries) || !document.entries.every(validStoredEntry)
    || !Array.isArray(document.issues) || !document.issues.every((candidate) => {
      const storedIssue = object(candidate);
      return storedIssue !== null
        && exactKeys(storedIssue, ['line', 'marker', 'code', 'message'])
        && Number.isInteger(storedIssue.line) && (storedIssue.line as number) >= 1
        && (
          storedIssue.marker === null
          || storedIssue.marker === 'YMAI_SCENE_PROBE'
          || storedIssue.marker === 'YMAI_SCENE_CAPABILITY'
          || storedIssue.marker === 'YMAI_SCENE_GROUP'
          || storedIssue.marker === 'YMAI_PROPERTY_MATCH'
          || storedIssue.marker === 'YMAI_AUTO_ALIGN'
        )
        && typeof storedIssue.code === 'string' && ISSUE_CODES.has(storedIssue.code as SceneProbeIssue['code'])
        && typeof storedIssue.message === 'string';
    })
  ) {
    throw new ProductError('VALIDATION_FAILED', '场景探针证据文件字段无效。', ['重新导入当前快照的探针日志。'], 'STATIC_LOCAL');
  }
  const typed = value as SceneProbeEvidenceDocument;
  if (!typed.entries.every((entry) => {
    const purpose: SceneProbePurpose = entry.kind === 'measurement' || entry.kind === 'capability' || entry.kind === 'field-capability' || entry.kind === 'group-structure'
      ? 'measurement'
      : entry.kind === 'property-match'
        ? 'property'
        : 'alignment';
    const selectedIds = entry.kind === 'alignment-plan'
      ? [entry.supportId, ...entry.moverIds]
      : entry.selectionIds;
    return entry.snapshotId === typed.snapshotId
      && entry.sceneSourceSha256 === typed.sceneSourceSha256
      && entry.token === createSceneProbeToken(typed, purpose, selectedIds);
  })) {
    throw new ProductError('VALIDATION_FAILED', '场景探针证据绑定字段无效。', ['重新导入当前快照的探针日志。'], 'STATIC_LOCAL');
  }
}

export async function saveSceneProbeEvidence(
  projectRoot: string,
  document: SceneProbeEvidenceDocument,
  io: FileIO,
): Promise<string> {
  validateSceneProbeEvidence(document);
  const path = join(projectRoot, '.yuanmeng-inspector', 'scene', 'evidence', `${document.sourceHash}.json`);
  await atomicWriteJson(io, path, document, validateSceneProbeEvidence);
  return path;
}

export async function loadSceneProbeEvidence(path: string, io: FileIO): Promise<SceneProbeEvidenceDocument> {
  let value: unknown;
  try {
    value = JSON.parse(await io.readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new ProductError('VALIDATION_FAILED', '场景探针证据 JSON 已损坏。', ['重新导入当前快照的探针日志。'], 'STATIC_LOCAL', error);
  }
  // In-memory compatibility migration for schema-v1 documents saved before
  // Character/Creature/Player probing existed. The original file is never
  // rewritten, and unknown families remain explicit errors rather than false
  // absence claims.
  const stored = object(value);
  if (stored?.schemaVersion === 1 && Array.isArray(stored.entries)) {
    for (const candidate of stored.entries) {
      const entry = object(candidate);
      if (entry?.kind !== 'capability') continue;
      if (!Object.prototype.hasOwnProperty.call(entry, 'characterState')) entry.characterState = 'error';
      if (!Object.prototype.hasOwnProperty.call(entry, 'creatureState')) entry.creatureState = 'error';
      if (!Object.prototype.hasOwnProperty.call(entry, 'playerState')) entry.playerState = 'error';
    }
  }
  validateSceneProbeEvidence(value);
  return value;
}

export async function findStoredAlignmentPlanEvidence(
  projectRoot: string,
  context: SceneProbeContext,
  supportId: string,
  moverIds: readonly string[],
  io: FileIO,
): Promise<AlignmentPlanEvidence | null> {
  const directory = join(projectRoot, '.yuanmeng-inspector', 'scene', 'evidence');
  const matches: AlignmentPlanEvidence[] = [];
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => SHA256_PATTERN.test(name.replace(/\.json$/u, '')) && name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names) {
    try {
      const document = await loadSceneProbeEvidence(join(directory, name), io);
      matches.push(requireAlignmentPlanEvidence(document, context, supportId, moverIds));
    } catch (error) {
      if (error instanceof ProductError && (
        error.code === 'SCENE_EVIDENCE_INSUFFICIENT' || error.code === 'VALIDATION_FAILED'
      )) continue;
      throw error;
    }
  }
  if (matches.length === 0) return null;
  const first = matches[0]!;
  const fingerprint = stableJson(first);
  return matches.every((match) => stableJson(match) === fingerprint) ? first : null;
}

export async function loadStoredCapabilityEvidenceIndex(
  projectRoot: string,
  context: SceneProbeContext,
  io: FileIO,
): Promise<Map<string, CapabilityEvidenceResolution>> {
  const directory = join(projectRoot, '.yuanmeng-inspector', 'scene', 'evidence');
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => SHA256_PATTERN.test(name.replace(/\.json$/u, '')) && name.endsWith('.json'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  if (names.length > 2_000) {
    throw new ProductError('SCENE_LIMIT_EXCEEDED', '场景证据文件超过 2000 个上限。', ['先预览并清理旧证据缓存。'], 'STATIC_LOCAL');
  }
  const documents: SceneProbeEvidenceDocument[] = [];
  for (const name of names) {
    try {
      documents.push(await loadSceneProbeEvidence(join(directory, name), io));
    } catch (error) {
      if (error instanceof ProductError && error.code === 'VALIDATION_FAILED') continue;
      throw error;
    }
  }
  return resolveCapabilityEvidenceDocuments(documents, context);
}
