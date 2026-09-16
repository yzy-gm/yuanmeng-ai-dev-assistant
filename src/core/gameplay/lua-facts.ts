import luaparse from 'luaparse';

import type { ResolvedEventMetadata } from '../api/event-doc-index.js';
import { decodeLuaStringLiteral } from '../lua/literal-parser.js';
import type { LuaSourceFile } from '../lua/source-index.js';
import type {
  GameplayDelayFact,
  GameplayEmitFact,
  GameplayEventFact,
  GameplayLuaFacts,
  GameplayPreparationFinding,
  GameplayPrimitive,
  GameplaySourceEvidence,
  GameplayStateWriteFact,
  GameplayUnmodeledFact,
} from './types.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AST_NODES = 200_000;
const MAX_FACTS = 20_000;
const MAX_CALLBACK_DEPTH = 32;

const SCENE_GUARD_PARAMETER_INDEX = new Map<string, number>([
  ['Events.ON_CHARACTER_ENTER_SIGNAL_BOX', 1],
  ['Events.ON_CHARACTER_LEAVE_SIGNAL_BOX', 1],
  ['Events.ON_ELEMENT_ENTER_TRIGGER', 1],
  ['Events.ON_ELEMENT_LEAVE_TRIGGER', 1],
  ['Events.ON_LOGIC_ACTOR_ENTER_TRIGGER', 1],
  ['Events.ON_LOGIC_ACTOR_LEAVE_TRIGGER', 1],
  ['Events.ON_CREATURE_ENTER_TRIGGER', 1],
  ['Events.ON_CREATURE_LEAVE_TRIGGER', 1],
  ['Events.ON_PLAYER_TOUCH_ELEMENT', 1],
  ['Events.ON_ELEMENT_TOUCH_PLAYER', 1],
]);

interface CallContract {
  eventIndex: number;
  playerIndex: number | null;
  targetSide: GameplayEmitFact['targetSide'];
  routing: GameplayEmitFact['routing'];
}

const EMISSION_CALLS = new Map<string, CallContract>([
  ['System:SendToServer', { eventIndex: 0, playerIndex: null, targetSide: 'server', routing: 'without-player' }],
  ['System.SendToServer', { eventIndex: 0, playerIndex: null, targetSide: 'server', routing: 'without-player' }],
  ['System:SendToClient', { eventIndex: 1, playerIndex: 0, targetSide: 'client', routing: 'same-player' }],
  ['System.SendToClient', { eventIndex: 1, playerIndex: 0, targetSide: 'client', routing: 'same-player' }],
  ['System:SendToAllClients', { eventIndex: 0, playerIndex: null, targetSide: 'client', routing: 'broadcast' }],
  ['System.SendToAllClients', { eventIndex: 0, playerIndex: null, targetSide: 'client', routing: 'broadcast' }],
  ['System:FireSignEvent', { eventIndex: 0, playerIndex: null, targetSide: 'unknown', routing: 'without-player' }],
  ['System.FireSignEvent', { eventIndex: 0, playerIndex: null, targetSide: 'unknown', routing: 'without-player' }],
  ['System:DispatchEvent', { eventIndex: 0, playerIndex: null, targetSide: 'unknown', routing: 'unknown' }],
  ['System.DispatchEvent', { eventIndex: 0, playerIndex: null, targetSide: 'unknown', routing: 'unknown' }],
]);

const TIMER_CALLS = new Map<string, GameplayDelayFact['unit']>([
  ['TimerManager:AddFrame', 'frames'],
  ['TimerManager.AddFrame', 'frames'],
  ['TimerManager:AddTimer', 'milliseconds'],
  ['TimerManager.AddTimer', 'milliseconds'],
  ['System:SetTimeout', 'milliseconds'],
  ['System.SetTimeout', 'milliseconds'],
]);

