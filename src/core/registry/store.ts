import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { ProductError } from '../errors.js';
import { atomicWriteJson, nodeFileIO, type FileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';
import {
  validateRegistryDocument,
  type RegistryDocument,
  type RegistryEnvironment,
  type RegistryKind,
  type RegistryRecord,
  type RegistryValidity,
  type UiSnapshot,
} from '../model.js';

export type RegistryImportFormat = 'json' | 'yaml' | 'csv';

export interface RegistryFilters {
  kind?: RegistryKind;
  environment?: RegistryEnvironment;
  validity?: RegistryValidity;
}

export interface RegistryImportPreview {
  document: RegistryDocument;
  added: string[];
  removed: string[];
  changed: string[];
  baseSha256: string;
}

export interface PropertyEligibilityInput {
  projectInstanceId: string;
  mapFingerprint: string | null;
  records: readonly RegistryRecord[];
}

export type PropertyEligibility =
  | { allowed: true; warning: string | null; layer: RegistryRecord; instance: RegistryRecord }
  | { allowed: false; warning: string | null; reason: string };

const CSV_HEADERS = [
  'recordId',
  'kind',
  'name',
  'value',
  'scope',
  'projectInstanceId',
  'mapFingerprint',
  'layerId',
  'environment',
  'validity',
  'source',
  'lastConfirmedAt',
  'notes',
] as const;

const MAX_REGISTRY_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_YAML_NESTING = 64;

function validation(message: string, cause?: unknown): never {
  throw new ProductError('VALIDATION_FAILED', message, ['修正注册中心数据后重试。'], 'STATIC_LOCAL', cause);
}

function cloneDocument(document: RegistryDocument): RegistryDocument {
  return JSON.parse(JSON.stringify(document)) as RegistryDocument;
}

function validateImportEnvelope(input: string, format: RegistryImportFormat): void {
  if (Buffer.byteLength(input, 'utf8') > MAX_REGISTRY_IMPORT_BYTES) {
    validation('注册中心导入文件超过 4 MiB 安全上限。');
  }
  if (format !== 'yaml') return;

  let flowDepth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (const line of input.split(/\r?\n/u)) {
    const indentation = /^ */u.exec(line)?.[0].length ?? 0;
    if (indentation > MAX_YAML_NESTING) validation('YAML 嵌套深度超过 64 层安全上限。');
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (doubleQuoted && character === '\\') {
        escaped = true;
        continue;
      }
      if (!doubleQuoted && character === "'") {
        singleQuoted = !singleQuoted;
        continue;
      }
      if (!singleQuoted && character === '"') {
        doubleQuoted = !doubleQuoted;
        continue;
      }
      if (singleQuoted || doubleQuoted) continue;
      if (character === '#') break;
      if (character === '[' || character === '{') {
        flowDepth += 1;
        if (flowDepth > MAX_YAML_NESTING) validation('YAML 嵌套深度超过 64 层安全上限。');
      } else if (character === ']' || character === '}') {
        flowDepth = Math.max(0, flowDepth - 1);
      }
    }
  }
}

function validateImportScope(document: RegistryDocument): void {
  const projects = new Set(document.records.map((record) => record.projectInstanceId));
  const maps = new Set(document.records
    .map((record) => record.mapFingerprint)
    .filter((fingerprint): fingerprint is string => fingerprint !== null));
  if (projects.size > 1) {
    validation('一次导入不能混合多个 projectInstanceId。');
  }
  if (maps.size > 1) {
    validation('一次导入不能混合多个地图指纹。');
  }
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      validation('CSV 引号闭合后只能出现分隔符或换行。');
    }
    if (character === '"') {
      if (field !== '' || afterQuote) {
        validation('CSV 引号只能出现在字段开头。');
      }
      quoted = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\n') {
      pushRow();
    } else if (character === '\r') {
      if (input[index + 1] === '\n') {
        index += 1;
      }
      pushRow();
    } else {
      field += character;
    }
  }
  if (quoted) {
    validation('CSV 包含未闭合的引号。');
  }
  if (field !== '' || row.length > 0 || afterQuote) {
    pushRow();
  }
  return rows.filter((candidate) => candidate.some((value) => value !== ''));
}

function parseCsv(input: string): RegistryDocument {
  const rows = parseCsvRows(input);
  const header = rows.shift();
  if (header === undefined || header.length !== CSV_HEADERS.length || header.some((value, index) => value !== CSV_HEADERS[index])) {
    validation(`CSV 表头必须严格为：${CSV_HEADERS.join(',')}`);
  }
  const records = rows.map((values, rowIndex) => {
    if (values.length !== CSV_HEADERS.length) {
      validation(`CSV 第 ${rowIndex + 2} 行列数无效。`);
    }
    let source: unknown;
    try {
      source = JSON.parse(values[10]!);
    } catch (error) {
      validation(`CSV 第 ${rowIndex + 2} 行 source 不是有效 JSON。`, error);
    }
    return {
      recordId: values[0],
      kind: values[1],
      name: values[2],
      value: values[3],
      scope: values[4],
      projectInstanceId: values[5],
      mapFingerprint: values[6] === '' ? null : values[6],
      layerId: values[7] === '' ? null : values[7],
      environment: values[8],
      validity: values[9],
      source,
      lastConfirmedAt: values[11] === '' ? null : values[11],
      notes: values[12],
    };
  });
  return { schemaVersion: 1, records } as RegistryDocument;
}

