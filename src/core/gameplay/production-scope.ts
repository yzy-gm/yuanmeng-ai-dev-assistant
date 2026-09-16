import luaparse from 'luaparse';

import type { LuaSourceFile } from '../lua/source-index.js';
import { decodeLuaStringLiteral } from '../lua/literal-parser.js';
import type {
  GameplayPreparationFinding,
  GameplayProductionScope,
} from './types.js';

const ENTRY_PATH = 'src/GameEntry.lua' as const;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

interface SourcePoint {
  path: string;
  line: number;
  column: number;
}

interface RequireReference extends SourcePoint {
  module: string | null;
}

type AstRecord = Record<string, unknown> & {
  type?: unknown;
  name?: unknown;
  raw?: unknown;
  base?: unknown;
  arguments?: unknown;
  argument?: unknown;
  loc?: unknown;
};

function finding(
  code: string,
  severity: GameplayPreparationFinding['severity'],
  scope: GameplayPreparationFinding['scope'],
  message: string,
  nextAction: string,
  evidence: SourcePoint[],
): GameplayPreparationFinding {
  return { code, severity, scope, message, nextAction, evidence };
}

function normalizeProjectLuaPath(value: string): string | null {
  const normalized = value.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  if (
    !normalized.startsWith('src/')
    || !normalized.toLowerCase().endsWith('.lua')
    || normalized.includes('\0')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.startsWith('//')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) return null;
  return normalized;
}

function candidatesFor(moduleName: string): string[] | null {
  const normalized = moduleName.replace(/\\/gu, '/');
  if (
    normalized.length === 0
    || normalized.includes('\0')
    || normalized.startsWith('/')
    || normalized.startsWith('//')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || moduleName.split('.').some((segment) => segment.length === 0)
  ) return null;
  const stem = normalized.replace(/\./gu, '/').replace(/^src\//u, '');
  if (stem.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return [`src/${stem}.lua`, `src/${stem}/init.lua`];
}

function astRecord(value: unknown): AstRecord | null {
  return typeof value === 'object' && value !== null ? value as AstRecord : null;
}

function pointFor(path: string, node: AstRecord): SourcePoint {
  const loc = astRecord(node.loc);
  const start = astRecord(loc?.start);
  return {
    path,
    line: typeof start?.line === 'number' ? start.line : 1,
    column: typeof start?.column === 'number' ? start.column + 1 : 1,
  };
}

function identifierName(value: unknown): string | null {
  const node = astRecord(value);
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : null;
}

function stringValue(value: unknown): string | null {
  const node = astRecord(value);
  if (node?.type !== 'StringLiteral' || typeof node.raw !== 'string') return null;
  return decodeLuaStringLiteral(node.raw);
}

function walkAst(value: unknown, visitor: (node: AstRecord) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walkAst(child, visitor);
    return;
  }
  const node = astRecord(value);
  if (node === null) return;
  if (typeof node.type === 'string') visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'range' || key === 'comments') continue;
    walkAst(child, visitor);
  }
}

function parseRequires(file: LuaSourceFile): { references: RequireReference[]; error: unknown | null } {
  if (Buffer.byteLength(file.source, 'utf8') > MAX_FILE_BYTES) {
    return { references: [], error: new Error('Lua source exceeds the gameplay scope size limit') };
  }
  try {
    const chunk = luaparse.parse(file.source.startsWith('\uFEFF') ? file.source.slice(1) : file.source, {
      comments: false,
      locations: true,
      ranges: true,
      luaVersion: '5.3',
      encodingMode: 'none',
    });
    const references: RequireReference[] = [];
    walkAst(chunk, (node) => {
      if (node.type === 'CallExpression' && identifierName(node.base) === 'require') {
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        references.push({ ...pointFor(file.path, node), module: stringValue(args[0]) });
      } else if (node.type === 'StringCallExpression' && identifierName(node.base) === 'require') {
        references.push({ ...pointFor(file.path, node), module: stringValue(node.argument) });
      } else if (node.type === 'TableCallExpression' && identifierName(node.base) === 'require') {
        references.push({ ...pointFor(file.path, node), module: null });
      }
    });
    return { references, error: null };
  } catch (error) {
    return { references: [], error };
  }
}

function compareUnresolved(
  left: { from: string; module: string },
  right: { from: string; module: string },
): number {
  return left.from.localeCompare(right.from, 'en') || left.module.localeCompare(right.module, 'en');
}

