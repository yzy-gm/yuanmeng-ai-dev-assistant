import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';

export interface DeclarationFileInput {
  relativePath: string;
  source: string;
}

export interface ApiValueDeclaration {
  name: string;
  type: string;
  description: string;
  optional?: boolean;
}

export interface ParsedApiDeclaration {
  key: string;
  module: string;
  name: string;
  callStyle: 'colon' | 'dot';
  description: string;
  signature: string;
  params: ApiValueDeclaration[];
  returns: ApiValueDeclaration[];
}

export type ApiLiteralValue = string | number | boolean | null;

export interface ParsedApiConstantDeclaration {
  key: string;
  module: string;
  name: string;
  description: string;
  value: ApiLiteralValue;
}

export interface ApiEnumMember {
  name: string;
  value: ApiLiteralValue;
}

export interface ParsedApiEnumDeclaration {
  key: string;
  module: string;
  name: string;
  description: string;
  members: ApiEnumMember[];
}

export interface ParsedDeclarationFile {
  relativePath: string;
  sha256: string;
  module: string;
  declarations: ParsedApiDeclaration[];
  constants: ParsedApiConstantDeclaration[];
  enums: ParsedApiEnumDeclaration[];
}

export interface ApiDeclaration extends ParsedApiDeclaration {
  officialExtensionVersion: string;
  source: {
    relativePath: string;
    sha256: string;
  };
}

export interface ApiConstantDeclaration extends ParsedApiConstantDeclaration {
  officialExtensionVersion: string;
  source: {
    relativePath: string;
    sha256: string;
  };
}

export interface ApiEnumDeclaration extends ParsedApiEnumDeclaration {
  officialExtensionVersion: string;
  source: {
    relativePath: string;
    sha256: string;
  };
}

export interface ApiIndex {
  schemaVersion: 2;
  officialExtensionVersion: string;
  declarations: ApiDeclaration[];
  constants: ApiConstantDeclaration[];
  enums: ApiEnumDeclaration[];
}

export type ApiSymbolSearchResult =
  | ({ kind: 'function' } & ApiDeclaration)
  | ({ kind: 'constant' } & ApiConstantDeclaration)
  | ({ kind: 'enum' } & ApiEnumDeclaration);

export interface ApiChange {
  key: string;
  before: ApiDeclaration;
  after: ApiDeclaration;
  changes: Array<'params' | 'returns' | 'description'>;
}

export interface ApiIndexDiff {
  added: ApiDeclaration[];
  removed: ApiDeclaration[];
  changed: ApiChange[];
  constants: {
    added: ApiConstantDeclaration[];
    removed: ApiConstantDeclaration[];
    changed: Array<{ key: string; before: ApiConstantDeclaration; after: ApiConstantDeclaration }>;
  };
  enums: {
    added: ApiEnumDeclaration[];
    removed: ApiEnumDeclaration[];
    changed: Array<{ key: string; before: ApiEnumDeclaration; after: ApiEnumDeclaration }>;
  };
}

function validation(message: string): never {
  throw new ProductError(
    'VALIDATION_FAILED',
    message,
    ['只索引官方 res/lib 下的相对路径空声明文件。'],
    'STATIC_LOCAL',
  );
}

function validateRelativePath(path: string): void {
  const normalized = path.replace(/\\/gu, '/');
  if (
    path.length === 0
    || normalized.startsWith('/')
    || /^[a-z]:\//iu.test(normalized)
    || normalized.split('/').includes('..')
    || !normalized.endsWith('.d.lua')
  ) {
    validation('API 声明来源必须是安全的相对 .d.lua 路径。');
  }
}