function parseImport(input: string, format: RegistryImportFormat): RegistryDocument {
  let value: unknown;
  try {
    validateImportEnvelope(input, format);
    value = format === 'json'
      ? JSON.parse(input)
      : format === 'yaml'
        ? parseYaml(input, { maxAliasCount: 100 })
        : parseCsv(input);
    validateRegistryDocument(value);
    validateImportScope(value);
    return cloneDocument(value);
  } catch (error) {
    if (error instanceof ProductError) {
      throw error;
    }
    validation(`无法解析 ${format.toUpperCase()} 注册中心数据。`, error);
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

export function renderRegistry(document: RegistryDocument, format: RegistryImportFormat): string {
  validateRegistryDocument(document);
  if (format === 'json') {
    return stableJson(document);
  }
  if (format === 'yaml') {
    return stringifyYaml(document, { lineWidth: 0 });
  }
  const rows = document.records.map((record) => [
    record.recordId,
    record.kind,
    record.name,
    record.value,
    record.scope,
    record.projectInstanceId,
    record.mapFingerprint ?? '',
    record.layerId ?? '',
    record.environment,
    record.validity,
    JSON.stringify(record.source),
    record.lastConfirmedAt ?? '',
    record.notes,
  ].map(csvCell).join(','));
  return `${CSV_HEADERS.join(',')}\n${rows.length === 0 ? '' : `${rows.join('\n')}\n`}`;
}

function diffRecords(before: RegistryDocument, after: RegistryDocument): Pick<RegistryImportPreview, 'added' | 'removed' | 'changed'> {
  const beforeById = new Map(before.records.map((record) => [record.recordId, record]));
  const afterById = new Map(after.records.map((record) => [record.recordId, record]));
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id)).sort();
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id)).sort();
  const changed = [...afterById.keys()].filter((id) => (
    beforeById.has(id) && stableJson(beforeById.get(id)) !== stableJson(afterById.get(id))
  )).sort();
  return { added, removed, changed };
}

function sourceForNode(snapshot: UiSnapshot, sourceFile: string): RegistryRecord['source'] {
  const selected = snapshot.sources.find((source) => source.relativePath === sourceFile) ?? snapshot.sources[0];
  if (selected === undefined) {
    validation('UI 快照缺少来源证据。');
  }
  return { ...selected };
}

export class RegistryStore {
  #document: RegistryDocument;
  readonly #path: string | null;
  readonly #io: FileIO;

  constructor(document: RegistryDocument, path: string | null = null, io: FileIO = nodeFileIO) {
    validateRegistryDocument(document);
    this.#document = cloneDocument(document);
    this.#path = path;
    this.#io = io;
  }

