import { TextDecoder } from 'node:util';

import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import type { UiNode, UiSnapshot } from '../model.js';

export interface UiGeometryProbeContext {
  projectInstanceId: string;
  uiSnapshotId: string;
}

export interface UiGeometryProbeIssue {
  line: number;
  marker: 'YMAI_UI_GEOMETRY_ENV' | 'YMAI_UI_GEOMETRY' | null;
  code: 'LINE_TOO_LONG' | 'MALFORMED_ENTRY' | 'UNKNOWN_KEY' | 'DUPLICATE_KEY' | 'INVALID_VALUE' | 'DUPLICATE_ENTRY' | 'CONFLICTING_ENTRY';
  message: string;
}

export interface UiRuntimeGeometryOkEntry {
  id: string;
  status: 'ok';
  position: { x: number; y: number };
  size: { x: number; y: number };
  anchored: { x: number; y: number; left: number; right: number; bottom: number; top: number };
  screenRect: { left: number; top: number; right: number; bottom: number };
  normalizedRect: { left: number; top: number; right: number; bottom: number };
  angle: number;
  center: { x: number; y: number };
  zOrder: number;
  parentId: string | null;
  centerHitId: string | null;
  renderScaleEvidence: 'unknown';
}

export interface UiRuntimeGeometryErrorEntry {
  id: string;
  status: 'error';
  reason: string;
}

export type UiRuntimeGeometryEntry = UiRuntimeGeometryOkEntry | UiRuntimeGeometryErrorEntry;

export interface UiRuntimeGeometryDocument extends UiGeometryProbeContext {
  schemaVersion: 1;
  sourceHash: string;
  runtimeSnapshotId: string;
  importedAt: string;
  token: string;
  selectedIds: string[];
  screenSize: { x: number; y: number };
  uiSystemSize: { x: number; y: number };
  evidence: 'STANDALONE_LOG';
  entries: UiRuntimeGeometryEntry[];
  issues: UiGeometryProbeIssue[];
}

export type UiLayoutIssueCode =
  | 'MEASUREMENT_FAILED'
  | 'INVALID_RECT'
  | 'OUT_OF_SCREEN'
  | 'PARTIALLY_CLIPPED'
  | 'CENTER_OCCLUDED'
  | 'POTENTIAL_SIBLING_OVERLAP';

export interface UiLayoutIssue {
  code: UiLayoutIssueCode;
  severity: 'error' | 'warning' | 'info';
  widgetIds: string[];
  message: string;
}

export interface UiLayoutAuditReport {
  schemaVersion: 1;
  uiSnapshotId: string;
  runtimeSnapshotId: string;
  screenSize: { x: number; y: number };
  evidence: 'STANDALONE_LOG';
  issues: UiLayoutIssue[];
  summary: Record<'error' | 'warning' | 'info', number>;
}

export interface UiLayoutAuditOptions {
  includePotentialSiblingOverlap?: boolean;
  siblingOverlapRatio?: number;
}

export function validateUiRuntimeGeometryDocument(
  value: unknown,
  context?: UiGeometryProbeContext,
): asserts value is UiRuntimeGeometryDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient('UI 运行时几何证据不是对象。');
  const document = value as Partial<UiRuntimeGeometryDocument>;
  if (
    document.schemaVersion !== 1
    || typeof document.projectInstanceId !== 'string'
    || !UUID_PATTERN.test(document.projectInstanceId)
    || typeof document.uiSnapshotId !== 'string'
    || !SHA256_PATTERN.test(document.uiSnapshotId)
    || typeof document.runtimeSnapshotId !== 'string'
    || !SHA256_PATTERN.test(document.runtimeSnapshotId)
    || typeof document.sourceHash !== 'string'
    || !SHA256_PATTERN.test(document.sourceHash)
    || document.evidence !== 'STANDALONE_LOG'
    || !Array.isArray(document.selectedIds)
    || document.selectedIds.length === 0
    || document.selectedIds.length > MAX_WIDGETS
    || document.selectedIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id))
    || !Array.isArray(document.entries)
    || !Array.isArray(document.issues)
    || typeof document.screenSize?.x !== 'number'
    || typeof document.screenSize.y !== 'number'
    || document.screenSize.x <= 0
    || document.screenSize.y <= 0
  ) insufficient('UI 运行时几何证据字段无效。');
  if (context !== undefined && (
    document.projectInstanceId !== context.projectInstanceId
    || document.uiSnapshotId !== context.uiSnapshotId
  )) insufficient('UI 运行时几何证据不属于当前工程和当前 UI 快照。');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^\d{1,20}$/u;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LINE_LENGTH = 4096;