function parseValueAnnotation(line: string, kind: 'param' | 'return'): ApiValueDeclaration | null {
  const tag = kind === 'param' ? 'param' : 'return';
  const annotation = new RegExp(`^\\s*---@${tag}\\s+(.+?)\\s*$`, 'u').exec(line);
  if (annotation === null) return null;
  const body = annotation[1]!;
  const commentMatch = /^(.*?)(?:\s+--\s*(.*))$/u.exec(body);
  const declaration = (commentMatch?.[1] ?? body).trim();
  const description = commentMatch?.[2]?.trim() ?? '';
  if (kind === 'param') {
    const match = /^(\S+)\s+(.+)$/u.exec(declaration);
    if (match === null) validation('API @param 注解格式无效。');
    const rawName = match[1]!;
    const name = rawName.endsWith('?') ? rawName.slice(0, -1) : rawName;
    if (name === '') validation('API @param 名称不能为空。');
    const type = match[2]!.trim();
    if (type.startsWith('fun(')) {
      let depth = 0;
      for (const character of type) {
        if (character === '(') depth += 1;
        else if (character === ')') depth -= 1;
        if (depth < 0) validation('API 回调类型括号不匹配。');
      }
      if (depth !== 0 || !type.endsWith(')')) validation('API 回调类型括号不匹配。');
    } else if (/\s/u.test(type)) {
      validation('API @param 的非回调类型不得包含空白。');
    }
    const optional = rawName.endsWith('?')
      || /\bnil\b/u.test(type)
      || /(可选|不传|省略|默认)/u.test(description);
    return optional
      ? { name, type, description, optional: true }
      : { name, type, description };
  }
  const match = /^(\S+)(?:\s+(\S+))?$/u.exec(declaration);
  if (match === null) validation('API @return 注解格式无效。');
  return { name: match[2] ?? 'result', type: match[1]!, description };
}

function splitArguments(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') {
    return [];
  }
  const args = trimmed.split(',').map((argument) => argument.trim());
  if (args.some((argument) => !/^(?:[A-Za-z_][A-Za-z0-9_]*|\.\.\.)$/u.test(argument))) {
    validation('API 空声明包含无法识别的参数名。');
  }
  return args;
}

