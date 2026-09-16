import luaparse, {
  type CallExpression,
  type Chunk,
  type Comment,
  type Expression,
  type FunctionDeclaration,
  type Node,
  type ReturnStatement,
  type StringCallExpression,
  type TableKeyString,
  type TableCallExpression,
} from 'luaparse';

import { ProductError } from '../errors.js';
import type { RegistryDocument, RegistryKind, RegistryRecord } from '../model.js';
import { decodeLuaStringLiteral } from './literal-parser.js';

export type LuaSide = 'client' | 'server' | 'shared' | 'unknown';
export type ReferenceConfidence = 'confirmed' | 'inferred' | 'candidate';
export type WhereUsedKind = 'id' | 'signal' | 'ui' | 'scene-instance' | 'element-type' | 'scene-layer';
export type LuaApiIdDomain =
  | 'scene-instance'
  | 'element-type'
  | 'scene-layer'
  | 'scene-group'
  | 'ui-control'
  | 'player'
  | 'character'
  | 'creature'
  | 'prop'
  | 'image'
  | 'effect'
  | 'item'
  | 'camera'
  | 'audio'
  | 'model'
  | 'resource'
  | 'unknown';

export interface LuaSourceFile {
  path: string;
  source: string;
}

export interface LuaApiCallKnowledge {
  qualifiedName: string;
  /** 旧插件兼容字段；新官方索引应使用带域信息的 idParameterDomains。 */
  idParameterIndexes?: readonly number[];
  idParameterDomains?: readonly { parameterIndex: number; domain: LuaApiIdDomain }[];
  signalParameterIndexes?: readonly number[];
  side?: Exclude<LuaSide, 'unknown'>;
}

export interface LuaApiKnowledge {
  calls: readonly LuaApiCallKnowledge[];
  configuredIdFields: readonly string[];
}

export interface LuaSideEvidence {
  value: LuaSide;
  evidence: string | null;
}

export interface LuaSourceLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  context: string;
}

export interface LuaLiteralReference extends LuaSourceLocation {
  value: string;
}

export interface LuaIdReference extends LuaLiteralReference {
  kind: 'id' | 'ui';
  registryKind: RegistryKind | null;
  idDomain?: LuaApiIdDomain;
  confidence: ReferenceConfidence;
  evidence:
    | { source: 'registry'; recordId: string }
    | { source: 'api'; qualifiedName: string; parameterIndex: number }
    | { source: 'config'; field: string };
}

export interface LuaSignalReference extends LuaLiteralReference {
  kind: 'signal';
  role: 'send' | 'listen' | 'candidate';
  confidence: ReferenceConfidence;
  evidence:
    | { source: 'registry'; recordId: string }
    | { source: 'api'; qualifiedName: string; parameterIndex: number };
}

export interface LuaFunctionReference extends LuaSourceLocation {
  name: string;
  local: boolean;
  parameters: string[];
}

export interface LuaCallReference extends LuaSourceLocation {
  qualifiedName: string;
  argumentCount: number;
  arguments: LuaCallArgument[];
  side: LuaSideEvidence;
  /** 仅在 AST 能证明回调用“不等于实例 ID 则立即 return”分流时写入。 */
  sceneInstanceGuards?: string[];
}

export interface LuaCallArgument extends LuaSourceLocation {
  literalType: 'string' | 'number' | 'boolean' | 'nil' | 'other';
  value: string | number | boolean | null;
  qualifiedName: string | null;
}

export interface LuaRequireReference extends LuaSourceLocation {
  module: string;
}

export interface LuaReturnedModule extends LuaSourceLocation {
  value: string;
}

export interface LuaConfigField extends LuaSourceLocation {
  key: string;
  value: string;
}

export interface LuaIndexedFile {
  path: string;
  side: LuaSideEvidence;
}