const MAX_WIDGETS = 500;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;
const MARKER_PATTERN = /\[(YMAI_UI_GEOMETRY_ENV|YMAI_UI_GEOMETRY)\]/u;

const ALLOWED_KEYS = {
  YMAI_UI_GEOMETRY_ENV: new Set(['token', 'snapshot', 'selection', 'status', 'screenSize', 'uiSize', 'reason']),
  YMAI_UI_GEOMETRY: new Set([
    'token', 'snapshot', 'selection', 'id', 'status', 'position', 'size', 'anchored', 'screenRect',
    'normalizedRect', 'angle', 'center', 'zOrder', 'parent', 'centerHit', 'reason',
  ]),
} as const;

function insufficient(message: string): never {
  throw new ProductError(
    'UI_GEOMETRY_EVIDENCE_INSUFFICIENT',
    message,
    ['重新生成当前 UI 快照的只读屏幕几何探针，并导入同一次试玩日志。'],
    'STATIC_LOCAL',
  );
}

function validateContext(context: UiGeometryProbeContext): void {
  if (!UUID_PATTERN.test(context.projectInstanceId) || !SHA256_PATTERN.test(context.uiSnapshotId)) {
    throw new ProductError('VALIDATION_FAILED', 'UI 几何探针上下文无效。', ['先刷新当前工程 UI 快照。'], 'STATIC_LOCAL');
  }
}

function normalizeIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > MAX_WIDGETS || unique.some((id) => !ID_PATTERN.test(id))) {
    throw new ProductError('VALIDATION_FAILED', `UI 几何探针必须选择 1 到 ${MAX_WIDGETS} 个十进制控件 ID。`, ['缩小 UI 查询范围。'], 'STATIC_LOCAL');
  }
  return unique.sort((left, right) => left.localeCompare(right, 'en'));
}

function compareUiTreeNode(left: UiNode, right: UiNode): number {
  return left.siblingIndex - right.siblingIndex
    || left.path.localeCompare(right.path, 'zh-CN')
    || left.id.localeCompare(right.id, 'en');
}

/**
 * 按官方 UI 快照中的 parentId 关系读取一棵完整控件树。
 * path 只用于显示和稳定排序，绝不作为父子关系的推断依据。
 */
export function selectUiSubtree(
  snapshot: UiSnapshot,
  rootId: string,
  maxNodes = MAX_WIDGETS,
): UiNode[] {
  if (!ID_PATTERN.test(rootId) || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_WIDGETS) {
    throw new ProductError('VALIDATION_FAILED', 'UI 控件树查询参数无效。', ['重新选择弹窗根控件。'], 'STATIC_LOCAL');
  }

  const nodesById = new Map<string, UiNode>();
  const childrenByParent = new Map<string, UiNode[]>();
  for (const node of snapshot.nodes) {
    if (nodesById.has(node.id)) {
      throw new ProductError(
        'VALIDATION_FAILED',
        `UI 快照存在重复控件实例 ID：${node.id}。`,
        ['重新刷新 UI 快照后再读取弹窗布局。'],
        'STATIC_LOCAL',
      );
    }
    nodesById.set(node.id, node);
    if (node.parentId !== null) {
      const children = childrenByParent.get(node.parentId) ?? [];
      children.push(node);
      childrenByParent.set(node.parentId, children);
    }
  }
  const root = nodesById.get(rootId);
  if (root === undefined) {
    throw new ProductError('NOT_FOUND', `UI 快照中不存在根控件：${rootId}`, ['重新查找弹窗根控件。'], 'STATIC_LOCAL');
  }
  for (const children of childrenByParent.values()) children.sort(compareUiTreeNode);

  const selected: UiNode[] = [];
  const visited = new Set<string>();
  const pending: UiNode[] = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.id)) {
      throw new ProductError(
        'VALIDATION_FAILED',
        `UI 控件父子关系存在循环：${current.id}。`,
        ['重新刷新 UI 快照并检查官方导出的控件层级。'],
        'STATIC_LOCAL',
      );
    }
    visited.add(current.id);
    selected.push(current);
    if (selected.length > maxNodes) {
      throw new ProductError(
        'VALIDATION_FAILED',
        `控件树超过 ${maxNodes} 个节点，必须缩小查询范围。`,
        ['选择更深层的父控件后重试。'],
        'STATIC_LOCAL',
      );
    }
    const children = childrenByParent.get(current.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return selected;
}