function parseLiteral(value: string): ApiLiteralValue {
  const trimmed = value.trim();
  if (/^"(?:[^"\\]|\\.)*"$/u.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      validation('API 声明包含无效的字符串字面量。');
    }
  }
  const singleQuoted = /^'([^'\\]*(?:\\.[^'\\]*)*)'$/u.exec(trimmed);
  if (singleQuoted !== null) {
    return singleQuoted[1]!.replace(/\\'/gu, "'").replace(/\\\\/gu, '\\');
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'nil') return null;
  validation('API 常量或枚举成员必须是无副作用字面量。');
}

function nextNonBlank(lines: readonly string[], start: number): number {
  let index = start;
  while (index < lines.length && lines[index]!.trim() === '') index += 1;
  return index;
}

export function parseDeclarationFile(input: DeclarationFileInput): ParsedDeclarationFile {
  validateRelativePath(input.relativePath);
  let moduleName: string | null = null;
  let descriptions: string[] = [];
  let params: ApiValueDeclaration[] = [];
  let returns: ApiValueDeclaration[] = [];
  const declarations: ParsedApiDeclaration[] = [];
  const constants: ParsedApiConstantDeclaration[] = [];
  const enums: ParsedApiEnumDeclaration[] = [];
  const lines = input.source.replace(/\r\n?/gu, '\n').split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const moduleMatch = /^\s*---\s*@module\s+["']([^"']+)["']\s*$/u.exec(line);
    if (moduleMatch !== null) {
      moduleName = moduleMatch[1]!.trim();
      if (moduleName === '') {
        validation('API 声明缺少模块名。');
      }
      descriptions = [];
      params = [];
      returns = [];
      continue;
    }
    const descriptionMatch = /^\s*---(?!@)\s*(.*?)\s*$/u.exec(line);
    if (descriptionMatch !== null) {
      const value = descriptionMatch[1]!.trim();
      if (value !== '') descriptions.push(value);
      continue;
    }
    const param = parseValueAnnotation(line, 'param');
    if (param !== null) {
      params.push(param);
      continue;
    }
    const returned = parseValueAnnotation(line, 'return');
    if (returned !== null) {
      returns.push(returned);
      continue;
    }
    const constantAnnotation = /^\s*---@const\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/u.exec(line);
    if (constantAnnotation !== null) {
      if (moduleName === null || constantAnnotation[1] !== moduleName) {
        validation('API 常量的模块与 @module 不一致。');
      }
      const assignmentIndex = nextNonBlank(lines, lineIndex + 1);
      const assignment = lines[assignmentIndex];
      const assignmentMatch = assignment === undefined ? null : new RegExp(
        `^\\s*${moduleName}_module\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$`,
        'u',
      ).exec(assignment);
      if (assignmentMatch === null || assignmentMatch[1] !== constantAnnotation[2]) {
        validation('API 常量注解与赋值目标不一致。');
      }
      const name = constantAnnotation[2]!;
      constants.push({
        key: `${moduleName}:constant:${name}`,
        module: moduleName,
        name,
        description: descriptions.join(' '),
        value: parseLiteral(assignmentMatch[2]!),
      });
      descriptions = [];
      params = [];
      returns = [];
      lineIndex = assignmentIndex;
      continue;
    }
    const enumAnnotation = /^\s*---@enum\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/u.exec(line);
    if (enumAnnotation !== null) {
      if (moduleName === null || enumAnnotation[1] !== moduleName) {
        validation('API 枚举的模块与 @module 不一致。');
      }
      let cursor = nextNonBlank(lines, lineIndex + 1);
      const start = lines[cursor];
      const startMatch = start === undefined ? null : /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*$/u.exec(start);
      if (startMatch === null) {
        validation('API 枚举必须使用独立的无副作用 local 表声明。');
      }
      const localName = startMatch[1]!;
      const members: ApiEnumMember[] = [];
      const memberNames = new Set<string>();
      cursor += 1;
      let closed = false;
      for (; cursor < lines.length; cursor += 1) {
        const memberLine = lines[cursor]!;
        if (/^\s*\}\s*$/u.test(memberLine)) {
          closed = true;
          break;
        }
        if (memberLine.trim() === '') continue;
        const memberMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?),?\s*$/u.exec(memberLine);
        if (memberMatch === null || memberNames.has(memberMatch[1]!)) {
          validation('API 枚举成员格式无效或名称重复。');
        }
        memberNames.add(memberMatch[1]!);
        members.push({ name: memberMatch[1]!, value: parseLiteral(memberMatch[2]!) });
      }
      if (!closed) validation('API 枚举表没有结束。');
      const assignmentIndex = nextNonBlank(lines, cursor + 1);
      const assignment = lines[assignmentIndex];
      const assignmentMatch = assignment === undefined ? null : new RegExp(
        `^\\s*${moduleName}_module\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*$`,
        'u',
      ).exec(assignment);
      if (
        assignmentMatch === null
        || assignmentMatch[1] !== enumAnnotation[2]
        || assignmentMatch[2] !== localName
      ) {
        validation('API 枚举注解、局部表与模块赋值不一致。');
      }
      const name = enumAnnotation[2]!;
      enums.push({
        key: `${moduleName}:enum:${name}`,
        module: moduleName,
        name,
        description: descriptions.join(' '),
        members,
      });
      descriptions = [];
      params = [];
      returns = [];
      lineIndex = assignmentIndex;
      continue;
    }
    if (/^\s*---@/u.test(line)) {
      continue;
    }
    if (/^\s*function\b/u.test(line)) {
      const match = /^\s*function\s+([A-Za-z_][A-Za-z0-9_.]*)([:.])([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*end\s*$/u.exec(line);
      if (match === null) {
        validation('API 声明文件包含非空函数体或不支持的函数格式。');
      }
      if (moduleName === null) {
        validation('API 函数前缺少 @module 声明。');
      }
      const args = splitArguments(match[4]!);
      const annotated = new Map(params.map((candidate) => [candidate.name, candidate]));
      const resolvedParams = args.map((name) => annotated.get(name) ?? {
        name,
        type: 'unknown',
        description: '',
      });
      const callStyle = match[2] === ':' ? 'colon' : 'dot';
      const name = match[3]!;
      declarations.push({
        key: `${moduleName}:${callStyle}:${name}`,
        module: moduleName,
        name,
        callStyle,
        description: descriptions.join(' '),
        signature: `${moduleName}${match[2]}${name}(${args.join(', ')})`,
        params: resolvedParams,
        returns: [...returns],
      });
      descriptions = [];
      params = [];
      returns = [];
      continue;
    }
    if (line.trim() !== '' && (params.length > 0 || returns.length > 0)) {
      validation('API 参数或返回注解后没有紧邻的空函数声明。');
    }
    if (line.trim() !== '') {
      descriptions = [];
    }
  }
  if (moduleName === null) {
    validation('API 声明文件缺少 @module。');
  }
  return {
    relativePath: input.relativePath.replace(/\\/gu, '/'),
    sha256: sha256Hex(input.source),
    module: moduleName,
    declarations,
    constants,
    enums,
  };
}

export function buildApiIndex(
  files: readonly ParsedDeclarationFile[],
  options: { officialExtensionVersion: string },
): ApiIndex {
  if (options.officialExtensionVersion.trim() === '') {
    validation('官方扩展版本不能为空。');
  }
  const declarations: ApiDeclaration[] = [];
  const constants: ApiConstantDeclaration[] = [];
  const enums: ApiEnumDeclaration[] = [];
  const keys = new Set<string>();
  for (const file of files) {
    for (const declaration of [...file.declarations, ...file.constants, ...file.enums]) {
      if (keys.has(declaration.key)) {
        validation(`API 声明键重复：${declaration.key}`);
      }
      keys.add(declaration.key);
    }
    for (const declaration of file.declarations) declarations.push({
      ...declaration,
      officialExtensionVersion: options.officialExtensionVersion,
      source: { relativePath: file.relativePath, sha256: file.sha256 },
    });
    for (const declaration of file.constants) constants.push({
      ...declaration,
      officialExtensionVersion: options.officialExtensionVersion,
      source: { relativePath: file.relativePath, sha256: file.sha256 },
    });
    for (const declaration of file.enums) enums.push({
        ...declaration,
        officialExtensionVersion: options.officialExtensionVersion,
        source: { relativePath: file.relativePath, sha256: file.sha256 },
      });
  }
  declarations.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  constants.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  enums.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return { schemaVersion: 2, officialExtensionVersion: options.officialExtensionVersion, declarations, constants, enums };
}

function searchable(declaration: ApiDeclaration): string {
  return [
    declaration.module,
    declaration.name,
    declaration.signature,
    declaration.description,
    ...declaration.params.flatMap((value) => [value.name, value.type, value.description]),
    ...declaration.returns.flatMap((value) => [value.name, value.type, value.description]),
  ].join('\n').toLocaleLowerCase();
}

export function searchApi(index: ApiIndex, query: string): ApiDeclaration[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') {
    validation('API 搜索词不能为空。');
  }
  return index.declarations
    .filter((declaration) => searchable(declaration).includes(needle))
    .sort((left, right) => {
      const rank = (candidate: ApiDeclaration): number => {
        const name = candidate.name.toLocaleLowerCase();
        if (name === needle) return 0;
        if (candidate.signature.toLocaleLowerCase() === needle) return 1;
        if (name.startsWith(needle)) return 2;
        return 3;
      };
      return rank(left) - rank(right) || left.key.localeCompare(right.key, 'en');
    });
}