export interface LuaSourceIndex {
  files: LuaIndexedFile[];
  returnedModules: LuaReturnedModule[];
  functions: LuaFunctionReference[];
  calls: LuaCallReference[];
  requires: LuaRequireReference[];
  stringLiterals: LuaLiteralReference[];
  numericLiterals: LuaLiteralReference[];
  configFields: LuaConfigField[];
  idReferences: LuaIdReference[];
  signalReferences: LuaSignalReference[];
}

export type WhereUsedResult = LuaIdReference | LuaSignalReference;

type RangedNode = Node & {
  range?: [number, number];
};

type LuaCallExpression = CallExpression | StringCallExpression | TableCallExpression;

interface FileContext {
  path: string;
  source: string;
  lines: string[];
  side: LuaSideEvidence;
  registryByValue: ReadonlyMap<string, readonly RegistryRecord[]>;
  apiByCall: ReadonlyMap<string, LuaApiCallKnowledge>;
  configuredIdFields: ReadonlySet<string>;
  index: LuaSourceIndex;
  idReferences: Map<string, LuaIdReference>;
  signalReferences: Map<string, LuaSignalReference>;
  numericConstants: ReadonlyMap<string, string>;
  namedFunctions: ReadonlyMap<string, FunctionDeclaration>;
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_AST_NODES = 500_000;

function fail(
  code: 'VALIDATION_FAILED' | 'INVALID_LUA_SYNTAX' | 'LUA_LIMIT_EXCEEDED',
  message: string,
  cause?: unknown,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new ProductError(code, message, ['修正 Lua 源文件或索引配置后重试。'], 'STATIC_LOCAL', cause, details);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (
    normalized === ''
    || normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').includes('..')
  ) {
    fail('VALIDATION_FAILED', 'Lua 索引只接受工程内相对路径。');
  }
  return normalized;
}

function location(context: FileContext, node: RangedNode): LuaSourceLocation {
  if (node.loc === undefined || node.range === undefined) {
    fail('INVALID_LUA_SYNTAX', `Lua AST 缺少来源范围：${context.path}`, undefined, { file: context.path });
  }
  const line = node.loc.start.line;
  return {
    path: context.path,
    line,
    column: node.loc.start.column + 1,
    endLine: node.loc.end.line,
    endColumn: node.loc.end.column + 1,
    context: context.lines[line - 1]?.trim() ?? '',
  };
}

function literalValue(node: Node): string | null {
  if (node.type === 'StringLiteral') {
    return decodeLuaStringLiteral(node.raw);
  }
  if (node.type === 'NumericLiteral' && Number.isSafeInteger(node.value)) {
    return node.raw;
  }
  return null;
}

function expressionName(expression: Expression | null): string | null {
  if (expression === null) {
    return null;
  }
  if (expression.type === 'Identifier') {
    return expression.name;
  }
  if (expression.type === 'MemberExpression') {
    const base = expressionName(expression.base);
    return base === null ? null : `${base}${expression.indexer}${expression.identifier.name}`;
  }
  if (expression.type === 'IndexExpression') {
    const base = expressionName(expression.base);
    const index = literalValue(expression.index);
    return base === null || index === null ? null : `${base}[${JSON.stringify(index)}]`;
  }
  return null;
}

function functionName(node: FunctionDeclaration): string {
  return expressionName(node.identifier) ?? '<anonymous>';
}

function sideFromComments(comments: readonly Comment[]): LuaSideEvidence {
  for (const comment of comments) {
    const match = /---@ymai-side\s+(client|server|shared)\b/u.exec(comment.raw);
    if (match !== null) {
      return {
        value: match[1] as Exclude<LuaSide, 'unknown'>,
        evidence: `annotation:${match[0]}`,
      };
    }
  }
  return { value: 'unknown', evidence: null };
}

function confidenceFor(record: RegistryRecord): ReferenceConfidence {
  return record.validity === 'confirmed' ? 'confirmed' : 'candidate';
}

function referenceKey(path: string, node: RangedNode, value: string): string {
  return `${path}\0${node.range?.[0] ?? -1}\0${value}`;
}

function addRegistryReference(context: FileContext, node: RangedNode, value: string): void {
  const records = context.registryByValue.get(value) ?? [];
  for (const record of records) {
    if (record.kind === 'signal') {
      addSignalReference(context, node, value, {
        kind: 'signal',
        role: 'candidate',
        confidence: confidenceFor(record),
        evidence: { source: 'registry', recordId: record.recordId },
      });
      continue;
    }
    addIdReference(context, node, value, {
      kind: record.kind === 'ui-control' ? 'ui' : 'id',
      registryKind: record.kind,
      confidence: confidenceFor(record),
      evidence: { source: 'registry', recordId: record.recordId },
    });
  }
}

function addIdReference(
  context: FileContext,
  node: RangedNode,
  value: string,
  details: Pick<LuaIdReference, 'kind' | 'registryKind' | 'confidence' | 'evidence'> & Pick<LuaIdReference, 'idDomain'>,
): void {
  const baseKey = referenceKey(context.path, node, value);
  const registryPrefix = `${baseKey}\0registry:`;
  if (details.evidence.source !== 'registry') {
    if ([...context.idReferences.entries()].some(([key, reference]) => (
      key.startsWith(registryPrefix) && reference.confidence === 'confirmed'
    ))) return;
    context.idReferences.set(baseKey, { ...location(context, node), value, ...details });
    return;
  }
  if (details.confidence === 'confirmed') context.idReferences.delete(baseKey);
  const key = `${registryPrefix}${details.evidence.recordId}`;
  context.idReferences.set(key, { ...location(context, node), value, ...details });
}

function addSignalReference(
  context: FileContext,
  node: RangedNode,
  value: string,
  details: Pick<LuaSignalReference, 'kind' | 'role' | 'confidence' | 'evidence'>,
): void {
  const baseKey = referenceKey(context.path, node, value);
  const registryPrefix = `${baseKey}\0registry:`;
  const registryEntries = [...context.signalReferences.entries()].filter(([key]) => key.startsWith(registryPrefix));
  if (details.evidence.source !== 'registry' && registryEntries.length > 0) {
    for (const [key, reference] of registryEntries) {
      context.signalReferences.set(key, { ...reference, role: details.role });
    }
    return;
  }
  if (details.evidence.source !== 'registry') {
    context.signalReferences.set(baseKey, { ...location(context, node), value, ...details });
    return;
  }
  const existing = context.signalReferences.get(baseKey) ?? registryEntries[0]?.[1];
  context.signalReferences.delete(baseKey);
  context.signalReferences.set(`${registryPrefix}${details.evidence.recordId}`, {
    ...location(context, node),
    value,
    ...details,
    role: existing === undefined || existing.role === 'candidate' ? details.role : existing.role,
  });
}

function signalRole(qualifiedName: string): LuaSignalReference['role'] {
  if (/(?:send|fire|emit)(?:signal|event)?$/iu.test(qualifiedName)) {
    return 'send';
  }
  if (/(?:listen|subscribe|register|on)(?:signal|event)?$/iu.test(qualifiedName)) {
    return 'listen';
  }
  return 'candidate';
}

function callArguments(call: LuaCallExpression): readonly Expression[] {
  if (call.type === 'CallExpression') {
    return call.arguments;
  }
  return [call.type === 'StringCallExpression' ? call.argument : call.arguments];
}

function callArgument(context: FileContext, argument: Expression): LuaCallArgument {
  if (argument.type === 'StringLiteral') {
    return { ...location(context, argument), literalType: 'string', value: decodeLuaStringLiteral(argument.raw), qualifiedName: null };
  }
  if (argument.type === 'NumericLiteral') {
    return { ...location(context, argument), literalType: 'number', value: argument.value, qualifiedName: null };
  }
  if (argument.type === 'BooleanLiteral') {
    return { ...location(context, argument), literalType: 'boolean', value: argument.value, qualifiedName: null };
  }
  if (argument.type === 'NilLiteral') {
    return { ...location(context, argument), literalType: 'nil', value: null, qualifiedName: null };
  }
  return { ...location(context, argument), literalType: 'other', value: null, qualifiedName: expressionName(argument) };
}

function forEachNode(root: unknown, visitor: (node: Node) => void): void {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type === 'string') visitor(value as Node);
    for (const [key, entry] of Object.entries(record)) {
      if (key !== 'loc' && key !== 'range' && key !== 'comments') stack.push(entry);
    }
  }
}

