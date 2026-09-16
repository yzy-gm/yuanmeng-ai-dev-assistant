import { TextDecoder } from 'node:util';
import luaparse from 'luaparse';

import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import { createPatchProposal, type PatchProposal } from '../patch/proposal.js';
import { parseLogTimestamp } from './parser.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;
const STATE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const EXPRESSION = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/u;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LINE = 4096;

export interface GameplayTraceInsertionInput {
  projectInstanceId: string;
  targetPath: string;
  source: string;
  insertBeforeLine: number;
  phase: string;
  side: 'server' | 'client' | 'shared' | 'unknown';
  event: string;
  expressions: {
    player?: string;
    instance?: string;
    position?: string;
    state?: Record<string, string>;
  };
  createdAt: string;
}

export interface GameplayTraceInsertion {
  probeId: string;
  proposal: PatchProposal;
}

export interface GameplayTraceEntry {
  line: number;
  timestamp: string | null;
  probeId: string;
  phase: string;
  side: GameplayTraceInsertionInput['side'];
  event: string;
  player: string | null;
  instance: string | null;
  position: [number, number, number] | null;
  state: Record<string, string>;
}

export interface GameplayTraceDocument {
  schemaVersion: 1;
  sourceHash: string;
  evidence: 'STATIC_LOCAL';
  entries: GameplayTraceEntry[];
}

function invalid(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['缩小探针范围并使用无副作用的变量路径。'], 'STATIC_LOCAL');
}

function assertExpression(value: string | undefined, label: string): void {
  if (value !== undefined && !EXPRESSION.test(value)) invalid(`${label}只允许变量或点分字段路径，禁止函数调用和表达式。`);
}

function lineOffset(source: string, line: number): number {
  if (!Number.isInteger(line) || line < 1) invalid('插入行号无效。');
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === '\n') offsets.push(index + 1);
  if (line > offsets.length) invalid('插入行号超出 Lua 文件范围。');
  return offsets[line - 1]!;
}

function assertLua(source: string): void {
  try {
    luaparse.parse(source, { luaVersion: '5.3' });
  } catch (error) {
    throw new ProductError('INVALID_LUA_SYNTAX', '插入探针后 Lua 语法无效，拒绝生成补丁。', ['把光标放在函数体内独立语句之前。'], 'STATIC_LOCAL', error);
  }
}

function probeBlock(probeId: string, input: GameplayTraceInsertionInput): string {
  const states = Object.entries(input.expressions.state ?? {}).sort(([left], [right]) => left.localeCompare(right, 'en'));
  const parts = [
    `"[YMAI_GAMEPLAY_TRACE] schema=1 probe=${probeId} phase=${input.phase} side=${input.side} event=${input.event}"`,
    input.expressions.player === undefined ? '" player=none"' : `" player=" .. YMAI_TraceSafe(${input.expressions.player})`,
    input.expressions.instance === undefined ? '" instance=none"' : `" instance=" .. YMAI_TraceSafe(${input.expressions.instance})`,
    input.expressions.position === undefined ? '" position=invalid"' : `" position=" .. YMAI_TraceVector(${input.expressions.position})`,
    ...states.map(([key, expression]) => `" state.${key}=" .. YMAI_TraceSafe(${expression})`),
  ];
  return `-- YMAI_TRACE_PROBE_BEGIN:${probeId}
do
    local function YMAI_TraceSafe(value)
        if value == nil then return "none" end
        return (string.gsub(tostring(value), "[%s=%[%]]", "_"))
    end
    local function YMAI_TraceVector(value)
        local ok, text = pcall(function()
            return tostring(value.X) .. "," .. tostring(value.Y) .. "," .. tostring(value.Z)
        end)
        return ok and text or "invalid"
    end
    Log:PrintLog(
        ${parts.join('\n        .. ')}
    )
end
-- YMAI_TRACE_PROBE_END:${probeId}
`;
}

export function createGameplayTraceInsertion(input: GameplayTraceInsertionInput): GameplayTraceInsertion {
  if (!NAME.test(input.phase) || !NAME.test(input.event)) invalid('探针阶段和事件名称必须是有限标识符。');
  assertExpression(input.expressions.player, '玩家字段');
  assertExpression(input.expressions.instance, '实例字段');
  assertExpression(input.expressions.position, '位置字段');
  const states = Object.entries(input.expressions.state ?? {});
  if (states.length > 20 || states.some(([key]) => !STATE_KEY.test(key))) invalid('状态探针最多 20 个，且名称必须是安全标识符。');
  for (const [key, expression] of states) assertExpression(expression, `状态字段 ${key}`);
  const offset = lineOffset(input.source, input.insertBeforeLine);
  const probeId = sha256Hex(stableJson({
    targetPath: input.targetPath,
    sourceSha256: sha256Hex(input.source),
    insertBeforeLine: input.insertBeforeLine,
    phase: input.phase,
    side: input.side,
    event: input.event,
    expressions: input.expressions,
  }));
  const newContent = `${input.source.slice(0, offset)}${probeBlock(probeId, input)}${input.source.slice(offset)}`;
  assertLua(newContent);
  return {
    probeId,
    proposal: createPatchProposal({
      projectInstanceId: input.projectInstanceId,
      targetPath: input.targetPath,
      originalContent: input.source,
      newContent,
      summary: `插入可撤销的结构化玩法日志探针 ${probeId.slice(0, 12)}`,
      createdAt: input.createdAt,
    }),
  };
}