export const MAX_API_SEARCH_RESULTS = 200;

export function searchApiSymbols(
  index: ApiIndex,
  query: string,
  limit = MAX_API_SEARCH_RESULTS,
): ApiSymbolSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') validation('API 搜索词不能为空。');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    validation('API 搜索结果上限必须是 1 到 1000 的整数。');
  }
  const functions = searchApi(index, query).map((declaration): ApiSymbolSearchResult => ({ kind: 'function', ...declaration }));
  const constants = index.constants
    .filter((declaration) => [declaration.module, declaration.name, declaration.description, String(declaration.value)]
      .join('\n').toLocaleLowerCase().includes(needle))
    .map((declaration): ApiSymbolSearchResult => ({ kind: 'constant', ...declaration }));
  const enums = index.enums
    .filter((declaration) => [
      declaration.module,
      declaration.name,
      declaration.description,
      ...declaration.members.flatMap((member) => [member.name, String(member.value)]),
    ].join('\n').toLocaleLowerCase().includes(needle))
    .map((declaration): ApiSymbolSearchResult => ({ kind: 'enum', ...declaration }));
  const rank = (candidate: ApiSymbolSearchResult): number => {
    const name = candidate.name.toLocaleLowerCase();
    if (name === needle) return 0;
    if (candidate.kind === 'constant' && String(candidate.value).toLocaleLowerCase() === needle) return 1;
    if (name.startsWith(needle)) return 2;
    return 3;
  };
  return [...functions, ...constants, ...enums]
    .sort((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key, 'en'))
    .slice(0, limit);
}

