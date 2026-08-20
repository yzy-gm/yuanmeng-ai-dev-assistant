import { TextDecoder } from 'node:util';

import luaparse, {
  type Expression,
  type Node,
  type TableConstructorExpression,
} from 'luaparse';

import { ProductError } from '../errors.js';

export interface LuaParseLimits {
  maxSourceBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxStringBytes: number;
}

export const DEFAULT_LUA_PARSE_LIMITS: Readonly<LuaParseLimits> = Object.freeze({
  maxSourceBytes: 16 * 1024 * 1024,
  maxNodes: 200_000,
  maxDepth: 256,
  maxStringBytes: 4 * 1024 * 1024,
});

export type LuaLiteralValue =
  | null
  | boolean
  | number
  | string
  | LuaLiteralValue[]
  | { [key: string]: LuaLiteralValue };

export interface LuaSourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface LuaLiteralMetadata {
  path: string;
  kind: 'string' | 'number' | 'boolean' | 'nil';
  value: string | number | boolean | null;
  range: LuaSourceRange;
}

export interface LuaTableEntryMetadata {
  path: string;
  key: string | number | boolean;
  entryRange: LuaSourceRange;
  valueRange: LuaSourceRange;
}

export interface LuaLiteralDocument {
  value: LuaLiteralValue;
  rootRange: LuaSourceRange;
  literals: LuaLiteralMetadata[];
  entries: LuaTableEntryMetadata[];
  nodeCount: number;
}

type RangedNode = Node & { range?: [number, number] };

interface EvaluationContext {
  limits: LuaParseLimits;
  prefixOffset: number;
  collectMetadata: boolean;
  literals: LuaLiteralMetadata[];
  entries: LuaTableEntryMetadata[];
}

function productError(
  code: 'UNSAFE_LUA_NODE' | 'LUA_LIMIT_EXCEEDED' | 'DUPLICATE_LUA_KEY' | 'NON_FINITE_NUMBER' | 'INVALID_LUA_SYNTAX' | 'INVALID_UTF8',
  message: string,
  cause?: unknown,
): ProductError {
  return new ProductError(code, message, ['先在元梦编辑器更新 VSCode 工程，再使用官方获取的字面量 Lua 数据重试。'], 'STATIC_LOCAL', cause);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProductError('VALIDATION_FAILED', `${name} 必须是正整数。`, ['检查解析限制配置。'], 'STATIC_LOCAL');
  }
  return value;
}

function mergeLimits(options: Partial<LuaParseLimits> | undefined): LuaParseLimits {
  return {
    maxSourceBytes: positiveInteger(options?.maxSourceBytes ?? DEFAULT_LUA_PARSE_LIMITS.maxSourceBytes, 'maxSourceBytes'),
    maxNodes: positiveInteger(options?.maxNodes ?? DEFAULT_LUA_PARSE_LIMITS.maxNodes, 'maxNodes'),
    maxDepth: positiveInteger(options?.maxDepth ?? DEFAULT_LUA_PARSE_LIMITS.maxDepth, 'maxDepth'),
    maxStringBytes: positiveInteger(options?.maxStringBytes ?? DEFAULT_LUA_PARSE_LIMITS.maxStringBytes, 'maxStringBytes'),
  };
}

function rangeOf(node: RangedNode, prefixOffset: number): LuaSourceRange {
  if (node.range === undefined || node.loc === undefined) {
    throw productError('INVALID_LUA_SYNTAX', 'Lua AST 缺少来源范围。');
  }
  return {
    startOffset: node.range[0] + prefixOffset,
    endOffset: node.range[1] + prefixOffset,
    startLine: node.loc.start.line,
    startColumn: node.loc.start.column + 1,
    endLine: node.loc.end.line,
    endColumn: node.loc.end.column + 1,
  };
}