export function createUiGeometryProbeToken(context: UiGeometryProbeContext, ids: readonly string[]): string {
  validateContext(context);
  return sha256Hex([
    context.projectInstanceId,
    context.uiSnapshotId,
    'ui-runtime-geometry-v1',
    normalizeIds(ids).join(','),
  ].join('\0'));
}

function luaString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\r/gu, '\\r').replace(/\n/gu, '\\n')}"`;
}

export function generateUiGeometryProbe(snapshot: UiSnapshot, ids: readonly string[]): string {
  const selectedIds = normalizeIds(ids);
  if (snapshot.projectInstanceId.trim() === '' || !SHA256_PATTERN.test(snapshot.snapshotId)) {
    throw new ProductError('VALIDATION_FAILED', '当前 UI 快照身份无效。', ['重新刷新 UI。'], 'STATIC_LOCAL');
  }
  const knownIds = new Set(snapshot.nodes.map((node) => node.id));
  const missing = selectedIds.filter((id) => !knownIds.has(id));
  if (missing.length > 0) {
    throw new ProductError('NOT_FOUND', `UI 快照中不存在控件：${missing.join(',')}`, ['重新按名称或路径查找控件。'], 'STATIC_LOCAL');
  }
  const context: UiGeometryProbeContext = { projectInstanceId: snapshot.projectInstanceId, uiSnapshotId: snapshot.snapshotId };
  const token = createUiGeometryProbeToken(context, selectedIds);
  const selection = selectedIds.join(',');
  const idLines = selectedIds.map((id) => `    ${id}`).join(',\n');
  return `--[[
元梦 AI 开发助手：UI 运行时屏幕几何只读探针
只查询当前 UI 快照中明确选择的控件；不修改显隐、位置、尺寸、锚点、层级或图片。
日志只证明本次客户端与本次分辨率下的官方 API 返回值，不代表其他设备或多人验收。
]]
local YMAI_UI_IDS = {
${idLines}
}
local YMAI_UI_COMMON = ${luaString(`token=${token} snapshot=${snapshot.snapshotId} selection=${selection}`)}

local function YMAI_Number(value)
    if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then error("non-finite") end
    return tostring(value)
end

local function YMAI_V2(value)
    if value == nil then error("nil-vector") end
    return YMAI_Number(value.X) .. "," .. YMAI_Number(value.Y)
end

local function YMAI_Center(value)
    if value == nil then error("nil-center") end
    return YMAI_Number(value.AlignmentX) .. "," .. YMAI_Number(value.AlignmentY)
end

local function YMAI_Anchored(value)
    if value == nil then error("nil-anchored") end
    return table.concat({
        YMAI_Number(value.X), YMAI_Number(value.Y), YMAI_Number(value.Left),
        YMAI_Number(value.Right), YMAI_Number(value.Bottom), YMAI_Number(value.Top)
    }, ",")
end

local function YMAI_Run()
    local envOk, screenSize, uiSize = pcall(function()
        return MiscService:GetLocalScreenSize(), UI:GetUISize()
    end)
    if not envOk or screenSize == nil or uiSize == nil then
        Log:PrintWarning("[YMAI_UI_GEOMETRY_ENV] " .. YMAI_UI_COMMON .. " status=error reason=api-failed")
        return
    end
    Log:PrintLog(
        "[YMAI_UI_GEOMETRY_ENV] " .. YMAI_UI_COMMON
        .. " status=ok screenSize=" .. YMAI_V2(screenSize)
        .. " uiSize=" .. YMAI_V2(uiSize)
    )
    for _, itemId in ipairs(YMAI_UI_IDS) do
        local ok, payload = pcall(function()
            local position = UI:GetPosition(itemId)
            local size = UI:GetSize(itemId)
            local anchored = UI:GetAnchoredPosition(itemId)
            local topLeft = UI:UIPositionToScreenPosition(position, itemId)
            local bottomRight = UI:UIPositionToScreenPosition({X = position.X + size.X, Y = position.Y + size.Y}, itemId)
            local normalizedTopLeft = MiscService:NormalizeLocalScreenPos(topLeft.X, topLeft.Y)
            local normalizedBottomRight = MiscService:NormalizeLocalScreenPos(bottomRight.X, bottomRight.Y)
            local centerScreen = {X = (topLeft.X + bottomRight.X) / 2, Y = (topLeft.Y + bottomRight.Y) / 2}
            return {
                position = YMAI_V2(position),
                size = YMAI_V2(size),
                anchored = YMAI_Anchored(anchored),
                screenRect = table.concat({YMAI_Number(topLeft.X), YMAI_Number(topLeft.Y), YMAI_Number(bottomRight.X), YMAI_Number(bottomRight.Y)}, ","),
                normalizedRect = table.concat({YMAI_Number(normalizedTopLeft.X), YMAI_Number(normalizedTopLeft.Y), YMAI_Number(normalizedBottomRight.X), YMAI_Number(normalizedBottomRight.Y)}, ","),
                angle = YMAI_Number(UI:GetAngle(itemId)),
                center = YMAI_Center(UI:GetWidgetCenter(itemId)),
                zOrder = YMAI_Number(UI:GetWidgetZOrder(itemId)),
                parent = UI:GetParent(itemId),
                centerHit = UI:CheckWidgetByScreenPosition(centerScreen, false, 0),
            }
        end)
        if not ok then
            Log:PrintWarning("[YMAI_UI_GEOMETRY] " .. YMAI_UI_COMMON .. " id=" .. tostring(itemId) .. " status=error reason=api-failed")
        else
            Log:PrintLog(
                "[YMAI_UI_GEOMETRY] " .. YMAI_UI_COMMON
                .. " id=" .. tostring(itemId) .. " status=ok"
                .. " position=" .. payload.position
                .. " size=" .. payload.size
                .. " anchored=" .. payload.anchored
                .. " screenRect=" .. payload.screenRect
                .. " normalizedRect=" .. payload.normalizedRect
                .. " angle=" .. payload.angle
                .. " center=" .. payload.center
                .. " zOrder=" .. payload.zOrder
                .. " parent=" .. (payload.parent == nil and "none" or tostring(payload.parent))
                .. " centerHit=" .. (payload.centerHit == nil and "none" or tostring(payload.centerHit))
            )
        end
    end
end

System:RegisterEvent(Events.ON_BEGIN_PLAY, function()
    if not System:IsServer() then TimerManager:AddFrame(10, YMAI_Run) end
end)
`;
}