export function diffApiIndexes(before: ApiIndex, after: ApiIndex): ApiIndexDiff {
  const oldByKey = new Map(before.declarations.map((value) => [value.key, value]));
  const newByKey = new Map(after.declarations.map((value) => [value.key, value]));
  const added = after.declarations.filter((value) => !oldByKey.has(value.key));
  const removed = before.declarations.filter((value) => !newByKey.has(value.key));
  const changed: ApiChange[] = [];
  for (const current of after.declarations) {
    const previous = oldByKey.get(current.key);
    if (previous === undefined) continue;
    const changes: ApiChange['changes'] = [];
    if (stableJson(previous.params) !== stableJson(current.params)) changes.push('params');
    if (stableJson(previous.returns) !== stableJson(current.returns)) changes.push('returns');
    if (previous.description !== current.description) changes.push('description');
    if (changes.length > 0) {
      changed.push({ key: current.key, before: previous, after: current, changes });
    }
  }
  const oldConstants = new Map(before.constants.map((value) => [value.key, value]));
  const newConstants = new Map(after.constants.map((value) => [value.key, value]));
  const constantAdded = after.constants.filter((value) => !oldConstants.has(value.key));
  const constantRemoved = before.constants.filter((value) => !newConstants.has(value.key));
  const constantChanged = after.constants.flatMap((current) => {
    const previous = oldConstants.get(current.key);
    return previous !== undefined
      && stableJson({ value: previous.value, description: previous.description })
        !== stableJson({ value: current.value, description: current.description })
      ? [{ key: current.key, before: previous, after: current }]
      : [];
  });
  const oldEnums = new Map(before.enums.map((value) => [value.key, value]));
  const newEnums = new Map(after.enums.map((value) => [value.key, value]));
  const enumAdded = after.enums.filter((value) => !oldEnums.has(value.key));
  const enumRemoved = before.enums.filter((value) => !newEnums.has(value.key));
  const enumChanged = after.enums.flatMap((current) => {
    const previous = oldEnums.get(current.key);
    return previous !== undefined
      && stableJson({ members: previous.members, description: previous.description })
        !== stableJson({ members: current.members, description: current.description })
      ? [{ key: current.key, before: previous, after: current }]
      : [];
  });
  return {
    added,
    removed,
    changed,
    constants: { added: constantAdded, removed: constantRemoved, changed: constantChanged },
    enums: { added: enumAdded, removed: enumRemoved, changed: enumChanged },
  };
}
