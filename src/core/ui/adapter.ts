import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import {
  parseLuaLiteralDocument,
  type LuaLiteralDocument,
  type LuaLiteralValue,
  type LuaSourceRange,
} from '../lua/literal-parser.js';
import type { SourceRange, UiNode, UiSourceFile } from '../model.js';

export interface ParsedUiPart {
  document: LuaLiteralDocument;
  sourceFile: UiSourceFile;
}

export interface RawUiExportFile {
  content: string;
  sourceFile: UiSourceFile;
}

const OFFICIAL_UI_PARSE_LIMITS = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxNodes: 1_000_000,
  maxDepth: 256,
  maxStringBytes: 4 * 1024 * 1024,
});

interface SyntheticNodeContract {
  id: string;
  name: string;
  type: string;
  children: LuaLiteralValue[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathComponent(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function isRecord(value: LuaLiteralValue): value is { [key: string]: LuaLiteralValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function anonymousShape(value: LuaLiteralValue, depth = 0): unknown {
  if (depth > 32) {
    return 'depth-limit';
  }
  if (value === null) {
    return 'nil';
  }
  if (Array.isArray(value)) {
    const shapes = value.slice(0, 8).map((item) => anonymousShape(item, depth + 1));
    return { array: shapes, lengthClass: value.length === 0 ? 'empty' : value.length === 1 ? 'one' : 'many' };
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = anonymousShape(value[key] ?? null, depth + 1);
    }
    return result;
  }
  return typeof value;
}

function unsupported(value: LuaLiteralValue, message: string): never {
  const keys = isRecord(value) ? Object.keys(value).sort().join(',') : '(non-object)';
  const structure = sha256Hex(stableJson(anonymousShape(value)));
  throw new ProductError(
    'UNSUPPORTED_UI_SCHEMA',
    `${message}; keys=${keys}; structure=${structure}`,
    ['在无隐私测试工程中校准当前官方 UI 更新文件结构。'],
    'UNIT_E2E',
  );
}

function unsupportedOfficial(value: unknown, message: string): never {
  const structure = sha256Hex(stableJson(value));
  throw new ProductError(
    'UNSUPPORTED_UI_SCHEMA',
    `${message}; structure=${structure}`,
    ['确认官方扩展版本，并在无隐私测试工程中重新校准 UI 更新文件结构。'],
    'STATIC_LOCAL',
  );
}

function sourceRange(range: LuaSourceRange | undefined): SourceRange | null {
  return range === undefined
    ? null
    : {
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn,
    };
}

function parseNode(value: LuaLiteralValue, root: LuaLiteralValue): SyntheticNodeContract {
  if (!isRecord(value)) {
    unsupported(root, 'UI 节点必须是对象');
  }
  const keys = Object.keys(value).sort();
  const expected = ['children', 'id', 'name', 'type'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    unsupported(root, 'UI 节点字段不符合已登记合成契约');
  }
  const rawId = value.id;
  if (
    (typeof rawId !== 'string' || rawId.length === 0)
    && (typeof rawId !== 'number' || !Number.isSafeInteger(rawId))
  ) {
    unsupported(root, 'UI 节点 ID 无效');
  }
  if (typeof value.name !== 'string' || typeof value.type !== 'string' || !Array.isArray(value.children)) {
    unsupported(root, 'UI 节点名称、类型或 children 无效');
  }
  return {
    id: String(rawId),
    name: value.name,
    type: value.type,
    children: value.children,
  };
}

export function parseOfficialUiExportFiles(files: readonly RawUiExportFile[]): ParsedUiPart[] {
  const indexed = files.filter((file) => file.sourceFile === 'src/Data/CustomUIData2.lua');
  if (indexed.length !== 1) {
    unsupportedOfficial({
      indexedProjectionCount: indexed.length,
      sources: files.map((file) => ({
        sourceFile: file.sourceFile,
        byteLengthClass: Buffer.byteLength(file.content, 'utf8') === 0 ? 'empty' : 'non-empty',
      })),
    }, '当前官方更新文件缺少唯一的无损索引投影 CustomUIData2.lua');
  }
  const source = indexed[0]!;
  return [{
    document: parseLuaLiteralDocument(source.content, OFFICIAL_UI_PARSE_LIMITS),
    sourceFile: source.sourceFile,
  }];
}

export function parseSyntheticUiExportFilesForTests(files: readonly RawUiExportFile[]): ParsedUiPart[] {
  return files.map((file) => ({
    document: parseLuaLiteralDocument(file.content),
    sourceFile: file.sourceFile,
  }));
}

function indexedChildren(
  value: { [key: string]: LuaLiteralValue },
  root: LuaLiteralValue,
): readonly string[] {
  const childKeys = Object.keys(value).filter((key) => /^_\d+$/u.test(key));
  childKeys.sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  if (childKeys.some((key, index) => key !== `_${index + 1}`)) {
    unsupportedOfficial(anonymousShape(root), 'UI 索引字段必须从 _1 连续排列');
  }
  return childKeys;
}

export function adaptOfficialUiTables(parts: readonly ParsedUiPart[]): UiNode[] {
  if (parts.length !== 1 || parts[0]?.sourceFile !== 'src/Data/CustomUIData2.lua') {
    unsupportedOfficial(parts.map((part) => ({
      sourceFile: part.sourceFile,
      shape: anonymousShape(part.document.value),
    })), '官方 UI 适配器只接受唯一的 CustomUIData2.lua 无损投影');
  }
  const part = parts[0]!;
  const root = part.document.value;
  if (!isRecord(root)) {
    unsupportedOfficial(anonymousShape(root), 'UI 根值必须是对象');
  }
  const nodes: UiNode[] = [];
  const ids = new Set<string>();
  const entriesByPath = new Map(part.document.entries.map((entry) => [entry.path, entry]));

  const visit = (
    value: LuaLiteralValue,
    parent: UiNode | null,
    siblingIndex: number,
    metadataPath: string,
  ): void => {
    if (!isRecord(value)) {
      unsupportedOfficial(anonymousShape(root), 'UI 索引节点必须是对象');
    }
    const childKeys = indexedChildren(value, root);
    const expectedKeys = new Set(['_uid', '_name', ...childKeys]);
    if (Object.keys(value).some((key) => !expectedKeys.has(key)) || Object.keys(value).length !== expectedKeys.size) {
      unsupportedOfficial(anonymousShape(root), 'UI 索引节点包含未知或缺失字段');
    }
    if (!Number.isSafeInteger(value._uid) || typeof value._name !== 'string') {
      unsupportedOfficial(anonymousShape(root), 'UI 索引节点的 _uid 或 _name 类型无效');
    }
    const id = String(value._uid);
    if (ids.has(id)) {
      throw new ProductError(
        'DUPLICATE_UI_ID',
        `UI ID 重复：${id}`,
        ['在元梦编辑器更新 VSCode 工程后重新获取 UI，并检查官方数据是否损坏。'],
        'STATIC_LOCAL',
      );
    }
    ids.add(id);
    const name = value._name;
    const path = `${parent?.path ?? ''}/${pathComponent(name)}`;
    const entry = entriesByPath.get(metadataPath);
    const node: UiNode = {
      id,
      name,
      type: 'unknown',
      parentId: parent?.id ?? null,
      path,
      depth: parent === null ? 0 : parent.depth + 1,
      siblingIndex,
      sourceFile: part.sourceFile,
      sourceRange: sourceRange(entry?.valueRange),
    };
    nodes.push(node);
    childKeys.forEach((key, childIndex) => {
      visit(value[key] ?? null, node, childIndex, `${metadataPath}/${key}`);
    });
  };

  indexedChildren(root, root).forEach((key, index) => {
    visit(root[key] ?? null, null, index, `/${key}`);
  });
  return nodes.sort((left, right) => compareText(left.path, right.path) || compareText(left.id, right.id));
}

export function adaptSyntheticUiTablesForTests(parts: readonly ParsedUiPart[]): UiNode[] {
  const nodes: UiNode[] = [];
  const ids = new Set<string>();
  let rootSiblingIndex = 0;

  for (const part of parts) {
    const rootValue = part.document.value;
    if (!isRecord(rootValue)) {
      unsupported(rootValue, 'UI 根值必须是对象');
    }
    const rootKeys = Object.keys(rootValue).sort();
    if (
      rootKeys.length !== 2
      || rootKeys[0] !== 'roots'
      || rootKeys[1] !== 'schemaVersion'
      || rootValue.schemaVersion !== 1
      || !Array.isArray(rootValue.roots)
    ) {
      unsupported(rootValue, 'UI 根结构不符合已登记合成契约');
    }

    const visit = (
      rawNode: LuaLiteralValue,
      parent: UiNode | null,
      siblingIndex: number,
      metadataPath: string,
    ): void => {
      const contract = parseNode(rawNode, rootValue);
      if (ids.has(contract.id)) {
        throw new ProductError(
          'DUPLICATE_UI_ID',
          `UI ID 重复：${contract.id}`,
        ['修复官方更新文件中的重复 ID 后重新获取 UI 结构。'],
          'UNIT_E2E',
        );
      }
      ids.add(contract.id);
      const path = `${parent?.path ?? ''}/${pathComponent(contract.name)}`;
      const entry = part.document.entries.find((candidate) => candidate.path === metadataPath);
      const node: UiNode = {
        id: contract.id,
        name: contract.name,
        type: contract.type,
        parentId: parent?.id ?? null,
        path,
        depth: parent === null ? 0 : parent.depth + 1,
        siblingIndex,
        sourceFile: part.sourceFile,
        sourceRange: sourceRange(entry?.valueRange),
      };
      nodes.push(node);
      contract.children.forEach((child, childIndex) => {
        visit(child, node, childIndex, `${metadataPath}/children/${childIndex}`);
      });
    };

    rootValue.roots.forEach((root, index) => {
      visit(root, null, rootSiblingIndex, `/roots/${index}`);
      rootSiblingIndex += 1;
    });
  }

  return nodes.sort((left, right) => compareText(left.path, right.path) || compareText(left.id, right.id));
}
