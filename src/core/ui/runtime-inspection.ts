import { TextDecoder } from 'node:util';

import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import type { UiNode, UiSnapshot } from '../model.js';

export interface UiRuntimeProbeContext {
  projectInstanceId: string;
  uiSnapshotId: string;
}

export interface UiScreenPointRequest {
  x: number;
  y: number;
  includeGroup: boolean;
  groupId: string;
}

export interface UiScreenPointDocument extends UiRuntimeProbeContext {
  schemaVersion: 1;
  runtimeSnapshotId: string;
  sourceHash: string;
  importedAt: string;
  token: string;
  request: UiScreenPointRequest;
  screenSize: { x: number; y: number };
  uiSystemSize: { x: number; y: number };
  hitId: string | null;
  hit: { classification: 'static'; node: UiNode } | { classification: 'dynamic'; node: null } | null;
  evidence: 'STANDALONE_LOG';
}

export type UiRuntimeWidgetOrigin = 'tree' | 'duplicate' | 'list-item';

export interface UiRuntimeWidgetEntry {
  id: string;
  parentId: string | null;
  name: string | null;
  zOrder: number | null;
  classification: 'static' | 'dynamic';
  origins: UiRuntimeWidgetOrigin[];
  duplicate: { templateId: string } | null;
  listItem: { listViewId: string; itemId: string; templateChildId: string } | null;
}

export interface UiRuntimeWidgetDocument extends UiRuntimeProbeContext {
  schemaVersion: 1;
  runtimeSnapshotId: string;
  sourceHash: string;
  importedAt: string;
  token: string;
  rootId: string;
  truncated: boolean;
  evidence: 'STANDALONE_LOG';
  entries: UiRuntimeWidgetEntry[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^\d{1,20}$/u;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const MARKER_PATTERN = /\[(YMAI_UI_SCREEN_POINT_ENV|YMAI_UI_SCREEN_POINT|YMAI_UI_RUNTIME_TREE_ENV|YMAI_UI_RUNTIME_WIDGET|YMAI_UI_DYNAMIC_DUPLICATE|YMAI_UI_LIST_ITEM)\]/u;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LINE_LENGTH = 4096;
const MAX_WIDGETS = 500;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;

function insufficient(message: string): never {
  throw new ProductError(
    'UI_RUNTIME_EVIDENCE_INSUFFICIENT',
    message,
    ['重新生成当前工程、当前 UI 快照的受控只读探针，并导入同一次试玩日志。'],
    'STATIC_LOCAL',
  );
}

function validateContext(context: UiRuntimeProbeContext): void {
  if (!UUID_PATTERN.test(context.projectInstanceId) || !SHA256_PATTERN.test(context.uiSnapshotId)) {
    throw new ProductError('VALIDATION_FAILED', 'UI 运行时探针上下文无效。', ['先刷新当前工程 UI 快照。'], 'STATIC_LOCAL');
  }
}

function contextOf(snapshot: UiSnapshot): UiRuntimeProbeContext {
  const context = { projectInstanceId: snapshot.projectInstanceId, uiSnapshotId: snapshot.snapshotId };
  validateContext(context);
  return context;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NUMBER;
}

function validatePointRequest(request: UiScreenPointRequest): void {
  if (!finite(request.x) || !finite(request.y) || request.x < 0 || request.y < 0 || !ID_PATTERN.test(request.groupId)) {
    throw new ProductError('VALIDATION_FAILED', '屏幕点或控件组 ID 无效。', ['使用非负有限屏幕坐标和十进制控件组 ID。'], 'STATIC_LOCAL');
  }
  if (request.includeGroup && request.groupId === '0') {
    throw new ProductError('VALIDATION_FAILED', '启用控件组命中时必须提供非零控件组 ID。', [], 'STATIC_LOCAL');
  }
}

function luaBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

function luaNumber(value: number): string {
  if (!finite(value)) throw new ProductError('VALIDATION_FAILED', 'Lua 数值无效。', [], 'STATIC_LOCAL');
  return String(value);
}

function luaString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\r/gu, '\\r').replace(/\n/gu, '\\n')}"`;
}

export function createUiScreenPointProbeToken(context: UiRuntimeProbeContext, request: UiScreenPointRequest): string {
  validateContext(context);
  validatePointRequest(request);
  return sha256Hex([
    context.projectInstanceId,
    context.uiSnapshotId,
    'ui-screen-point-v1',
    String(request.x),
    String(request.y),
    String(request.includeGroup),
    request.groupId,
  ].join('\0'));
}