type AstRecord = Record<string, unknown> & {
  type?: unknown;
  name?: unknown;
  raw?: unknown;
  value?: unknown;
  operator?: unknown;
  indexer?: unknown;
  identifier?: unknown;
  base?: unknown;
  index?: unknown;
  arguments?: unknown;
  argument?: unknown;
  variables?: unknown;
  init?: unknown;
  left?: unknown;
  right?: unknown;
  body?: unknown;
  parameters?: unknown;
  clauses?: unknown;
  condition?: unknown;
  loc?: unknown;
  comments?: unknown;
};

interface ParsedFile {
  path: string;
  chunk: AstRecord;
  fileSide: 'server' | 'client' | 'unknown';
  pathSide: 'server' | 'client' | 'unknown';
  namedFunctions: ReadonlyMap<string, AstRecord[]>;
}

interface CallbackOutput {
  writes: GameplayStateWriteFact[];
  emits: GameplayEmitFact[];
  observableCalls: GameplaySourceEvidence[];
  evidence: GameplaySourceEvidence[];
  unmodeled: GameplayUnmodeledFact[];
}

function record(value: unknown): AstRecord | null {
  return typeof value === 'object' && value !== null ? value as AstRecord : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizePath(value: string): string | null {
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (
    normalized.length === 0
    || !normalized.startsWith('src/')
    || !normalized.toLowerCase().endsWith('.lua')
    || normalized.includes('\0')
    || normalized.startsWith('/')
    || normalized.startsWith('//')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) return null;
  return normalized;
}

function sourceEvidence(
  path: string,
  node: AstRecord,
  kind: GameplaySourceEvidence['kind'],
): GameplaySourceEvidence {
  const loc = record(node.loc);
  const start = record(loc?.start);
  return {
    path,
    line: typeof start?.line === 'number' ? start.line : 1,
    column: typeof start?.column === 'number' ? start.column + 1 : 1,
    kind,
  };
}

function preparationFinding(
  code: string,
  severity: GameplayPreparationFinding['severity'],
  scope: GameplayPreparationFinding['scope'],
  message: string,
  nextAction: string,
  path: string,
): GameplayPreparationFinding {
  return {
    code,
    severity,
    scope,
    message,
    nextAction,
    evidence: [{ path, line: 1, column: 1 }],
  };
}

function expressionName(value: unknown): string | null {
  const node = record(value);
  if (node === null) return null;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type === 'MemberExpression') {
    const base = expressionName(node.base);
    const identifier = record(node.identifier);
    return base !== null && typeof identifier?.name === 'string' && typeof node.indexer === 'string'
      ? `${base}${node.indexer}${identifier.name}`
      : null;
  }
  if (node.type === 'IndexExpression') {
    const base = expressionName(node.base);
    const index = literalValue(node.index);
    return base !== null && (typeof index === 'string' || typeof index === 'number')
      ? `${base}[${JSON.stringify(index)}]`
      : null;
  }
  return null;
}

function literalValue(value: unknown): GameplayPrimitive | undefined {
  const node = record(value);
  if (node === null) return undefined;
  if (node.type === 'StringLiteral' && typeof node.raw === 'string') return decodeLuaStringLiteral(node.raw);
  if (node.type === 'NumericLiteral' && typeof node.value === 'number' && Number.isFinite(node.value)) return node.value;
  if (node.type === 'BooleanLiteral' && typeof node.value === 'boolean') return node.value;
  if (node.type === 'NilLiteral') return null;
  return undefined;
}

function staticEventName(value: unknown): string | null {
  const node = record(value);
  if (node === null) return null;
  const literal = literalValue(node);
  if (typeof literal === 'string' && literal.length > 0) return literal;
  return node.type === 'MemberExpression' || node.type === 'IndexExpression' ? expressionName(node) : null;
}

function callArguments(node: AstRecord): unknown[] {
  if (node.type === 'StringCallExpression') return [node.argument];
  if (node.type === 'TableCallExpression') return [node.arguments];
  return array(node.arguments);
}