function sourceDeclarations(chunk: Chunk): {
  numericConstants: ReadonlyMap<string, string>;
  namedFunctions: ReadonlyMap<string, FunctionDeclaration>;
} {
  const numericConstants = new Map<string, string>();
  const namedFunctions = new Map<string, FunctionDeclaration>();
  forEachNode(chunk, (node) => {
    if (node.type === 'FunctionDeclaration') {
      const name = functionName(node);
      if (name !== '<anonymous>') namedFunctions.set(name, node);
      return;
    }
    if (node.type !== 'LocalStatement' && node.type !== 'AssignmentStatement') return;
    const candidate = node as Node & { variables?: Expression[]; init?: Expression[] };
    for (let index = 0; index < (candidate.variables?.length ?? 0); index += 1) {
      const variable = candidate.variables?.[index];
      const initial = candidate.init?.[index];
      if (variable?.type === 'Identifier' && initial?.type === 'NumericLiteral' && Number.isSafeInteger(initial.value)) {
        numericConstants.set(variable.name, initial.raw);
      }
    }
  });
  return { numericConstants, namedFunctions };
}

function guardOperand(
  expression: Expression,
  parameterName: string,
  numericConstants: ReadonlyMap<string, string>,
): { kind: 'parameter' } | { kind: 'id'; value: string } | null {
  if (expression.type === 'Identifier') {
    if (expression.name === parameterName) return { kind: 'parameter' };
    const value = numericConstants.get(expression.name);
    return value === undefined ? null : { kind: 'id', value };
  }
  return expression.type === 'NumericLiteral' && Number.isSafeInteger(expression.value)
    ? { kind: 'id', value: expression.raw }
    : null;
}