export function createUiRuntimeWidgetProbeToken(context: UiRuntimeProbeContext, rootId: string): string {
  validateContext(context);
  if (!ID_PATTERN.test(rootId)) throw new ProductError('VALIDATION_FAILED', '运行时 UI 根控件 ID 无效。', [], 'STATIC_LOCAL');
  return sha256Hex([context.projectInstanceId, context.uiSnapshotId, 'ui-runtime-widgets-v1', rootId].join('\0'));
}

export function generateUiScreenPointProbe(snapshot: UiSnapshot, request: UiScreenPointRequest): string {
  const context = contextOf(snapshot);
  validatePointRequest(request);
  const token = createUiScreenPointProbeToken(context, request);
  const point = `${request.x},${request.y}`;
  const includeGroup = luaBoolean(request.includeGroup);
  return `--[[
元梦 AI 开发助手：指定屏幕点只读命中探针
只读取本次客户端分辨率、UI 系统分辨率与该点首个命中控件，不修改任何 UI。
]]
local YMAI_COMMON = ${luaString(`token=${token} snapshot=${snapshot.snapshotId} point=${point} includeGroup=${request.includeGroup} group=${request.groupId}`)}

local function YMAI_V2(value)
    if value == nil then error("nil-vector") end
    return tostring(value.X) .. "," .. tostring(value.Y)
end

local function YMAI_Run()
    local envOk, screenSize, uiSize = pcall(function()
        return MiscService:GetLocalScreenSize(), UI:GetUISize()
    end)
    if not envOk or screenSize == nil or uiSize == nil then
        Log:PrintWarning("[YMAI_UI_SCREEN_POINT_ENV] " .. YMAI_COMMON .. " status=error reason=api-failed")
        return
    end
    Log:PrintLog("[YMAI_UI_SCREEN_POINT_ENV] " .. YMAI_COMMON .. " status=ok screenSize=" .. YMAI_V2(screenSize) .. " uiSize=" .. YMAI_V2(uiSize))
    local ok, hitId = pcall(function()
        return UI:CheckWidgetByScreenPosition({X = ${luaNumber(request.x)}, Y = ${luaNumber(request.y)}}, ${includeGroup}, ${request.groupId})
    end)
    if not ok then
        Log:PrintWarning("[YMAI_UI_SCREEN_POINT] " .. YMAI_COMMON .. " status=error reason=api-failed")
    else
        Log:PrintLog("[YMAI_UI_SCREEN_POINT] " .. YMAI_COMMON .. " status=ok hit=" .. (hitId == nil and "none" or tostring(hitId)))
    end
end

System:RegisterEvent(Events.ON_BEGIN_PLAY, function()
    if not System:IsServer() then TimerManager:AddFrame(10, YMAI_Run) end
end)
`;
}

