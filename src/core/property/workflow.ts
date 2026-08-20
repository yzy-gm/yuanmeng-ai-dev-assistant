import { ProductError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { parseLuaLiteralDocument, type LuaLiteralValue } from '../lua/literal-parser.js';
import type { RegistryRecord } from '../model.js';

export const UNKNOWN_MAP_WARNING = '地图身份未由官方确认' as const;

export interface PropertyTarget {
  projectInstanceId: string;
  mapFingerprint: string | null;
  layerId: string;
  uid: string;
  filename: string;
  warning: typeof UNKNOWN_MAP_WARNING | null;
}

export interface PropertyTargetInput {
  projectInstanceId: string;
  mapFingerprint: string | null;
  layers: readonly RegistryRecord[];
  instances: readonly RegistryRecord[];
}

export interface PropertySnapshot {
  schemaVersion: 1;
  createdAt: string;
  sha256: string;
  values: Record<string, string | number | boolean | null>;
}

export interface PropertySnapshotDiff {
  added: Array<{ path: string; value: string | number | boolean | null }>;
  removed: Array<{ path: string; value: string | number | boolean | null }>;
  changed: Array<{
    path: string;
    before: string | number | boolean | null;
    after: string | number | boolean | null;
  }>;
}

export type PropertyWorkflowState =
  | 'idle'
  | 'read-requested'
  | 'loaded'
  | 'edit-previewed'
  | 'file-written'
  | 'push-requested'
  | 'editor-verified';

function validation(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['检查工程、地图范围和注册记录后重试。'], 'STATIC_LOCAL');
}

function exactlyOne(records: readonly RegistryRecord[], label: string): RegistryRecord {
  if (records.length !== 1) validation(`${label}必须且只能选择一条记录。`);
  return records[0]!;
}

function assertCommon(record: RegistryRecord, projectInstanceId: string): void {
  if (record.projectInstanceId !== projectInstanceId) validation('属性目标记录属于其他工程。');
  if (record.validity !== 'pending' && record.validity !== 'confirmed') validation('属性目标记录状态不允许读取或推送。');
  if (!/^[0-9]+$/u.test(record.value)) validation('属性目标 ID 必须是十进制数字。');
}

export function selectPropertyTarget(input: PropertyTargetInput): PropertyTarget {
  const layer = exactlyOne(input.layers, '场景层');
  const instance = exactlyOne(input.instances, '元件实例');
  if (layer.kind !== 'scene-layer' || instance.kind !== 'scene-instance') validation('属性目标类型必须是场景层和元件实例。');
  assertCommon(layer, input.projectInstanceId);
  assertCommon(instance, input.projectInstanceId);
  if (instance.layerId !== layer.value) validation('元件实例必须明确登记到所选场景层。');

  let warning: typeof UNKNOWN_MAP_WARNING | null = null;
  if (input.mapFingerprint !== null) {
    if (layer.mapFingerprint !== input.mapFingerprint || instance.mapFingerprint !== input.mapFingerprint) {
      validation('属性目标地图指纹与当前地图不一致。');
    }
  } else {
    for (const record of [layer, instance]) {
      if (record.mapFingerprint !== null) validation('当前地图身份未知时不能使用绑定到未知其他地图的记录。');
      if (record.source.kind !== 'user-entry') validation('当前地图身份未知时只允许用户明确登记的记录。');
      if (record.environment !== 'test' && record.environment !== 'unspecified') {
        validation('当前地图身份未知时不能使用正式记录。');
      }
    }
    warning = UNKNOWN_MAP_WARNING;
  }
  return {
    projectInstanceId: input.projectInstanceId,
    mapFingerprint: input.mapFingerprint,
    layerId: layer.value,
    uid: instance.value,
    filename: `CustomProperty_${layer.value}_${instance.value}.lua`,
    warning,
  };
}

export function validatePropertyFilename(target: PropertyTarget, filename: string): true {
  if (!/^CustomProperty_[0-9]+_[0-9]+\.lua$/u.test(filename) || filename !== target.filename) {
    validation('属性文件名与已确认的单个 layerId/uid 目标不一致。');
  }
  return true;
}

function isoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(Date.parse(value))) validation('属性快照时间无效。');
}

