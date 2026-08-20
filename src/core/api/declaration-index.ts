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

export interface ParsedDeclarationFile {
  relativePath: string;
  sha256: string;
  module: string;
  declarations: ParsedApiDeclaration[];
}

export interface ApiDeclaration extends ParsedApiDeclaration {
  officialExtensionVersion: string;
  source: {
    relativePath: string;
    sha256: string;
  };
}

export interface ApiIndex {
  schemaVersion: 1;
  officialExtensionVersion: string;
  declarations: ApiDeclaration[];
}

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
  const pattern = kind === 'param'
    ? /^\s*---@param\s+(\S+)\s+(\S+)(?:\s+--\s*(.*))?\s*$/u
    : /^\s*---@return\s+(\S+)(?:\s+(\S+))?(?:\s+--\s*(.*))?\s*$/u;
  const match = pattern.exec(line);
  if (match === null) {
    return null;
  }
  if (kind === 'param') {
    return { name: match[1]!, type: match[2]!, description: match[3]?.trim() ?? '' };
  }
  return { name: match[2] ?? 'result', type: match[1]!, description: match[3]?.trim() ?? '' };
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

export function parseDeclarationFile(input: DeclarationFileInput): ParsedDeclarationFile {
  validateRelativePath(input.relativePath);
  let moduleName: string | null = null;
  let descriptions: string[] = [];
  let params: ApiValueDeclaration[] = [];
  let returns: ApiValueDeclaration[] = [];
  const declarations: ParsedApiDeclaration[] = [];

  for (const line of input.source.replace(/\r\n?/gu, '\n').split('\n')) {
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
  const keys = new Set<string>();
  for (const file of files) {
    for (const declaration of file.declarations) {
      if (keys.has(declaration.key)) {
        validation(`API 声明键重复：${declaration.key}`);
      }
      keys.add(declaration.key);
      declarations.push({
        ...declaration,
        officialExtensionVersion: options.officialExtensionVersion,
        source: { relativePath: file.relativePath, sha256: file.sha256 },
      });
    }
  }
  declarations.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  return { schemaVersion: 1, officialExtensionVersion: options.officialExtensionVersion, declarations };
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
  return { added, removed, changed };
}