export function generateUiRuntimeWidgetProbe(snapshot: UiSnapshot, rootId: string): string {
  const context = contextOf(snapshot);
  if (!snapshot.nodes.some((node) => node.id === rootId)) {
    throw new ProductError('NOT_FOUND', `UI 快照中不存在根控件：${rootId}`, ['先用名称或完整路径解析根控件。'], 'STATIC_LOCAL');
  }
  const token = createUiRuntimeWidgetProbeToken(context, rootId);
  return `--[[
元梦 AI 开发助手：运行时 UI 树与动态 ID 只读探针
树扫描最多读取 500 个可见控件；不会复制、删除、移动或修改控件。
Duplicate/ListItem 记录函数只登记调用方已经取得的官方返回 ID，不主动调用创建 API。
]]
local YMAI_MAX_WIDGETS = 500
local YMAI_ROOT_ID = ${rootId}
local YMAI_COMMON = ${luaString(`token=${token} snapshot=${snapshot.snapshotId} root=${rootId}`)}

local function YMAI_Encode(value)
    return (string.gsub(tostring(value), "[^%w%-._~]", function(char)
        return string.format("%%%02X", string.byte(char))
    end))
end

local YMAI_RuntimeUiTrace = {}
function YMAI_RuntimeUiTrace.Duplicate(templateId, newId, parentId)
    Log:PrintLog("[YMAI_UI_DYNAMIC_DUPLICATE] " .. YMAI_COMMON
        .. " id=" .. tostring(newId) .. " template=" .. tostring(templateId)
        .. " parent=" .. (parentId == nil and "none" or tostring(parentId)))
end
function YMAI_RuntimeUiTrace.ListItem(listViewId, itemId, templateChildId, runtimeId, parentId, name)
    Log:PrintLog("[YMAI_UI_LIST_ITEM] " .. YMAI_COMMON
        .. " id=" .. tostring(runtimeId) .. " list=" .. tostring(listViewId)
        .. " item=" .. tostring(itemId) .. " templateChild=" .. tostring(templateChildId)
        .. " parent=" .. (parentId == nil and "none" or tostring(parentId))
        .. " name=" .. YMAI_Encode(name == nil and "" or name))
end
_G.YMAI_RuntimeUiTrace = YMAI_RuntimeUiTrace

local function YMAI_Run()
    local queue = {YMAI_ROOT_ID}
    local head = 1
    local seen = {}
    local count = 0
    local truncated = false
    while head <= #queue do
        local itemId = queue[head]
        head = head + 1
        local key = tostring(itemId)
        if not seen[key] then
            if count >= YMAI_MAX_WIDGETS then truncated = true break end
            seen[key] = true
            count = count + 1
            local ok, parentId, name, zOrder, children = pcall(function()
                return UI:GetParent(itemId), UI:GetUIName(itemId), UI:GetWidgetZOrder(itemId), UI:GetAllChildren(itemId)
            end)
            if ok then
                Log:PrintLog("[YMAI_UI_RUNTIME_WIDGET] " .. YMAI_COMMON
                    .. " id=" .. key .. " parent=" .. (parentId == nil and "none" or tostring(parentId))
                    .. " name=" .. YMAI_Encode(name == nil and "" or name)
                    .. " zOrder=" .. tostring(zOrder))
                if type(children) == "table" then
                    for _, childId in ipairs(children) do
                        if not seen[tostring(childId)] then table.insert(queue, childId) end
                    end
                end
            else
                Log:PrintWarning("[YMAI_UI_RUNTIME_WIDGET] " .. YMAI_COMMON .. " id=" .. key .. " status=error reason=api-failed")
            end
        end
    end
    Log:PrintLog("[YMAI_UI_RUNTIME_TREE_ENV] " .. YMAI_COMMON
        .. " status=ok count=" .. tostring(count) .. " truncated=" .. tostring(truncated))
end

System:RegisterEvent(Events.ON_BEGIN_PLAY, function()
    if not System:IsServer() then TimerManager:AddFrame(10, YMAI_Run) end
end)
`;
}

export function containsUiRuntimeInspectionMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_LOG_BYTES) return false;
  try {
    return MARKER_PATTERN.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

export function containsUiScreenPointMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_LOG_BYTES) return false;
  try {
    return /\[(YMAI_UI_SCREEN_POINT_ENV|YMAI_UI_SCREEN_POINT)\]/u.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

export function containsUiRuntimeWidgetMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_LOG_BYTES) return false;
  try {
    return /\[(YMAI_UI_RUNTIME_TREE_ENV|YMAI_UI_RUNTIME_WIDGET|YMAI_UI_DYNAMIC_DUPLICATE|YMAI_UI_LIST_ITEM)\]/u
      .test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

function decodeLog(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_LOG_BYTES) insufficient('UI 运行时日志超过 4 MiB 上限。');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  } catch {
    insufficient('UI 运行时日志不是有效 UTF-8。');
  }
}

function fields(text: string): Map<string, string> {
  const output = new Map<string, string>();
  for (const part of text.trim().split(/\s+/u).filter(Boolean)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=([^\s=]+)$/u.exec(part);
    if (match === null || output.has(match[1]!)) insufficient('UI 运行时日志字段格式无效或重复。');
    output.set(match[1]!, match[2]!);
  }
  return output;
}

function parsedNumber(value: string | undefined): number {
  if (value === undefined || !NUMBER_PATTERN.test(value)) insufficient('UI 运行时日志数值无效。');
  const output = Number(value);
  if (!finite(output)) insufficient('UI 运行时日志数值超出范围。');
  return output;
}

function vector2(value: string | undefined): { x: number; y: number } {
  const parts = value?.split(',');
  if (parts?.length !== 2) insufficient('UI 运行时日志二维坐标无效。');
  return { x: parsedNumber(parts[0]), y: parsedNumber(parts[1]) };
}