function forEachNode(root: unknown, visitor: (node: AstRecord) => void): number {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  let count = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    const node = value as AstRecord;
    if (typeof node.type === 'string') {
      count += 1;
      visitor(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'range' && key !== 'comments') stack.push(child);
    }
  }
  return count;
}

function fileSideFromComments(chunk: AstRecord): ParsedFile['fileSide'] {
  for (const comment of array(chunk.comments)) {
    const raw = record(comment)?.raw;
    if (typeof raw !== 'string') continue;
    const match = /---@ymai-side\s+(client|server|shared)\b/u.exec(raw);
    if (match?.[1] === 'client' || match?.[1] === 'server') return match[1];
  }
  return 'unknown';
}

/**
 * 元梦工程通常把端侧入口放在 src/Client 或 src/Server 下。这个证据只
 * 在没有相反的显式注释/官方元数据时帮助自动模式闭合事实；真正冲突时
 * 仍由 resolveSide fail-closed 为 unknown。
 */
function fileSideFromPath(path: string): ParsedFile['pathSide'] {
  const rootModule = path.split('/')[1]?.toLowerCase();
  if (rootModule === 'client') return 'client';
  if (rootModule === 'server') return 'server';
  return 'unknown';
}

function parseFile(file: LuaSourceFile, findings: GameplayPreparationFinding[]): ParsedFile | null {
  const path = normalizePath(file.path);
  if (path === null) {
    findings.push(preparationFinding(
      'GAMEPLAY_SOURCE_PATH_INVALID', 'fatal', 'project',
      'Lua 玩法事实只接受 src/ 下的工程相对路径。',
      '移除绝对路径或越界路径后重试。',
      'src/<invalid>',
    ));
    return null;
  }
  if (Buffer.byteLength(file.source, 'utf8') > MAX_FILE_BYTES) {
    findings.push(preparationFinding(
      'GAMEPLAY_LUA_LIMIT_EXCEEDED', 'fatal', 'artifact',
      `Lua 文件超过玩法事实提取大小上限：${path}`,
      '缩小生产文件或拆分模块后重试。',
      path,
    ));
    return null;
  }
  try {
    const chunk = luaparse.parse(file.source.startsWith('\uFEFF') ? file.source.slice(1) : file.source, {
      comments: true,
      locations: true,
      ranges: true,
      luaVersion: '5.3',
      encodingMode: 'none',
    }) as unknown as AstRecord;
    const namedFunctions = new Map<string, AstRecord[]>();
    const nodeCount = forEachNode(chunk, (node) => {
      if (node.type !== 'FunctionDeclaration') return;
      const name = expressionName(node.identifier);
      if (name === null) return;
      const entries = namedFunctions.get(name) ?? [];
      entries.push(node);
      namedFunctions.set(name, entries);
    });
    if (nodeCount > MAX_AST_NODES) {
      findings.push(preparationFinding(
        'GAMEPLAY_LUA_LIMIT_EXCEEDED', 'fatal', 'artifact',
        `Lua AST 节点超过玩法事实提取上限：${path}`,
        '拆分生产模块或缩小自动玩法范围后重试。',
        path,
      ));
      return null;
    }
    return {
      path,
      chunk,
      fileSide: fileSideFromComments(chunk),
      pathSide: fileSideFromPath(path),
      namedFunctions,
    };
  } catch {
    findings.push(preparationFinding(
      'GAMEPLAY_REACHABLE_LUA_INVALID', 'fatal', 'flow',
      `生产可达 Lua 无法解析：${path}`,
      '修复该生产文件的 Lua 语法后重试。',
      path,
    ));
    return null;
  }
}