function idsRejectedByCondition(
  condition: Expression,
  parameterName: string,
  numericConstants: ReadonlyMap<string, string>,
): string[] {
  if (condition.type === 'LogicalExpression' && condition.operator === 'or') {
    return [
      ...idsRejectedByCondition(condition.left, parameterName, numericConstants),
      ...idsRejectedByCondition(condition.right, parameterName, numericConstants),
    ];
  }
  if (condition.type !== 'BinaryExpression' || condition.operator !== '~=') return [];
  const left = guardOperand(condition.left, parameterName, numericConstants);
  const right = guardOperand(condition.right, parameterName, numericConstants);
  if (left?.kind === 'parameter' && right?.kind === 'id') return [right.value];
  if (right?.kind === 'parameter' && left?.kind === 'id') return [left.value];
  return [];
}

function registeredCallback(context: FileContext, arguments_: readonly Expression[]): FunctionDeclaration | undefined {
  const callbackExpression = arguments_[1];
  return callbackExpression?.type === 'FunctionDeclaration'
    ? callbackExpression
    : callbackExpression?.type === 'Identifier'
      ? context.namedFunctions.get(callbackExpression.name)
      : undefined;
}

function sceneInstanceGuards(context: FileContext, arguments_: readonly Expression[]): string[] {
  const callback = registeredCallback(context, arguments_);
  const parameter = callback?.parameters[1];
  if (callback === undefined || parameter?.type !== 'Identifier') return [];
  const ids = new Set<string>();
  forEachNode(callback.body, (node) => {
    if (node.type !== 'IfStatement') return;
    const clauses = (node as Node & { clauses?: Array<{ condition?: Expression; body?: Node[] }> }).clauses ?? [];
    for (const clause of clauses) {
      if (clause.condition === undefined || clause.body?.length !== 1 || clause.body[0]?.type !== 'ReturnStatement') continue;
      for (const id of idsRejectedByCondition(clause.condition, parameter.name, context.numericConstants)) ids.add(id);
    }
  });
  return [...ids].sort((left, right) => left.localeCompare(right, 'en'));
}