function optionalId(value: string | undefined): string | null {
  if (value === 'none') return null;
  if (value === undefined || !ID_PATTERN.test(value)) insufficient('UI 运行时日志控件 ID 无效。');
  return value;
}

function booleanField(value: string | undefined): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  insufficient('UI 运行时日志布尔值无效。');
}

function decodeName(value: string | undefined): string | null {
  if (value === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    insufficient('UI 运行时控件名称编码无效。');
  }
  const hasControlCharacter = [...decoded].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (decoded.length > 256 || hasControlCharacter) insufficient('UI 运行时控件名称无效。');
  return decoded === '' ? null : decoded;
}

function bindCommon(
  value: ReadonlyMap<string, string>,
  context: UiRuntimeProbeContext,
  expectedToken: string,
): void {
  if (value.get('snapshot') !== context.uiSnapshotId || value.get('token') !== expectedToken) {
    insufficient('UI 运行时日志不属于当前工程或当前 UI 快照。');
  }
}

export function parseUiScreenPointProbeLog(
  bytes: Uint8Array,
  options: { snapshot: UiSnapshot; request?: UiScreenPointRequest; importedAt?: string },
): UiScreenPointDocument {
  const context = contextOf(options.snapshot);
  const source = decodeLog(bytes);
  let request = options.request;
  if (request === undefined) {
    const first = /\[(?:YMAI_UI_SCREEN_POINT_ENV|YMAI_UI_SCREEN_POINT)\]\s*(.*)$/mu.exec(source);
    if (first === null) insufficient('日志中没有屏幕点探针标记。');
    const value = fields(first[1]!);
    const point = vector2(value.get('point'));
    const groupId = value.get('group');
    if (groupId === undefined || !ID_PATTERN.test(groupId)) insufficient('UI 屏幕点日志控件组 ID 无效。');
    request = { x: point.x, y: point.y, includeGroup: booleanField(value.get('includeGroup')), groupId };
  }
  validatePointRequest(request);
  const token = createUiScreenPointProbeToken(context, request);
  let environment: { screenSize: { x: number; y: number }; uiSystemSize: { x: number; y: number } } | null = null;
  let hitId: string | null | undefined;
  for (const raw of source.split('\n')) {
    const match = /\[(YMAI_UI_SCREEN_POINT_ENV|YMAI_UI_SCREEN_POINT)\]\s*(.*)$/u.exec(raw);
    if (match === null) continue;
    if (raw.length > MAX_LINE_LENGTH) insufficient('UI 屏幕点日志行超过 4096 字符。');
    const value = fields(match[2]!);
    bindCommon(value, context, token);
    const point = vector2(value.get('point'));
    if (point.x !== request.x || point.y !== request.y
      || booleanField(value.get('includeGroup')) !== request.includeGroup
      || value.get('group') !== request.groupId) insufficient('UI 屏幕点日志请求参数与当前查询不一致。');
    if (value.get('status') !== 'ok') insufficient('UI 屏幕点探针调用失败。');
    if (match[1] === 'YMAI_UI_SCREEN_POINT_ENV') {
      const candidate = { screenSize: vector2(value.get('screenSize')), uiSystemSize: vector2(value.get('uiSize')) };
      if (candidate.screenSize.x <= 0 || candidate.screenSize.y <= 0 || candidate.uiSystemSize.x <= 0 || candidate.uiSystemSize.y <= 0) {
        insufficient('UI 屏幕点日志分辨率无效。');
      }
      if (environment !== null && stableJson(environment) !== stableJson(candidate)) insufficient('UI 屏幕点日志包含冲突环境。');
      environment = candidate;
    } else {
      const candidate = optionalId(value.get('hit'));
      if (hitId !== undefined && hitId !== candidate) insufficient('UI 屏幕点日志包含冲突命中结果。');
      hitId = candidate;
    }
  }
  if (environment === null || hitId === undefined) insufficient('日志缺少当前屏幕点的完整运行时证据。');
  const staticNode = hitId === null ? null : options.snapshot.nodes.find((node) => node.id === hitId) ?? null;
  const importedAt = options.importedAt ?? new Date().toISOString();
  const sourceHash = sha256Hex(bytes);
  const body = {
    schemaVersion: 1 as const,
    sourceHash,
    importedAt,
    ...context,
    token,
    request: { ...request },
    ...environment,
    hitId,
    hit: hitId === null ? null : staticNode === null
      ? { classification: 'dynamic' as const, node: null }
      : { classification: 'static' as const, node: { ...staticNode } },
    evidence: 'STANDALONE_LOG' as const,
  };
  return { ...body, runtimeSnapshotId: sha256Hex(stableJson(body)) };
}