export function createGameplayTraceRemoval(input: {
  projectInstanceId: string;
  targetPath: string;
  source: string;
  probeId: string;
  createdAt: string;
}): PatchProposal {
  if (!SHA256.test(input.probeId)) invalid('日志探针 ID 无效。');
  const begin = `-- YMAI_TRACE_PROBE_BEGIN:${input.probeId}\n`;
  const end = `-- YMAI_TRACE_PROBE_END:${input.probeId}\n`;
  const start = input.source.indexOf(begin);
  const endStart = input.source.indexOf(end, start + begin.length);
  if (start < 0 || endStart < 0 || input.source.indexOf(begin, start + begin.length) >= 0) invalid('没有找到唯一、完整的目标探针块。');
  const newContent = input.source.slice(0, start) + input.source.slice(endStart + end.length);
  assertLua(newContent);
  return createPatchProposal({
    projectInstanceId: input.projectInstanceId,
    targetPath: input.targetPath,
    originalContent: input.source,
    newContent,
    summary: `移除结构化玩法日志探针 ${input.probeId.slice(0, 12)}`,
    createdAt: input.createdAt,
  });
}

function boundary(value: string | undefined): number | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid('日志时间范围必须是 ISO 8601。');
  return time;
}

function vector(value: string): [number, number, number] | null {
  if (value === 'invalid') return null;
  const values = value.split(',').map(Number);
  return values.length === 3 && values.every((item) => Number.isFinite(item) && Math.abs(item) <= 1_000_000_000)
    ? values as [number, number, number]
    : invalid('玩法日志中的位置字段无效。');
}

export function parseGameplayTraceLog(
  bytes: Uint8Array,
  options: { from?: string; to?: string } = {},
): GameplayTraceDocument {
  if (bytes.byteLength > MAX_BYTES) throw new ProductError('SCENE_LIMIT_EXCEEDED', '玩法日志超过 4 MiB 上限。', ['截取需要分析的时间段。'], 'STATIC_LOCAL');
  const from = boundary(options.from);
  const to = boundary(options.to);
  if (from !== null && to !== null && from > to) invalid('日志开始时间不能晚于结束时间。');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  } catch (error) {
    throw new ProductError('INVALID_UTF8', '玩法日志不是有效 UTF-8。', ['将日志转换为 UTF-8。'], 'STATIC_LOCAL', error);
  }
  const entries: GameplayTraceEntry[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const marker = line.indexOf('[YMAI_GAMEPLAY_TRACE]');
    if (marker < 0) continue;
    if (line.length > MAX_LINE) invalid(`玩法日志第 ${index + 1} 行超过长度上限。`);
    const timestampText = /^\[([^\]]+)\]/u.exec(line)?.[1] ?? null;
    const timestamp = timestampText !== null && parseLogTimestamp(timestampText) !== null ? timestampText : null;
    const time = timestamp === null ? null : parseLogTimestamp(timestamp);
    if (from !== null && (time === null || time < from) || to !== null && (time === null || time > to)) continue;
    const fields = new Map<string, string>();
    for (const part of line.slice(marker + '[YMAI_GAMEPLAY_TRACE]'.length).trim().split(/\s+/u)) {
      const match = /^([A-Za-z][A-Za-z0-9_.-]*)=([^\s=]+)$/u.exec(part);
      if (match === null || fields.has(match[1]!)) invalid(`玩法日志第 ${index + 1} 行字段格式无效或重复。`);
      fields.set(match[1]!, match[2]!);
    }
    const allowed = [...fields.keys()].every((key) => ['schema', 'probe', 'phase', 'side', 'event', 'player', 'instance', 'position'].includes(key) || key.startsWith('state.'));
    const probeId = fields.get('probe');
    const phase = fields.get('phase');
    const side = fields.get('side');
    const event = fields.get('event');
    if (!allowed || fields.get('schema') !== '1' || probeId === undefined || !SHA256.test(probeId)
      || phase === undefined || !NAME.test(phase) || event === undefined || !NAME.test(event)
      || (side !== 'server' && side !== 'client' && side !== 'shared' && side !== 'unknown')) invalid(`玩法日志第 ${index + 1} 行核心字段无效。`);
    const state: Record<string, string> = {};
    for (const [key, value] of fields) if (key.startsWith('state.')) {
      const name = key.slice(6);
      if (!STATE_KEY.test(name) || Object.keys(state).length >= 20) invalid(`玩法日志第 ${index + 1} 行状态字段无效。`);
      state[name] = value;
    }
    entries.push({
      line: index + 1,
      timestamp,
      probeId,
      phase,
      side,
      event,
      player: fields.get('player') === 'none' ? null : fields.get('player') ?? null,
      instance: fields.get('instance') === 'none' ? null : fields.get('instance') ?? null,
      position: vector(fields.get('position') ?? 'invalid'),
      state: Object.fromEntries(Object.entries(state).sort(([left], [right]) => left.localeCompare(right, 'en'))),
    });
  }
  if (entries.length === 0) invalid('所选时间范围内没有有效的玩法结构化日志。');
  return { schemaVersion: 1, sourceHash: sha256Hex(bytes), evidence: 'STATIC_LOCAL', entries };
}

export function containsGameplayTraceMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_BYTES) return false;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('[YMAI_GAMEPLAY_TRACE]');
  } catch {
    return false;
  }
}