function isSystemServerCheck(expression: Expression): boolean {
  if (expression.type !== 'CallExpression') return false;
  const name = expressionName(expression.base);
  return name === 'System:IsServer' || name === 'System.IsServer';
}

/**
 * A top-level `if not System:IsServer() ... then return end` proves that the
 * callback's observable body is server-only. `or` is safe here because every
 * non-server execution necessarily satisfies the left operand and returns;
 * `and` is intentionally not inferred because some client paths could remain.
 */
function rejectsEveryNonServerExecution(condition: Expression): boolean {
  if (condition.type === 'UnaryExpression' && condition.operator === 'not') {
    return isSystemServerCheck(condition.argument);
  }
  return condition.type === 'LogicalExpression'
    && condition.operator === 'or'
    && (rejectsEveryNonServerExecution(condition.left) || rejectsEveryNonServerExecution(condition.right));
}

function registeredCallbackSide(context: FileContext, arguments_: readonly Expression[]): LuaSideEvidence | null {
  const callback = registeredCallback(context, arguments_);
  if (callback === undefined) return null;
  for (const statement of callback.body) {
    if (statement.type !== 'IfStatement') continue;
    const clauses = (statement as Node & { clauses?: Array<{ condition?: Expression; body?: Node[] }> }).clauses ?? [];
    for (const clause of clauses) {
      if (
        clause.condition !== undefined
        && clause.body?.length === 1
        && clause.body[0]?.type === 'ReturnStatement'
        && rejectsEveryNonServerExecution(clause.condition)
      ) {
        return { value: 'server', evidence: 'callback-guard:not System:IsServer() then return' };
      }
    }
  }
  return null;
}

function processCall(context: FileContext, node: LuaCallExpression): void {
  const qualifiedName = expressionName(node.base) ?? '<dynamic>';
  const api = context.apiByCall.get(qualifiedName);
  const args = callArguments(node);
  let side = api?.side === undefined
    ? context.side
    : { value: api.side, evidence: `api:${qualifiedName}` } satisfies LuaSideEvidence;
  if (
    side.value === 'unknown'
    && (qualifiedName === 'System:RegisterEvent' || qualifiedName === 'System.RegisterEvent')
  ) {
    side = registeredCallbackSide(context, args) ?? side;
  }
  context.index.calls.push({
    ...location(context, node),
    qualifiedName,
    argumentCount: args.length,
    arguments: args.map((argument) => callArgument(context, argument)),
    side,
    ...((qualifiedName === 'System:RegisterEvent' || qualifiedName === 'System.RegisterEvent')
      ? { sceneInstanceGuards: sceneInstanceGuards(context, args) }
      : {}),
  });
  if (qualifiedName === 'require' && args[0]?.type === 'StringLiteral') {
    context.index.requires.push({
      ...location(context, args[0]),
      module: decodeLuaStringLiteral(args[0].raw),
    });
  }
  const idParameters = api?.idParameterDomains
    ?? api?.idParameterIndexes?.map((parameterIndex) => ({ parameterIndex, domain: 'unknown' as const }))
    ?? [];
  for (const { parameterIndex, domain } of idParameters) {
    const argument = args[parameterIndex];
    const value = argument === undefined ? null : literalValue(argument);
    if (argument !== undefined && value !== null) {
      addIdReference(context, argument, value, {
        kind: 'id',
        registryKind: null,
        idDomain: domain,
        confidence: 'inferred',
        evidence: { source: 'api', qualifiedName, parameterIndex },
      });
    }
  }
  for (const parameterIndex of api?.signalParameterIndexes ?? []) {
    const argument = args[parameterIndex];
    const value = argument === undefined ? null : literalValue(argument);
    if (argument !== undefined && value !== null) {
      addSignalReference(context, argument, value, {
        kind: 'signal',
        role: signalRole(qualifiedName),
        confidence: 'inferred',
        evidence: { source: 'api', qualifiedName, parameterIndex },
      });
    }
  }
}