interface MutableWidget {
  id: string;
  parentId: string | null;
  name: string | null;
  zOrder: number | null;
  origins: Set<UiRuntimeWidgetOrigin>;
  duplicate: { templateId: string } | null;
  listItem: { listViewId: string; itemId: string; templateChildId: string } | null;
}

function mergeIdentity(existing: MutableWidget, parentId: string | null, name: string | null): void {
  if (existing.parentId !== null && parentId !== null && existing.parentId !== parentId) insufficient(`动态控件 ${existing.id} 的父级证据冲突。`);
  if (existing.name !== null && name !== null && existing.name !== name) insufficient(`动态控件 ${existing.id} 的名称证据冲突。`);
  if (existing.parentId === null) existing.parentId = parentId;
  if (existing.name === null) existing.name = name;
}

export function parseUiRuntimeWidgetProbeLog(
  bytes: Uint8Array,
  options: { snapshot: UiSnapshot; rootId?: string; importedAt?: string },
): UiRuntimeWidgetDocument {
  const context = contextOf(options.snapshot);
  const source = decodeLog(bytes);
  let rootId = options.rootId;
  if (rootId === undefined) {
    const first = /\[(?:YMAI_UI_RUNTIME_TREE_ENV|YMAI_UI_RUNTIME_WIDGET|YMAI_UI_DYNAMIC_DUPLICATE|YMAI_UI_LIST_ITEM)\]\s*(.*)$/mu.exec(source);
    if (first === null) insufficient('日志中没有运行时 UI 树探针标记。');
    rootId = fields(first[1]!).get('root');
  }
  if (rootId === undefined || !options.snapshot.nodes.some((node) => node.id === rootId)) insufficient('运行时 UI 根控件不属于当前快照。');
  const token = createUiRuntimeWidgetProbeToken(context, rootId);
  const byId = new Map<string, MutableWidget>();
  let environment: { count: number; truncated: boolean } | null = null;
  const get = (id: string, parentId: string | null, name: string | null): MutableWidget => {
    let entry = byId.get(id);
    if (entry === undefined) {
      if (byId.size >= MAX_WIDGETS) insufficient(`运行时 UI 证据超过 ${MAX_WIDGETS} 个控件上限。`);
      entry = { id, parentId, name, zOrder: null, origins: new Set(), duplicate: null, listItem: null };
      byId.set(id, entry);
    } else mergeIdentity(entry, parentId, name);
    return entry;
  };
  for (const raw of source.split('\n')) {
    const match = /\[(YMAI_UI_RUNTIME_TREE_ENV|YMAI_UI_RUNTIME_WIDGET|YMAI_UI_DYNAMIC_DUPLICATE|YMAI_UI_LIST_ITEM)\]\s*(.*)$/u.exec(raw);
    if (match === null) continue;
    if (raw.length > MAX_LINE_LENGTH) insufficient('运行时 UI 树日志行超过 4096 字符。');
    const value = fields(match[2]!);
    bindCommon(value, context, token);
    if (value.get('root') !== rootId) insufficient('运行时 UI 树日志根控件不匹配。');
    if (match[1] === 'YMAI_UI_RUNTIME_TREE_ENV') {
      if (value.get('status') !== 'ok') insufficient('运行时 UI 树扫描失败。');
      const count = parsedNumber(value.get('count'));
      const truncated = booleanField(value.get('truncated'));
      if (!Number.isInteger(count) || count < 0 || count > MAX_WIDGETS || truncated) insufficient('运行时 UI 树超出安全上限或被截断。');
      const candidate = { count, truncated };
      if (environment !== null && stableJson(environment) !== stableJson(candidate)) insufficient('运行时 UI 树包含冲突环境。');
      environment = candidate;
      continue;
    }
    if (value.get('status') === 'error') continue;
    const id = optionalId(value.get('id'));
    if (id === null) insufficient('运行时 UI 控件 ID 不能为空。');
    const parentId = optionalId(value.get('parent'));
    if (match[1] === 'YMAI_UI_RUNTIME_WIDGET') {
      const entry = get(id, parentId, decodeName(value.get('name')));
      const zOrder = parsedNumber(value.get('zOrder'));
      if (entry.zOrder !== null && entry.zOrder !== zOrder) insufficient(`控件 ${id} 的 ZOrder 证据冲突。`);
      entry.zOrder = zOrder;
      entry.origins.add('tree');
    } else if (match[1] === 'YMAI_UI_DYNAMIC_DUPLICATE') {
      const templateId = optionalId(value.get('template'));
      if (templateId === null) insufficient('动态复制模板 ID 不能为空。');
      const entry = get(id, parentId, null);
      if (entry.duplicate !== null && entry.duplicate.templateId !== templateId) insufficient(`动态控件 ${id} 的复制模板冲突。`);
      entry.duplicate = { templateId };
      entry.origins.add('duplicate');
    } else {
      const listViewId = optionalId(value.get('list'));
      const itemId = optionalId(value.get('item'));
      const templateChildId = optionalId(value.get('templateChild'));
      if (listViewId === null || itemId === null || templateChildId === null) insufficient('列表动态控件映射字段不能为空。');
      const entry = get(id, parentId, decodeName(value.get('name')));
      const candidate = { listViewId, itemId, templateChildId };
      if (entry.listItem !== null && stableJson(entry.listItem) !== stableJson(candidate)) insufficient(`动态控件 ${id} 的列表映射冲突。`);
      entry.listItem = candidate;
      entry.origins.add('list-item');
    }
  }
  if (environment === null) insufficient('日志缺少当前运行时 UI 树环境。');
  const staticIds = new Set(options.snapshot.nodes.map((node) => node.id));
  const entries: UiRuntimeWidgetEntry[] = [...byId.values()].map((entry) => ({
    id: entry.id,
    parentId: entry.parentId,
    name: entry.name,
    zOrder: entry.zOrder,
    classification: staticIds.has(entry.id) ? 'static' as const : 'dynamic' as const,
    origins: [...entry.origins].sort((left, right) => left.localeCompare(right, 'en')),
    duplicate: entry.duplicate,
    listItem: entry.listItem,
  })).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const importedAt = options.importedAt ?? new Date().toISOString();
  const sourceHash = sha256Hex(bytes);
  const body = {
    schemaVersion: 1 as const,
    sourceHash,
    importedAt,
    ...context,
    token,
    rootId,
    truncated: environment.truncated,
    evidence: 'STANDALONE_LOG' as const,
    entries,
  };
  return { ...body, runtimeSnapshotId: sha256Hex(stableJson(body)) };
}