function pointerComponent(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function childPath(parent: string, key: string | number | boolean): string {
  return `${parent}/${pointerComponent(String(key))}`;
}

function ensureStringLimit(value: string, context: EvaluationContext): void {
  if (Buffer.byteLength(value, 'utf8') > context.limits.maxStringBytes) {
    throw productError('LUA_LIMIT_EXCEEDED', 'Lua 字符串超过允许大小。');
  }
}

function decodeLongString(raw: string): string | null {
  const opening = /^\[(=*)\[/u.exec(raw);
  if (opening === null) {
    return null;
  }
  const equals = opening[1] ?? '';
  const openingLength = equals.length + 2;
  const closing = `]${equals}]`;
  if (!raw.endsWith(closing)) {
    throw productError('INVALID_LUA_SYNTAX', 'Lua 长字符串未闭合。');
  }
  let value = raw.slice(openingLength, -closing.length);
  value = value.replace(/^(?:\r\n|\n|\r)/u, '');
  return value;
}

function codePoint(hex: string): string {
  const value = Number.parseInt(hex, 16);
  if (!Number.isInteger(value) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    throw productError('INVALID_LUA_SYNTAX', 'Lua Unicode 转义无效。');
  }
  return String.fromCodePoint(value);
}

function decodeQuotedString(raw: string): string {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote) {
    throw productError('INVALID_LUA_SYNTAX', 'Lua 字符串引号无效。');
  }
  let output = '';
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (character !== '\\') {
      output += character;
      continue;
    }
    index += 1;
    const escaped = raw[index];
    if (escaped === undefined || index >= raw.length - 1) {
      throw productError('INVALID_LUA_SYNTAX', 'Lua 字符串转义未完成。');
    }
    const simpleEscapes: Readonly<Record<string, string>> = {
      a: '\u0007',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\u000b',
      '\\': '\\',
      '"': '"',
      "'": "'",
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      output += simple;
      continue;
    }
    if (escaped === '\n') {
      output += '\n';
      continue;
    }
    if (escaped === '\r') {
      if (raw[index + 1] === '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }
    if (escaped === 'z') {
      while (index + 1 < raw.length - 1 && /\s/u.test(raw[index + 1] ?? '')) {
        index += 1;
      }
      continue;
    }
    if (escaped === 'x') {
      const hex = raw.slice(index + 1, index + 3);
      if (!/^[a-f0-9]{2}$/iu.test(hex)) {
        throw productError('INVALID_LUA_SYNTAX', 'Lua 十六进制转义无效。');
      }
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u' && raw[index + 1] === '{') {
      const closingIndex = raw.indexOf('}', index + 2);
      if (closingIndex === -1) {
        throw productError('INVALID_LUA_SYNTAX', 'Lua Unicode 转义未闭合。');
      }
      const hex = raw.slice(index + 2, closingIndex);
      if (!/^[a-f0-9]{1,8}$/iu.test(hex)) {
        throw productError('INVALID_LUA_SYNTAX', 'Lua Unicode 转义无效。');
      }
      output += codePoint(hex);
      index = closingIndex;
      continue;
    }
    if (/^[0-9]$/u.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /^[0-9]$/u.test(raw[index + 1] ?? '')) {
        index += 1;
        digits += raw[index];
      }
      const decimal = Number.parseInt(digits, 10);
      if (decimal > 255) {
        throw productError('INVALID_LUA_SYNTAX', 'Lua 十进制转义超过 255。');
      }
      output += String.fromCharCode(decimal);
      continue;
    }
    throw productError('INVALID_LUA_SYNTAX', `不支持的 Lua 字符串转义：\\${escaped}`);
  }
  return output;
}

export function decodeLuaStringLiteral(raw: string): string {
  const longValue = decodeLongString(raw);
  const value = longValue ?? decodeQuotedString(raw);
  if (Buffer.byteLength(value, 'utf8') > DEFAULT_LUA_PARSE_LIMITS.maxStringBytes) {
    throw productError('LUA_LIMIT_EXCEEDED', 'Lua 字符串超过允许大小。');
  }
  return value;
}

function decodeStringLiteral(raw: string, context: EvaluationContext): string {
  const value = decodeLuaStringLiteral(raw);
  ensureStringLimit(value, context);
  return value;
}

function literal(
  expression: Expression,
  path: string,
  context: EvaluationContext,
): string | number | boolean | null {
  if (expression.type === 'StringLiteral') {
    const value = decodeStringLiteral(expression.raw, context);
    if (context.collectMetadata) context.literals.push({ path, kind: 'string', value, range: rangeOf(expression, context.prefixOffset) });
    return value;
  }
  if (expression.type === 'NumericLiteral') {
    if (!Number.isFinite(expression.value)) {
      throw productError('NON_FINITE_NUMBER', 'Lua 数字必须是有限值。');
    }
    if (context.collectMetadata) context.literals.push({ path, kind: 'number', value: expression.value, range: rangeOf(expression, context.prefixOffset) });
    return expression.value;
  }
  if (expression.type === 'BooleanLiteral') {
    if (context.collectMetadata) context.literals.push({ path, kind: 'boolean', value: expression.value, range: rangeOf(expression, context.prefixOffset) });
    return expression.value;
  }
  if (expression.type === 'NilLiteral') {
    if (context.collectMetadata) context.literals.push({ path, kind: 'nil', value: null, range: rangeOf(expression, context.prefixOffset) });
    return null;
  }
  throw productError('UNSAFE_LUA_NODE', `Lua 节点 ${expression.type} 不能作为字面量。`);
}

function evaluateTable(
  expression: TableConstructorExpression,
  path: string,
  depth: number,
  context: EvaluationContext,
): LuaLiteralValue[] | { [key: string]: LuaLiteralValue } {
  const onlyValues = expression.fields.every((field) => field.type === 'TableValue');
  const arrayResult: LuaLiteralValue[] = [];
  const objectResult: { [key: string]: LuaLiteralValue } = {};
  const keys = new Set<string>();
  let implicitIndex = 0;

  expression.fields.forEach((field, fieldIndex) => {
    let key: string | number | boolean;
    let valueExpression: Expression;
    if (field.type === 'TableValue') {
      implicitIndex += 1;
      key = onlyValues ? implicitIndex - 1 : implicitIndex;
      valueExpression = field.value;
    } else if (field.type === 'TableKeyString') {
      key = field.key.name;
      valueExpression = field.value;
    } else {
      const keyValue = literal(field.key, `${path}/@key-${fieldIndex}`, context);
      if (keyValue === null) {
        throw productError('UNSAFE_LUA_NODE', 'Lua 表键不能是 nil。');
      }
      key = keyValue;
      valueExpression = field.value;
    }

    const outputKey = String(key);
    if (keys.has(outputKey)) {
      throw productError('DUPLICATE_LUA_KEY', `Lua 表包含重复键：${outputKey}`);
    }
    keys.add(outputKey);
    const valuePath = childPath(path, key);
    const value = evaluate(valueExpression, valuePath, depth + 1, context);
    if (context.collectMetadata) context.entries.push({
        path: valuePath,
        key,
        entryRange: rangeOf(field, context.prefixOffset),
        valueRange: rangeOf(valueExpression, context.prefixOffset),
      });
    if (onlyValues) {
      arrayResult.push(value);
    } else {
      objectResult[outputKey] = value;
    }
  });

  return onlyValues ? arrayResult : objectResult;
}

function evaluate(
  expression: Expression,
  path: string,
  depth: number,
  context: EvaluationContext,
): LuaLiteralValue {
  if (depth > context.limits.maxDepth) {
    throw productError('LUA_LIMIT_EXCEEDED', 'Lua 字面量嵌套深度超过限制。');
  }
  if (expression.type === 'TableConstructorExpression') {
    return evaluateTable(expression, path, depth, context);
  }
  if (expression.type === 'UnaryExpression') {
    if (expression.operator !== '-' || expression.argument.type !== 'NumericLiteral') {
      throw productError('UNSAFE_LUA_NODE', `不允许 Lua 一元运算 ${expression.operator}。`);
    }
    const value = -expression.argument.value;
    if (!Number.isFinite(value)) {
      throw productError('NON_FINITE_NUMBER', 'Lua 数字必须是有限值。');
    }
    if (context.collectMetadata) context.literals.push({ path, kind: 'number', value, range: rangeOf(expression, context.prefixOffset) });
    return value;
  }
  return literal(expression, path, context);
}

export function decodeLuaUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw productError('INVALID_UTF8', 'Lua 文件不是有效 UTF-8。', error);
  }
}

export function parseLuaLiteralDocument(
  input: string,
  options?: Partial<LuaParseLimits> & { collectMetadata?: boolean },
): LuaLiteralDocument {
  const limits = mergeLimits(options);
  if (Buffer.byteLength(input, 'utf8') > limits.maxSourceBytes) {
    throw productError('LUA_LIMIT_EXCEEDED', 'Lua 文件超过 16 MiB 来源限制。');
  }
  const hasBom = input.startsWith('\uFEFF');
  const source = hasBom ? input.slice(1) : input;
  let nodeCount = 0;
  let chunk;
  try {
    chunk = luaparse.parse(source, {
      comments: false,
      encodingMode: 'none',
      locations: true,
      luaVersion: '5.3',
      onCreateNode: () => {
        nodeCount += 1;
        if (nodeCount > limits.maxNodes) {
          throw productError('LUA_LIMIT_EXCEEDED', 'Lua AST 节点数量超过限制。');
        }
      },
      ranges: true,
      scope: false,
    });
  } catch (error) {
    if (error instanceof ProductError) {
      throw error;
    }
    throw productError('INVALID_LUA_SYNTAX', 'Lua 语法损坏，无法解析。', error);
  }
  if (chunk.body.length !== 1 || chunk.body[0]?.type !== 'ReturnStatement' || chunk.body[0].arguments.length !== 1) {
    throw productError('UNSAFE_LUA_NODE', 'Lua 数据文件必须只包含一个 return 和一个字面量值。');
  }
  const context: EvaluationContext = {
    limits,
    prefixOffset: hasBom ? 1 : 0,
    collectMetadata: options?.collectMetadata !== false,
    literals: [],
    entries: [],
  };
  const root = chunk.body[0].arguments[0];
  if (root === undefined) {
    throw productError('UNSAFE_LUA_NODE', 'Lua return 缺少值。');
  }
  const value = evaluate(root, '', 0, context);
  return {
    value,
    rootRange: rangeOf(root, context.prefixOffset),
    literals: context.literals,
    entries: context.entries,
    nodeCount,
  };
}