function processFunction(context: FileContext, node: FunctionDeclaration): void {
  context.index.functions.push({
    ...location(context, node),
    name: functionName(node),
    local: node.isLocal,
    parameters: node.parameters.map((parameter) => (
      parameter.type === 'Identifier' ? parameter.name : '...'
    )),
  });
}

function processReturn(context: FileContext, node: ReturnStatement): void {
  for (const argument of node.arguments) {
    const value = expressionName(argument)
      ?? (argument.type === 'TableConstructorExpression' ? '<table>' : null);
    if (value !== null) {
      context.index.returnedModules.push({ ...location(context, argument), value });
    }
  }
}

function processConfigField(context: FileContext, node: TableKeyString): void {
  const value = literalValue(node.value);
  if (value === null) {
    return;
  }
  context.index.configFields.push({ ...location(context, node.value), key: node.key.name, value });
  if (context.configuredIdFields.has(node.key.name)) {
    addIdReference(context, node.value, value, {
      kind: 'id',
      registryKind: null,
      confidence: 'candidate',
      evidence: { source: 'config', field: node.key.name },
    });
  }
}

function processLiteral(context: FileContext, node: Node): void {
  if (node.type !== 'StringLiteral' && node.type !== 'NumericLiteral') {
    return;
  }
  const value = literalValue(node);
  if (value === null) {
    return;
  }
  const reference = { ...location(context, node), value };
  if (node.type === 'StringLiteral') {
    context.index.stringLiterals.push(reference);
  } else {
    context.index.numericLiterals.push(reference);
  }
  addRegistryReference(context, node, value);
}

function visit(context: FileContext, node: Node, visited: Set<object>, count: { value: number }): void {
  if (visited.has(node)) {
    return;
  }
  visited.add(node);
  count.value += 1;
  if (count.value > MAX_AST_NODES) {
    fail('LUA_LIMIT_EXCEEDED', 'Lua 源码 AST 节点数超过索引上限。');
  }

  processLiteral(context, node);
  if (
    node.type === 'CallExpression'
    || node.type === 'StringCallExpression'
    || node.type === 'TableCallExpression'
  ) {
    processCall(context, node);
  } else if (node.type === 'FunctionDeclaration') {
    processFunction(context, node);
  } else if (node.type === 'ReturnStatement') {
    processReturn(context, node);
  } else if (node.type === 'TableKeyString') {
    processConfigField(context, node);
  }

  for (const [key, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (key === 'loc' || key === 'range' || key === 'comments' || value === null || typeof value !== 'object') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === 'object' && child !== null && 'type' in child) {
          visit(context, child as Node, visited, count);
        }
      }
    } else if ('type' in value) {
      visit(context, value as Node, visited, count);
    }
  }
}

function parseFile(file: LuaSourceFile): {
  chunk: Chunk;
  path: string;
  side: LuaSideEvidence;
  source: string;
} {
  const path = normalizePath(file.path);
  if (Buffer.byteLength(file.source, 'utf8') > MAX_FILE_BYTES) {
    fail('LUA_LIMIT_EXCEEDED', `Lua 文件超过索引大小上限：${path}`, undefined, { file: path });
  }
  const source = file.source.startsWith('\uFEFF') ? file.source.slice(1) : file.source;
  try {
    const chunk = luaparse.parse(source, {
      comments: true,
      locations: true,
      ranges: true,
      luaVersion: '5.3',
      encodingMode: 'none',
    });
    return { chunk, path, side: sideFromComments(chunk.comments ?? []), source };
  } catch (error) {
    fail('INVALID_LUA_SYNTAX', `Lua 语法无效：${path}`, error, { file: path });
  }
}