export function validateUiScreenPointDocument(
  value: unknown,
  context?: UiRuntimeProbeContext,
): asserts value is UiScreenPointDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient('UI 屏幕点证据不是对象。');
  const document = value as Partial<UiScreenPointDocument>;
  if (document.schemaVersion !== 1 || document.evidence !== 'STANDALONE_LOG' || !SHA256_PATTERN.test(document.runtimeSnapshotId ?? '')
    || !SHA256_PATTERN.test(document.sourceHash ?? '') || typeof document.projectInstanceId !== 'string' || typeof document.uiSnapshotId !== 'string'
    || context !== undefined && (document.projectInstanceId !== context.projectInstanceId || document.uiSnapshotId !== context.uiSnapshotId)) {
    insufficient('UI 屏幕点证据字段或工程绑定无效。');
  }
}

export function validateUiRuntimeWidgetDocument(
  value: unknown,
  context?: UiRuntimeProbeContext,
): asserts value is UiRuntimeWidgetDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) insufficient('运行时 UI 控件证据不是对象。');
  const document = value as Partial<UiRuntimeWidgetDocument>;
  if (document.schemaVersion !== 1 || document.evidence !== 'STANDALONE_LOG' || !SHA256_PATTERN.test(document.runtimeSnapshotId ?? '')
    || !SHA256_PATTERN.test(document.sourceHash ?? '') || !Array.isArray(document.entries) || document.entries.length > MAX_WIDGETS
    || typeof document.projectInstanceId !== 'string' || typeof document.uiSnapshotId !== 'string'
    || context !== undefined && (document.projectInstanceId !== context.projectInstanceId || document.uiSnapshotId !== context.uiSnapshotId)) {
    insufficient('运行时 UI 控件证据字段或工程绑定无效。');
  }
}