function resolveCallback(value: unknown, parsed: ParsedFile): AstRecord | null {
  const node = record(value);
  if (node?.type === 'FunctionDeclaration') return node;
  if (node?.type !== 'Identifier' || typeof node.name !== 'string') return null;
  const matches = parsed.namedFunctions.get(node.name) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

function callbackParameters(callback: AstRecord): string[] {
  return array(callback.parameters).flatMap((parameter) => {
    const node = record(parameter);
    return node?.type === 'Identifier' && typeof node.name === 'string' ? [node.name] : [];
  });
}

function isSystemServerCheck(value: unknown): boolean {
  const node = record(value);
  return node?.type === 'CallExpression'
    && (expressionName(node.base) === 'System:IsServer' || expressionName(node.base) === 'System.IsServer');
}

function rejectsEveryNonServerExecution(value: unknown): boolean {
  const node = record(value);
  if (node?.type === 'UnaryExpression' && node.operator === 'not') return isSystemServerCheck(node.argument);
  return node?.type === 'LogicalExpression'
    && node.operator === 'or'
    && (rejectsEveryNonServerExecution(node.left) || rejectsEveryNonServerExecution(node.right));
}

function callbackGuardSide(callback: AstRecord): 'server' | 'unknown' {
  for (const statementValue of array(callback.body)) {
    const statement = record(statementValue);
    if (statement?.type !== 'IfStatement') continue;
    for (const clauseValue of array(statement.clauses)) {
      const clause = record(clauseValue);
      const body = array(clause?.body);
      if (
        clause?.condition !== undefined
        && body.length === 1
        && record(body[0])?.type === 'ReturnStatement'
        && rejectsEveryNonServerExecution(clause.condition)
      ) return 'server';
    }
  }
  return 'unknown';
}

function metadataFor(event: string, values: ReadonlyMap<string, ResolvedEventMetadata>): ResolvedEventMetadata | undefined {
  return values.get(event) ?? values.get(event.replace(/^Events\./u, ''));
}

function resolveSide(
  event: string,
  parsed: ParsedFile,
  callback: AstRecord,
  metadata: ReadonlyMap<string, ResolvedEventMetadata>,
): { side: GameplayEventFact['side']; conflict: boolean } {
  const candidates = new Set<'server' | 'client'>();
  if (parsed.fileSide !== 'unknown') candidates.add(parsed.fileSide);
  if (parsed.pathSide !== 'unknown') candidates.add(parsed.pathSide);
  const guardSide = callbackGuardSide(callback);
  if (guardSide === 'server') candidates.add('server');
  const scope = metadataFor(event, metadata)?.scope;
  if (scope === 'server' || scope === 'client') candidates.add(scope);
  return candidates.size === 1
    ? { side: [...candidates][0]!, conflict: false }
    : { side: 'unknown', conflict: candidates.size > 1 };
}

function unmodeled(
  output: CallbackOutput | GameplayLuaFacts,
  code: string,
  reason: string,
  evidence: GameplaySourceEvidence,
): void {
  output.unmodeled.push({ code, reason, evidence });
}

function literalDelay(value: unknown, unit: GameplayDelayFact['unit']): GameplayDelayFact | null {
  const node = record(value);
  if (node?.type !== 'NumericLiteral' || typeof node.value !== 'number' || !Number.isFinite(node.value) || node.value < 0) return null;
  if (unit === 'frames' && !Number.isSafeInteger(node.value)) return null;
  return { unit, value: node.value };
}

function stateWrite(
  targetValue: unknown,
  initialValue: unknown,
  parsed: ParsedFile,
  delay: GameplayDelayFact | null,
): GameplayStateWriteFact | null {
  const targetNode = record(targetValue);
  const initialNode = record(initialValue);
  const target = expressionName(targetNode);
  if (targetNode === null || initialNode === null || target === null || targetNode.type === 'Identifier') return null;
  const evidence = sourceEvidence(parsed.path, targetNode, 'state-write');
  const literal = literalValue(initialNode);
  if (literal !== undefined) return { target, operation: 'set', value: literal, delay, evidence };
  if (initialNode.type !== 'BinaryExpression' || (initialNode.operator !== '+' && initialNode.operator !== '-')) return null;
  const leftName = expressionName(initialNode.left);
  const rightName = expressionName(initialNode.right);
  const leftLiteral = literalValue(initialNode.left);
  const rightLiteral = literalValue(initialNode.right);
  if (leftName === target && typeof rightLiteral === 'number') {
    return { target, operation: 'add', value: initialNode.operator === '-' ? -rightLiteral : rightLiteral, delay, evidence };
  }
  if (initialNode.operator === '+' && rightName === target && typeof leftLiteral === 'number') {
    return { target, operation: 'add', value: leftLiteral, delay, evidence };
  }
  return null;
}

function numericGuardId(value: unknown, parameter: string): string | null {
  const node = record(value);
  if (node?.type !== 'BinaryExpression' || node.operator !== '~=') return null;
  const leftName = expressionName(node.left);
  const rightName = expressionName(node.right);
  const left = literalValue(node.left);
  const right = literalValue(node.right);
  if (leftName === parameter && typeof right === 'number' && Number.isSafeInteger(right)) return String(right);
  if (rightName === parameter && typeof left === 'number' && Number.isSafeInteger(left)) return String(left);
  return null;
}

function sceneGuards(
  event: string,
  callback: AstRecord,
  parsed: ParsedFile,
): { ids: string[]; evidence: GameplaySourceEvidence[] } {
  const parameterIndex = SCENE_GUARD_PARAMETER_INDEX.get(event);
  const parameter = parameterIndex === undefined ? undefined : callbackParameters(callback)[parameterIndex];
  if (parameter === undefined) return { ids: [], evidence: [] };
  const ids = new Set<string>();
  const evidence: GameplaySourceEvidence[] = [];
  forEachNode(callback.body, (node) => {
    if (node.type !== 'IfStatement') return;
    for (const clauseValue of array(node.clauses)) {
      const clause = record(clauseValue);
      const body = array(clause?.body);
      if (clause?.condition === undefined || body.length !== 1 || record(body[0])?.type !== 'ReturnStatement') continue;
      const id = numericGuardId(clause.condition, parameter);
      if (id !== null) {
        ids.add(id);
        evidence.push(sourceEvidence(parsed.path, clause, 'scene-guard'));
      }
    }
  });
  return { ids: [...ids].sort((left, right) => left.localeCompare(right, 'en')), evidence };
}

function addEvidence(output: CallbackOutput, evidence: GameplaySourceEvidence): void {
  output.evidence.push(evidence);
}

function scanCallbackNode(
  value: unknown,
  parsed: ParsedFile,
  parameters: readonly string[],
  delay: GameplayDelayFact | null,
  depth: number,
  output: CallbackOutput,
): void {
  if (depth > MAX_CALLBACK_DEPTH) {
    unmodeled(output, 'GAMEPLAY_CALLBACK_DEPTH_UNMODELED', '回调嵌套深度超过安全上限。', {
      path: parsed.path, line: 1, column: 1, kind: 'observable-call',
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) scanCallbackNode(child, parsed, parameters, delay, depth, output);
    return;
  }
  const node = record(value);
  if (node === null) return;
  if (node.type === 'FunctionDeclaration') return;

  if (node.type === 'AssignmentStatement') {
    const variables = array(node.variables);
    const initializers = array(node.init);
    for (let index = 0; index < variables.length; index += 1) {
      const evidence = sourceEvidence(parsed.path, record(variables[index]) ?? node, 'state-write');
      const write = stateWrite(variables[index], initializers[index], parsed, delay);
      if (write === null) {
        unmodeled(output, 'GAMEPLAY_STATE_WRITE_UNMODELED', '状态写入目标或值不能由字面 AST 安全定位。', evidence);
      } else {
        output.writes.push(write);
        addEvidence(output, write.evidence);
      }
    }
  }

  if (node.type === 'CallExpression' || node.type === 'StringCallExpression' || node.type === 'TableCallExpression') {
    const name = expressionName(node.base) ?? '<dynamic>';
    const args = callArguments(node);
    const timerUnit = TIMER_CALLS.get(name);
    if (timerUnit !== undefined) {
      const timerEvidence = sourceEvidence(parsed.path, node, 'timer');
      addEvidence(output, timerEvidence);
      const timerDelay = literalDelay(args[0], timerUnit);
      if (timerDelay === null) {
        unmodeled(output, 'GAMEPLAY_DYNAMIC_TIMER_DELAY_UNMODELED', '计时器延时不是有限字面值。', timerEvidence);
        return;
      }
      const timerCallback = resolveCallback(args[1], parsed);
      if (timerCallback === null) {
        unmodeled(output, 'GAMEPLAY_DYNAMIC_TIMER_CALLBACK_UNMODELED', '计时器回调不能在同文件唯一定位。', timerEvidence);
        return;
      }
      scanCallbackNode(timerCallback.body, parsed, callbackParameters(timerCallback), timerDelay, depth + 1, output);
      return;
    }

    const emission = EMISSION_CALLS.get(name);
    if (emission !== undefined) {
      const evidence = sourceEvidence(parsed.path, node, 'event-emission');
      const event = staticEventName(args[emission.eventIndex]);
      if (event === null) {
        unmodeled(output, 'GAMEPLAY_DYNAMIC_EMISSION_UNMODELED', '发送事件不能由静态字面或成员路径确定。', evidence);
      } else {
        const playerName = emission.playerIndex === null ? null : expressionName(args[emission.playerIndex]);
        const playerParameterIndex = playerName === null ? null : parameters.indexOf(playerName);
        const fact: GameplayEmitFact = {
          event,
          targetSide: emission.targetSide,
          routing: emission.routing,
          playerParameterIndex: playerParameterIndex === null || playerParameterIndex < 0 ? null : playerParameterIndex,
          delay,
          evidence,
        };
        output.emits.push(fact);
        addEvidence(output, evidence);
      }
    } else if (
      name !== 'System:RegisterEvent'
      && name !== 'System.RegisterEvent'
      && name !== 'System:IsServer'
      && name !== 'System.IsServer'
      && name !== 'require'
    ) {
      const evidence = sourceEvidence(parsed.path, node, 'observable-call');
      output.observableCalls.push(evidence);
      addEvidence(output, evidence);
    }
  }

  for (const [key, child] of Object.entries(node)) {
    if (
      key === 'loc' || key === 'range' || key === 'comments'
      || (node.type === 'AssignmentStatement' && (key === 'variables' || key === 'init'))
      || ((node.type === 'CallExpression' || node.type === 'StringCallExpression' || node.type === 'TableCallExpression') && key === 'base')
    ) continue;
    scanCallbackNode(child, parsed, parameters, delay, depth, output);
  }
}

function uniqueEvidence(values: readonly GameplaySourceEvidence[]): GameplaySourceEvidence[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.path}\0${value.line}\0${value.column}\0${value.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (
    left.path.localeCompare(right.path, 'en')
    || left.line - right.line
    || left.column - right.column
    || left.kind.localeCompare(right.kind, 'en')
  ));
}

function factCount(result: GameplayLuaFacts): number {
  return result.events.length
    + result.unmodeled.length
    + result.events.reduce((total, event) => total + event.writes.length + event.emits.length + event.observableCalls.length, 0);
}

export function extractGameplayLuaFacts(input: {
  files: readonly LuaSourceFile[];
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata>;
}): GameplayLuaFacts {
  const result: GameplayLuaFacts = { schemaVersion: 1, events: [], unmodeled: [], findings: [] };
  const parsedFiles = input.files.flatMap((file) => {
    const parsed = parseFile(file, result.findings);
    return parsed === null ? [] : [parsed];
  });

  for (const parsed of parsedFiles) {
    const registrationCalls: AstRecord[] = [];
    forEachNode(parsed.chunk, (node) => {
      if (
        (node.type === 'CallExpression' || node.type === 'StringCallExpression' || node.type === 'TableCallExpression')
        && (expressionName(node.base) === 'System:RegisterEvent' || expressionName(node.base) === 'System.RegisterEvent')
      ) registrationCalls.push(node);
    });
    registrationCalls.sort((left, right) => {
      const leftEvidence = sourceEvidence(parsed.path, left, 'event-registration');
      const rightEvidence = sourceEvidence(parsed.path, right, 'event-registration');
      return leftEvidence.line - rightEvidence.line || leftEvidence.column - rightEvidence.column;
    });

    for (const call of registrationCalls) {
      const args = callArguments(call);
      const registrationEvidence = sourceEvidence(parsed.path, call, 'event-registration');
      const event = staticEventName(args[0]);
      if (event === null) {
        unmodeled(result, 'GAMEPLAY_DYNAMIC_EVENT_UNMODELED', '注册事件不能由静态字面或成员路径确定。', registrationEvidence);
        continue;
      }
      const callback = resolveCallback(args[1], parsed);
      if (callback === null) {
        unmodeled(result, 'GAMEPLAY_DYNAMIC_CALLBACK_UNMODELED', '注册回调不能在同文件唯一定位。', registrationEvidence);
        continue;
      }
      const parameters = callbackParameters(callback);
      const side = resolveSide(event, parsed, callback, input.eventMetadata);
      if (side.conflict) {
        unmodeled(result, 'GAMEPLAY_SIDE_CONFLICT', '文件、回调守卫或官方事件元数据的运行端证据冲突。', registrationEvidence);
      }
      const output: CallbackOutput = {
        writes: [], emits: [], observableCalls: [], evidence: [registrationEvidence], unmodeled: [],
      };
      scanCallbackNode(callback.body, parsed, parameters, null, 0, output);
      const guards = sceneGuards(event, callback, parsed);
      output.evidence.push(...guards.evidence);
      result.events.push({
        event,
        side: side.side,
        callbackParameters: parameters,
        sceneInstanceGuards: guards.ids,
        writes: output.writes,
        emits: output.emits,
        observableCalls: output.observableCalls,
        evidence: uniqueEvidence(output.evidence),
      });
      result.unmodeled.push(...output.unmodeled);
      if (factCount(result) > MAX_FACTS) {
        result.findings.push(preparationFinding(
          'GAMEPLAY_FACT_LIMIT_EXCEEDED', 'fatal', 'artifact',
          'Lua 玩法事实数量超过安全上限。',
          '缩小生产范围或功能焦点后重试。',
          parsed.path,
        ));
        break;
      }
    }
  }

  result.events.sort((left, right) => {
    const leftEvidence = left.evidence[0]!;
    const rightEvidence = right.evidence[0]!;
    return leftEvidence.path.localeCompare(rightEvidence.path, 'en')
      || leftEvidence.line - rightEvidence.line
      || left.event.localeCompare(right.event, 'en');
  });
  result.unmodeled.sort((left, right) => (
    left.evidence.path.localeCompare(right.evidence.path, 'en')
    || left.evidence.line - right.evidence.line
    || left.evidence.column - right.evidence.column
    || left.code.localeCompare(right.code, 'en')
  ));

  const registrations = new Map<string, GameplayEventFact[]>();
  for (const event of result.events) {
    const key = `${event.event}\0${event.side}`;
    const values = registrations.get(key) ?? [];
    values.push(event);
    registrations.set(key, values);
  }
  for (const values of registrations.values()) {
    if (values.length < 2) continue;
    result.findings.push({
      code: 'GAMEPLAY_EVENT_REGISTRATION_DUPLICATE',
      severity: 'partial',
      scope: 'flow',
      message: `同一运行端重复注册事件：${values[0]!.event}`,
      nextAction: '确认重复处理是否有意，并在官方编辑器中验证重复回调顺序。',
      evidence: values.flatMap((value) => value.evidence
        .filter((entry) => entry.kind === 'event-registration')
        .map(({ path, line, column }) => ({ path, line, column }))),
    });
  }

  return result;
}