export function createPropertySnapshot(source: string, createdAt: string): PropertySnapshot {
  isoDate(createdAt);
  const document = parseLuaLiteralDocument(source);
  const values: Record<string, string | number | boolean | null> = {};
  for (const literal of document.literals) values[literal.path] = literal.value;
  return { schemaVersion: 1, createdAt, sha256: sha256Hex(source), values };
}

export function diffPropertySnapshots(before: PropertySnapshot, after: PropertySnapshot): PropertySnapshotDiff {
  const added: PropertySnapshotDiff['added'] = [];
  const removed: PropertySnapshotDiff['removed'] = [];
  const changed: PropertySnapshotDiff['changed'] = [];
  const paths = [...new Set([...Object.keys(before.values), ...Object.keys(after.values)])].sort();
  for (const path of paths) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before.values, path);
    const hasAfter = Object.prototype.hasOwnProperty.call(after.values, path);
    if (!hasBefore) added.push({ path, value: after.values[path]! });
    else if (!hasAfter) removed.push({ path, value: before.values[path]! });
    else if (before.values[path] !== after.values[path]) {
      changed.push({ path, before: before.values[path]!, after: after.values[path]! });
    }
  }
  return { added, removed, changed };
}

export function searchPropertySnapshot(
  snapshot: PropertySnapshot,
  query: string,
): Array<{ path: string; value: string | number | boolean | null }> {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') validation('属性搜索词不能为空。');
  return Object.entries(snapshot.values)
    .filter(([path, value]) => `${path}\n${String(value)}`.toLocaleLowerCase().includes(needle))
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, value]) => ({ path, value }));
}

function encodeString(value: string): string {
  return `"${Array.from(value, (character) => {
    if (character === '\\') return '\\\\';
    if (character === '"') return '\\"';
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    const point = character.codePointAt(0)!;
    return point < 32 ? `\\${point.toString(10).padStart(3, '0')}` : character;
  }).join('')}"`;
}

function encodeLiteral(value: unknown): string {
  if (value === null) return 'nil';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  validation('属性编辑只允许 string、number、boolean 或 nil。');
}

export function editPropertyLiteral(source: string, path: string, value: LuaLiteralValue): string {
  const document = parseLuaLiteralDocument(source);
  const literal = document.literals.find((candidate) => candidate.path === path);
  if (literal === undefined) {
    const hasTable = document.entries.some((entry) => entry.path === path);
    if (hasTable) validation('不能把表或表达式替换为标量。');
    throw new ProductError('NOT_FOUND', `属性路径不存在：${path}`, ['选择已有的标量属性。'], 'STATIC_LOCAL');
  }
  const replacement = encodeLiteral(value);
  return `${source.slice(0, literal.range.startOffset)}${replacement}${source.slice(literal.range.endOffset)}`;
}

export class PropertyWorkflow {
  #state: PropertyWorkflowState = 'idle';

  get state(): PropertyWorkflowState { return this.#state; }

  #transition(from: PropertyWorkflowState, to: PropertyWorkflowState): void {
    if (this.#state !== from) validation(`属性流程状态错误：${this.#state} 不能进入 ${to}。`);
    this.#state = to;
  }

  requestRead(): void { this.#transition('idle', 'read-requested'); }
  load(): void { this.#transition('read-requested', 'loaded'); }
  previewEdit(): void { this.#transition('loaded', 'edit-previewed'); }

  writeFile(confirmed: boolean): void {
    if (!confirmed) throw new ProductError('CONFIRMATION_REQUIRED', '属性文件差异尚未确认。', ['先确认文件差异。'], 'STATIC_LOCAL');
    this.#transition('edit-previewed', 'file-written');
  }

  requestPush(confirmed: boolean): void {
    if (!confirmed) throw new ProductError('CONFIRMATION_REQUIRED', '属性推送尚未二次确认。', ['核对目标、哈希和摘要后再次确认。'], 'STATIC_LOCAL');
    this.#transition('file-written', 'push-requested');
  }

  commandResolved(): void {
    if (this.#state !== 'push-requested') validation('官方属性推送命令没有处于已请求状态。');
  }

  recordEditorVerification(): void { this.#transition('push-requested', 'editor-verified'); }
}