export function resolveGameplayProductionScope(
  luaFiles: readonly LuaSourceFile[],
  entryPath: string = ENTRY_PATH,
): GameplayProductionScope {
  const findings: GameplayPreparationFinding[] = [];
  const filesByPath = new Map<string, LuaSourceFile>();
  const validPaths = new Set<string>();

  for (const file of luaFiles) {
    const path = normalizeProjectLuaPath(file.path);
    if (path === null) {
      findings.push(finding(
        'GAMEPLAY_SOURCE_PATH_INVALID', 'fatal', 'project',
        '玩法生产范围收到工程外或无效的 Lua 路径。',
        '只提供 src/ 下的工程相对 Lua 路径。',
        [{ path: file.path, line: 1, column: 1 }],
      ));
      continue;
    }
    validPaths.add(path);
    if (filesByPath.has(path)) {
      findings.push(finding(
        'GAMEPLAY_SOURCE_PATH_DUPLICATE', 'fatal', 'project',
        `Lua 文件路径重复，无法确定生产来源：${path}`,
        '移除重复路径后重试。',
        [{ path, line: 1, column: 1 }],
      ));
      continue;
    }
    filesByPath.set(path, { path, source: file.source });
  }

  const normalizedEntry = normalizeProjectLuaPath(entryPath);
  if (normalizedEntry !== ENTRY_PATH) {
    findings.push(finding(
      'GAMEPLAY_ENTRY_PATH_INVALID', 'fatal', 'project',
      '自动玩法范围只接受当前工程的 src/GameEntry.lua 作为生产入口。',
      '恢复或选择当前工程的 src/GameEntry.lua。',
      [{ path: entryPath, line: 1, column: 1 }],
    ));
    return {
      entryPath: ENTRY_PATH,
      reachablePaths: [],
      excludedPaths: [...validPaths].sort((left, right) => left.localeCompare(right, 'en')),
      unresolvedRequires: [],
      findings,
    };
  }

  if (!filesByPath.has(ENTRY_PATH)) {
    findings.push(finding(
      'GAMEPLAY_PRODUCTION_ENTRY_MISSING', 'fatal', 'project',
      '当前工程缺少 src/GameEntry.lua，无法建立生产玩法范围。',
      '从元梦编辑器重新导出当前工程 Lua 源码。',
      [{ path: ENTRY_PATH, line: 1, column: 1 }],
    ));
    return {
      entryPath: ENTRY_PATH,
      reachablePaths: [],
      excludedPaths: [...validPaths].sort((left, right) => left.localeCompare(right, 'en')),
      unresolvedRequires: [],
      findings,
    };
  }

  const reachable = new Set<string>();
  const unresolved = new Map<string, { from: string; module: string }>();
  const queue: string[] = [ENTRY_PATH];
  let resolvedStaticFromEntry = 0;
  const dynamicReferences: RequireReference[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    const file = filesByPath.get(path)!;
    const parsed = parseRequires(file);
    if (parsed.error !== null) {
      findings.push(finding(
        'GAMEPLAY_REACHABLE_LUA_INVALID', 'fatal', 'flow',
        `生产可达 Lua 无法解析：${path}`,
        '修复该生产文件的 Lua 语法或大小问题后重试。',
        [{ path, line: 1, column: 1 }],
      ));
      continue;
    }

    for (const reference of parsed.references) {
      if (reference.module === null) {
        dynamicReferences.push(reference);
        const key = `${path}\0<dynamic>`;
        unresolved.set(key, { from: path, module: '<dynamic>' });
        continue;
      }
      const candidates = candidatesFor(reference.module);
      if (candidates === null) {
        const key = `${path}\0${reference.module}`;
        unresolved.set(key, { from: path, module: reference.module });
        findings.push(finding(
          'GAMEPLAY_REQUIRE_PATH_INVALID', 'fatal', 'flow',
          `生产 require 试图使用无效或越界模块路径：${reference.module}`,
          '将 require 改为当前工程 src/ 下的静态模块名。',
          [reference],
        ));
        continue;
      }
      const matches = candidates.filter((candidate) => filesByPath.has(candidate));
      if (matches.length !== 1) {
        const key = `${path}\0${reference.module}`;
        unresolved.set(key, { from: path, module: reference.module });
        findings.push(finding(
          matches.length === 0 ? 'GAMEPLAY_REQUIRE_NOT_FOUND' : 'GAMEPLAY_REQUIRE_AMBIGUOUS',
          'fatal', 'flow',
          matches.length === 0
            ? `生产模块无法解析：${reference.module}`
            : `生产模块同时匹配多个文件：${reference.module}`,
          matches.length === 0
            ? '补齐被 require 的生产 Lua 文件后重试。'
            : '只保留 module.lua 或 module/init.lua 中一个明确入口。',
          [reference],
        ));
        continue;
      }
      if (path === ENTRY_PATH) resolvedStaticFromEntry += 1;
      queue.push(matches[0]!);
    }
  }

  for (const reference of dynamicReferences) {
    const isSoleEntry = reference.path === ENTRY_PATH && resolvedStaticFromEntry === 0;
    findings.push(finding(
      'GAMEPLAY_DYNAMIC_REQUIRE_UNMODELED', isSoleEntry ? 'fatal' : 'partial', 'flow',
      '动态 require 的目标不能由静态证据确定。',
      isSoleEntry
        ? '把唯一生产入口改为静态 require，或在官方编辑器中提供可验证入口。'
        : '在官方编辑器中补测该动态加载分支。',
      [reference],
    ));
  }

  const reachablePaths = [...reachable].sort((left, right) => left.localeCompare(right, 'en'));
  const excludedPaths = [...validPaths]
    .filter((path) => !reachable.has(path))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const unresolvedRequires = [...unresolved.values()].sort(compareUnresolved);
  findings.sort((left, right) => (
    left.evidence[0]!.path.localeCompare(right.evidence[0]!.path, 'en')
    || left.evidence[0]!.line - right.evidence[0]!.line
    || left.code.localeCompare(right.code, 'en')
  ));

  return { entryPath: ENTRY_PATH, reachablePaths, excludedPaths, unresolvedRequires, findings };
}