function sortLocations<T extends LuaSourceLocation>(values: T[]): void {
  values.sort((left, right) => (
    left.path.localeCompare(right.path, 'en')
    || left.line - right.line
    || left.column - right.column
  ));
}

export function buildLuaSourceIndex(
  files: readonly LuaSourceFile[],
  registry: RegistryDocument,
  api: LuaApiKnowledge,
): LuaSourceIndex {
  const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.source, 'utf8'), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    fail('LUA_LIMIT_EXCEEDED', 'Lua 工程源码总大小超过索引上限。');
  }
  const registryByValue = new Map<string, RegistryRecord[]>();
  for (const record of registry.records) {
    const records = registryByValue.get(record.value) ?? [];
    records.push(record);
    registryByValue.set(record.value, records);
  }
  const apiByCall = new Map(api.calls.map((call) => [call.qualifiedName, call]));
  const index: LuaSourceIndex = {
    files: [],
    returnedModules: [],
    functions: [],
    calls: [],
    requires: [],
    stringLiterals: [],
    numericLiterals: [],
    configFields: [],
    idReferences: [],
    signalReferences: [],
  };
  const idReferences = new Map<string, LuaIdReference>();
  const signalReferences = new Map<string, LuaSignalReference>();
  for (const file of files) {
    const parsed = parseFile(file);
    if (index.files.some((item) => item.path === parsed.path)) {
      fail('VALIDATION_FAILED', `Lua 索引文件路径重复：${parsed.path}`);
    }
    index.files.push({ path: parsed.path, side: parsed.side });
    const declarations = sourceDeclarations(parsed.chunk);
    const context: FileContext = {
      path: parsed.path,
      source: parsed.source,
      lines: parsed.source.split(/\r?\n/u),
      side: parsed.side,
      registryByValue,
      apiByCall,
      configuredIdFields: new Set(api.configuredIdFields),
      index,
      idReferences,
      signalReferences,
      ...declarations,
    };
    const count = { value: 0 };
    for (const statement of parsed.chunk.body) {
      visit(context, statement, new Set<object>(), count);
    }
  }
  index.idReferences = [...idReferences.values()];
  index.signalReferences = [...signalReferences.values()];
  sortLocations(index.returnedModules);
  sortLocations(index.functions);
  sortLocations(index.calls);
  sortLocations(index.requires);
  sortLocations(index.stringLiterals);
  sortLocations(index.numericLiterals);
  sortLocations(index.configFields);
  sortLocations(index.idReferences);
  sortLocations(index.signalReferences);
  index.files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return index;
}

export function whereUsed(
  index: LuaSourceIndex,
  query: string | { value: string; kind?: WhereUsedKind },
): WhereUsedResult[] {
  const value = typeof query === 'string' ? query : query.value;
  const kind = typeof query === 'string' ? undefined : query.kind;
  const ids = kind === 'signal'
    ? []
    : index.idReferences.filter((reference) => (
      reference.value === value
      && (kind !== 'ui' || reference.kind === 'ui')
      && (kind !== 'scene-instance' || reference.registryKind === 'scene-instance')
      && (kind !== 'element-type' || reference.registryKind === 'element-type')
      && (kind !== 'scene-layer' || reference.registryKind === 'scene-layer')
    ));
  const signals = kind !== undefined && kind !== 'signal'
    ? []
    : index.signalReferences.filter((reference) => reference.value === value);
  const results = [...ids, ...signals];
  sortLocations(results);
  return results;
}