export function containsUiGeometryMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_LOG_BYTES) return false;
  try {
    return MARKER_PATTERN.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

function issue(
  issues: UiGeometryProbeIssue[],
  line: number,
  marker: UiGeometryProbeIssue['marker'],
  code: UiGeometryProbeIssue['code'],
  message: string,
): void {
  issues.push({ line, marker, code, message });
}

function parseFields(
  text: string,
  line: number,
  marker: keyof typeof ALLOWED_KEYS,
  issues: UiGeometryProbeIssue[],
): Map<string, string> | null {
  const fields = new Map<string, string>();
  let valid = true;
  for (const part of text.trim().split(/\s+/u).filter(Boolean)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([^\s=]+)$/u.exec(part);
    if (match === null) {
      issue(issues, line, marker, 'MALFORMED_ENTRY', '字段必须使用无空白 key=value。');
      valid = false;
      continue;
    }
    const key = match[1]!;
    if (!ALLOWED_KEYS[marker].has(key)) {
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

function finite(value: string | undefined): number | null {
  if (value === undefined || !NUMBER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_ABSOLUTE_NUMBER ? parsed : null;
}

function vector(value: string | undefined, length: number): number[] | null {
  if (value === undefined) return null;
  const values = value.split(',').map((part) => finite(part));
  return values.length === length && values.every((part) => part !== null) ? values as number[] : null;
}

function optionalId(value: string | undefined): string | null | undefined {
  if (value === 'none') return null;
  if (value !== undefined && ID_PATTERN.test(value)) return value;
  return undefined;
}

function idSet(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const ids = value.split(',');
  if (ids.length === 0 || ids.some((id) => !ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) return null;
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

function bindFields(
  fields: ReadonlyMap<string, string>,
  context: UiGeometryProbeContext,
): { token: string; selectedIds: string[] } {
  if (fields.get('snapshot') !== context.uiSnapshotId) insufficient('UI 几何日志来自其他 UI 快照。');
  const selectedIds = idSet(fields.get('selection'));
  if (selectedIds === null) insufficient('UI 几何日志选择集无效。');
  const token = fields.get('token');
  if (token !== createUiGeometryProbeToken(context, selectedIds)) insufficient('UI 几何日志 token 与当前工程不匹配。');
  return { token, selectedIds };
}

export function parseUiGeometryProbeLog(
  bytes: Uint8Array,
  options: { context: UiGeometryProbeContext; importedAt?: string },
): UiRuntimeGeometryDocument {
  validateContext(options.context);
  if (bytes.byteLength > MAX_LOG_BYTES) insufficient('UI 几何日志超过 4 MiB 上限。');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
  } catch {
    insufficient('UI 几何日志不是有效 UTF-8。');
  }
  const issues: UiGeometryProbeIssue[] = [];
  const entriesById = new Map<string, UiRuntimeGeometryEntry>();
  let environment: { token: string; selectedIds: string[]; screenSize: { x: number; y: number }; uiSystemSize: { x: number; y: number } } | null = null;
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const markerMatch = /\[(YMAI_UI_GEOMETRY_ENV|YMAI_UI_GEOMETRY)\]\s*(.*)$/u.exec(raw);
    if (markerMatch === null) continue;
    const line = index + 1;
    const marker = markerMatch[1] as keyof typeof ALLOWED_KEYS;
    if (raw.length > MAX_LINE_LENGTH) {
      issue(issues, line, marker, 'LINE_TOO_LONG', '日志行超过 4096 字符。');
      continue;
    }
    const fields = parseFields(markerMatch[2]!, line, marker, issues);
    if (fields === null) continue;
    const binding = bindFields(fields, options.context);
    if (marker === 'YMAI_UI_GEOMETRY_ENV') {
      if (fields.get('status') !== 'ok') insufficient('UI 运行时没有成功读取屏幕环境。');
      const rawScreen = vector(fields.get('screenSize'), 2);
      const rawUi = vector(fields.get('uiSize'), 2);
      if (rawScreen === null || rawUi === null || rawScreen.some((value) => value <= 0) || rawUi.some((value) => value <= 0)) {
        issue(issues, line, marker, 'INVALID_VALUE', '屏幕或 UI 系统分辨率无效。');
        continue;
      }
      const candidate = {
        token: binding.token,
        selectedIds: binding.selectedIds,
        screenSize: { x: rawScreen[0]!, y: rawScreen[1]! },
        uiSystemSize: { x: rawUi[0]!, y: rawUi[1]! },
      };
      if (environment !== null && stableJson(environment) !== stableJson(candidate)) {
        issue(issues, line, marker, 'CONFLICTING_ENTRY', '同一日志包含冲突的屏幕环境。');
      } else if (environment !== null) {
        issue(issues, line, marker, 'DUPLICATE_ENTRY', '屏幕环境重复。');
      } else {
        environment = candidate;
      }
      continue;
    }

    const id = fields.get('id');
    const status = fields.get('status');
    if (id === undefined || !ID_PATTERN.test(id) || !binding.selectedIds.includes(id) || (status !== 'ok' && status !== 'error')) {
      issue(issues, line, marker, 'INVALID_VALUE', '控件 ID、选择集或状态无效。');
      continue;
    }
    let entry: UiRuntimeGeometryEntry | null = null;
    if (status === 'error') {
      const reason = fields.get('reason');
      if (reason === undefined || !/^[a-z0-9-]{1,64}$/u.test(reason)) {
        issue(issues, line, marker, 'INVALID_VALUE', '失败原因无效。');
        continue;
      }
      entry = { id, status, reason };
    } else {
      const position = vector(fields.get('position'), 2);
      const size = vector(fields.get('size'), 2);
      const anchored = vector(fields.get('anchored'), 6);
      const screenRect = vector(fields.get('screenRect'), 4);
      const normalizedRect = vector(fields.get('normalizedRect'), 4);
      const angle = finite(fields.get('angle'));
      const center = vector(fields.get('center'), 2);
      const zOrder = finite(fields.get('zOrder'));
      const parentId = optionalId(fields.get('parent'));
      const centerHitId = optionalId(fields.get('centerHit'));
      if ([position, size, anchored, screenRect, normalizedRect, center].some((value) => value === null)
        || angle === null || zOrder === null || parentId === undefined || centerHitId === undefined) {
        issue(issues, line, marker, 'INVALID_VALUE', `控件 ${id} 的几何字段无效。`);
        continue;
      }
      entry = {
        id,
        status,
        position: { x: position![0]!, y: position![1]! },
        size: { x: size![0]!, y: size![1]! },
        anchored: { x: anchored![0]!, y: anchored![1]!, left: anchored![2]!, right: anchored![3]!, bottom: anchored![4]!, top: anchored![5]! },
        screenRect: { left: screenRect![0]!, top: screenRect![1]!, right: screenRect![2]!, bottom: screenRect![3]! },
        normalizedRect: { left: normalizedRect![0]!, top: normalizedRect![1]!, right: normalizedRect![2]!, bottom: normalizedRect![3]! },
        angle,
        center: { x: center![0]!, y: center![1]! },
        zOrder,
        parentId,
        centerHitId,
        renderScaleEvidence: 'unknown',
      };
    }
    const previous = entriesById.get(id);
    if (previous !== undefined) {
      issue(issues, line, marker, stableJson(previous) === stableJson(entry) ? 'DUPLICATE_ENTRY' : 'CONFLICTING_ENTRY', `控件 ${id} 的测量记录重复或冲突。`);
    } else {
      entriesById.set(id, entry);
    }
  }
  if (environment === null) insufficient('日志中没有当前快照的有效 UI 屏幕环境。');
  const entries = [...entriesById.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const importedAt = options.importedAt ?? new Date().toISOString();
  const sourceHash = sha256Hex(bytes);
  const body = {
    schemaVersion: 1 as const,
    sourceHash,
    importedAt,
    ...options.context,
    token: environment.token,
    selectedIds: environment.selectedIds,
    screenSize: environment.screenSize,
    uiSystemSize: environment.uiSystemSize,
    evidence: 'STANDALONE_LOG' as const,
    entries,
    issues,
  };
  return { ...body, runtimeSnapshotId: sha256Hex(stableJson(body)) };
}

function isDescendant(node: UiNode, possibleAncestorId: string, byId: ReadonlyMap<string, UiNode>): boolean {
  const visited = new Set<string>();
  let parentId = node.parentId;
  while (parentId !== null && !visited.has(parentId)) {
    if (parentId === possibleAncestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

function overlapRatio(left: UiRuntimeGeometryOkEntry['screenRect'], right: UiRuntimeGeometryOkEntry['screenRect']): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const overlap = width * height;
  const leftArea = Math.max(0, left.right - left.left) * Math.max(0, left.bottom - left.top);
  const rightArea = Math.max(0, right.right - right.left) * Math.max(0, right.bottom - right.top);
  const denominator = Math.min(leftArea, rightArea);
  return denominator <= 0 ? 0 : overlap / denominator;
}

export function auditUiRuntimeGeometry(
  document: UiRuntimeGeometryDocument,
  snapshot: UiSnapshot,
  options: UiLayoutAuditOptions = {},
): UiLayoutAuditReport {
  if (document.uiSnapshotId !== snapshot.snapshotId || document.projectInstanceId !== snapshot.projectInstanceId) {
    insufficient('布局体检的运行时证据不属于当前 UI 快照。');
  }
  const threshold = options.siblingOverlapRatio ?? 0.5;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new ProductError('VALIDATION_FAILED', '兄弟控件重叠比例必须大于 0 且不超过 1。', [], 'STATIC_LOCAL');
  }
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const childCounts = new Map<string, number>();
  for (const node of snapshot.nodes) if (node.parentId !== null) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  const issues: UiLayoutIssue[] = [];
  const validEntries: UiRuntimeGeometryOkEntry[] = [];
  for (const id of document.selectedIds) {
    const entry = document.entries.find((candidate) => candidate.id === id);
    if (entry === undefined || entry.status === 'error') {
      issues.push({ code: 'MEASUREMENT_FAILED', severity: 'warning', widgetIds: [id], message: `控件 ${id} 未取得有效运行时几何。` });
      continue;
    }
    const rect = entry.screenRect;
    if (rect.right <= rect.left || rect.bottom <= rect.top) {
      issues.push({ code: 'INVALID_RECT', severity: 'error', widgetIds: [id], message: `控件 ${id} 的屏幕矩形退化或方向无效。` });
      continue;
    }
    validEntries.push(entry);
    const outside = rect.right <= 0 || rect.bottom <= 0 || rect.left >= document.screenSize.x || rect.top >= document.screenSize.y;
    const clipped = rect.left < 0 || rect.top < 0 || rect.right > document.screenSize.x || rect.bottom > document.screenSize.y;
    if (outside) {
      issues.push({ code: 'OUT_OF_SCREEN', severity: 'error', widgetIds: [id], message: `控件 ${id} 完全位于屏幕外。` });
    } else if (clipped) {
      issues.push({ code: 'PARTIALLY_CLIPPED', severity: 'warning', widgetIds: [id], message: `控件 ${id} 部分超出屏幕。` });
    }
    if (childCounts.get(id) === undefined && entry.centerHitId !== null && entry.centerHitId !== id) {
      const node = nodesById.get(id);
      if (node === undefined || !isDescendant(node, entry.centerHitId, nodesById)) {
        issues.push({ code: 'CENTER_OCCLUDED', severity: 'warning', widgetIds: [id, entry.centerHitId], message: `控件 ${id} 中心点首先命中控件 ${entry.centerHitId}。` });
      }
    }
  }
  if (options.includePotentialSiblingOverlap === true) {
    for (let leftIndex = 0; leftIndex < validEntries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < validEntries.length; rightIndex += 1) {
        const left = validEntries[leftIndex]!;
        const right = validEntries[rightIndex]!;
        const leftNode = nodesById.get(left.id);
        const rightNode = nodesById.get(right.id);
        if (leftNode === undefined || rightNode === undefined || leftNode.parentId !== rightNode.parentId) continue;
        if (overlapRatio(left.screenRect, right.screenRect) < threshold) continue;
        issues.push({
          code: 'POTENTIAL_SIBLING_OVERLAP',
          severity: 'info',
          widgetIds: [left.id, right.id].sort((a, b) => a.localeCompare(b, 'en')),
          message: `同父级控件 ${left.id} 与 ${right.id} 存在显著重叠；可能是有意叠放，需结合画面确认。`,
        });
      }
    }
  }
  issues.sort((left, right) => left.code.localeCompare(right.code, 'en') || left.widgetIds.join(',').localeCompare(right.widgetIds.join(','), 'en'));
  const summary = { error: 0, warning: 0, info: 0 };
  for (const item of issues) summary[item.severity] += 1;
  return {
    schemaVersion: 1,
    uiSnapshotId: snapshot.snapshotId,
    runtimeSnapshotId: document.runtimeSnapshotId,
    screenSize: document.screenSize,
    evidence: document.evidence,
    issues,
    summary,
  };
}