  static async open(path: string, io: FileIO = nodeFileIO): Promise<RegistryStore> {
    try {
      const value: unknown = JSON.parse(await io.readFile(path, 'utf8'));
      validateRegistryDocument(value);
      return new RegistryStore(value, path, io);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof ProductError) {
        throw error;
      }
      validation('注册中心 JSON 已损坏。', error);
    }
  }

  list(filters: RegistryFilters = {}): RegistryRecord[] {
    return this.#document.records
      .filter((record) => filters.kind === undefined || record.kind === filters.kind)
      .filter((record) => filters.environment === undefined || record.environment === filters.environment)
      .filter((record) => filters.validity === undefined || record.validity === filters.validity)
      .map((record) => ({ ...record, source: { ...record.source } }))
      .sort((left, right) => left.recordId.localeCompare(right.recordId));
  }

  usableForMap(projectInstanceId: string, mapFingerprint: string): RegistryRecord[] {
    return this.list().filter((record) => (
      record.projectInstanceId === projectInstanceId && record.mapFingerprint === mapFingerprint
    ));
  }

  syncUiSnapshot(snapshot: UiSnapshot, options: { fresh: boolean }): RegistryDocument {
    const targetValidity: RegistryValidity = options.fresh && snapshot.mapFingerprint !== null ? 'confirmed' : 'pending';
    const values = new Set(snapshot.nodes.map((node) => node.id));
    const records = this.#document.records.map((record) => {
      if (
        record.kind !== 'ui-control'
        || record.projectInstanceId !== snapshot.projectInstanceId
        || record.mapFingerprint !== snapshot.mapFingerprint
      ) {
        return record;
      }
      if (!values.has(record.value)) {
        return record.validity === 'invalid' ? record : { ...record, validity: 'suspected-change' as const };
      }
      return record.validity === 'invalid'
        ? record
        : {
          ...record,
          validity: targetValidity,
          lastConfirmedAt: targetValidity === 'confirmed' ? snapshot.createdAt : record.lastConfirmedAt,
        };
    });
    const existingValues = new Set(records.filter((record) => (
      record.kind === 'ui-control'
      && record.projectInstanceId === snapshot.projectInstanceId
      && record.mapFingerprint === snapshot.mapFingerprint
    )).map((record) => record.value));
    for (const node of snapshot.nodes) {
      if (existingValues.has(node.id)) {
        continue;
      }
      records.push({
        recordId: `auto-ui-${sha256Hex(`${snapshot.projectInstanceId}\0${snapshot.mapFingerprint ?? ''}\0${node.id}`)}`,
        kind: 'ui-control',
        name: node.name,
        value: node.id,
        scope: snapshot.mapFingerprint === null ? 'workspace' : 'map',
        projectInstanceId: snapshot.projectInstanceId,
        mapFingerprint: snapshot.mapFingerprint,
        layerId: null,
        environment: 'unspecified',
        validity: targetValidity,
        source: sourceForNode(snapshot, node.sourceFile),
        lastConfirmedAt: targetValidity === 'confirmed' ? snapshot.createdAt : null,
        notes: `UI 路径：${node.path}`,
      });
    }
    this.#document = { schemaVersion: 1, records };
    validateRegistryDocument(this.#document);
    return cloneDocument(this.#document);
  }

  markSuspectedChanges(snapshot: UiSnapshot): RegistryDocument {
    const present = new Set(snapshot.nodes.map((node) => node.id));
    this.#document = {
      schemaVersion: 1,
      records: this.#document.records.map((record) => (
        record.kind === 'ui-control'
        && record.projectInstanceId === snapshot.projectInstanceId
        && record.mapFingerprint === snapshot.mapFingerprint
        && !present.has(record.value)
        && record.validity !== 'invalid'
          ? { ...record, validity: 'suspected-change' }
          : record
      )),
    };
    return cloneDocument(this.#document);
  }

  async previewImport(input: string, format: RegistryImportFormat): Promise<RegistryImportPreview> {
    const document = parseImport(input, format);
    const baseText = this.#path === null ? stableJson(this.#document) : await this.#io.readFile(this.#path, 'utf8');
    return {
      document,
      ...diffRecords(this.#document, document),
      baseSha256: sha256Hex(baseText),
    };
  }

  async commitImport(preview: RegistryImportPreview): Promise<void> {
    if (this.#path === null) {
      validation('内存注册中心没有可提交路径。');
    }
    const currentText = await this.#io.readFile(this.#path, 'utf8');
    if (sha256Hex(currentText) !== preview.baseSha256) {
      validation('注册中心在预览后已变化，请重新预览。');
    }
    validateRegistryDocument(preview.document);
    validateImportScope(preview.document);
    await atomicWriteJson(this.#io, this.#path, preview.document, validateRegistryDocument);
    this.#document = cloneDocument(preview.document);
  }

  async save(): Promise<void> {
    if (this.#path === null) {
      validation('内存注册中心没有可保存路径。');
    }
    await atomicWriteJson(this.#io, this.#path, this.#document, validateRegistryDocument);
  }

  static propertyEligibility(input: PropertyEligibilityInput): PropertyEligibility {
    const layers = input.records.filter((record) => record.kind === 'scene-layer');
    const instances = input.records.filter((record) => record.kind === 'scene-instance');
    if (layers.length !== 1 || instances.length !== 1) {
      return { allowed: false, warning: input.mapFingerprint === null ? '地图身份未由官方确认' : null, reason: '必须选择单个场景层和单个场景元件。' };
    }
    const layer = layers[0]!;
    const instance = instances[0]!;
    const valid = (record: RegistryRecord): boolean => record.validity === 'pending' || record.validity === 'confirmed';
    if (instance.layerId !== null && instance.layerId !== layer.value) {
      return { allowed: false, warning: input.mapFingerprint === null ? '地图身份未由官方确认' : null, reason: '元件不属于所选场景层。' };
    }
    if (input.mapFingerprint !== null) {
      const matches = [layer, instance].every((record) => (
        record.projectInstanceId === input.projectInstanceId
        && record.mapFingerprint === input.mapFingerprint
        && valid(record)
      ));
      return matches
        ? { allowed: true, warning: null, layer, instance }
        : { allowed: false, warning: null, reason: '记录与当前工程或地图身份不匹配。' };
    }
    const safeWithoutMap = [layer, instance].every((record) => (
      record.projectInstanceId === input.projectInstanceId
      && record.mapFingerprint === null
      && record.source.kind === 'user-entry'
      && (record.environment === 'test' || record.environment === 'unspecified')
      && valid(record)
    ));
    return safeWithoutMap
      ? { allowed: true, warning: '地图身份未由官方确认', layer, instance }
      : { allowed: false, warning: '地图身份未由官方确认', reason: '未确认地图身份时仅允许同工程、用户登记的 test/unspecified 单一目标。' };
  }
}
