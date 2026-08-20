export const PRODUCT_NAME = 'Yuanmeng AI Dev Assistant' as const;
export const PRODUCT_DISPLAY_NAME = '元梦 AI 开发助手' as const;
export const SCHEMA_VERSION = 1 as const;

import { ProductError, type EvidenceLevel } from './errors.js';

export const LINK_STATES = ['unknown', 'online', 'offline'] as const;
export const FRESHNESS_VALUES = ['missing', 'fresh', 'stale'] as const;
export const SOURCE_KINDS = [
  'official-export',
  'official-declaration',
  'user-entry',
  'source-scan',
  'imported-log',
] as const;
export const REGISTRY_KINDS = [
  'ui-control',
  'scene-instance',
  'element-type',
  'scene-layer',
  'signal',
  'camera',
  'other',
] as const;
export const REGISTRY_ENVIRONMENTS = ['test', 'formal', 'unspecified'] as const;
export const REGISTRY_VALIDITIES = ['pending', 'confirmed', 'invalid', 'suspected-change'] as const;
export const REGISTRY_SCOPES = ['workspace', 'map', 'scene-layer'] as const;
export const UI_SOURCE_FILES = ['src/Data/CustomUIData.lua', 'src/Data/CustomUIData2.lua'] as const;
export const CLI_CODES = [
  'OK',
  'OFFLINE',
  'STALE',
  'AMBIGUOUS',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'USAGE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type LinkState = (typeof LINK_STATES)[number];
export type Freshness = (typeof FRESHNESS_VALUES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type RegistryKind = (typeof REGISTRY_KINDS)[number];
export type RegistryEnvironment = (typeof REGISTRY_ENVIRONMENTS)[number];
export type RegistryValidity = (typeof REGISTRY_VALIDITIES)[number];
export type RegistryScope = (typeof REGISTRY_SCOPES)[number];
export type CliCode = (typeof CLI_CODES)[number];

export interface ProjectLayer {
  layerId: string;
  layerName: string;
}

export interface ProjectIdentity {
  schemaVersion: 1;
  projectInstanceId: string;
  projectRootHash: string;
  hasSrc: boolean;
  hasGameEntry: boolean;
  mapFingerprint: string | null;
  mapName: string | null;
  currentLayerId: string | null;
  layers: ProjectLayer[];
}

export interface SourceEvidence {
  kind: SourceKind;
  relativePath: string | null;
  sha256: string;
  observedAt: string;
  officialExtensionVersion: string | null;
  evidence: EvidenceLevel;
}

export interface InspectorStatus {
  schemaVersion: 1;
  project: ProjectIdentity;
  officialCommands: Record<string, boolean>;
  link: { state: LinkState; reasonCode: string; lastProbeAt: string | null };
  ui: {
    freshness: Freshness;
    lastRefreshAt: string | null;
    sourceHashes: Record<string, string>;
    reasonCodes: string[];
  };
  issueCounts: Record<'error' | 'warning' | 'info', number>;
}

export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type UiSourceFile = (typeof UI_SOURCE_FILES)[number];

export interface UiNode {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  path: string;
  depth: number;
  siblingIndex: number;
  sourceFile: UiSourceFile;
  sourceRange: SourceRange | null;
}

export interface UiSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  projectInstanceId: string;
  mapFingerprint: string | null;
  sources: SourceEvidence[];
  nodes: UiNode[];
  duplicateNames: Array<{ name: string; paths: string[] }>;
}

export interface RegistryRecord {
  recordId: string;
  kind: RegistryKind;
  name: string;
  value: string;
  scope: RegistryScope;
  projectInstanceId: string;
  mapFingerprint: string | null;
  layerId: string | null;
  environment: RegistryEnvironment;
  validity: RegistryValidity;
  source: SourceEvidence;
  lastConfirmedAt: string | null;
  notes: string;
}

export interface RegistryDocument {
  schemaVersion: 1;
  records: RegistryRecord[];
}

export interface CliEnvelope<T> {
  schemaVersion: 1;
  ok: boolean;
  code: CliCode;
  message: string;
  data: T | null;
  warnings: string[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'STATIC_LOCAL',
  'UNIT_E2E',
  'EXTENSION_HOST',
  'OFFICIAL_EDITOR_SINGLE',
  'OFFICIAL_EDITOR_MULTI',
  'USER_ATTESTED',
];

function fail(path: string, message: string): never {
  throw new ProductError('VALIDATION_FAILED', `${path}: ${message}`, ['检查数据来源和 Schema 版本。'], 'STATIC_LOCAL');
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, '必须是对象');
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, '字段缺失或包含未知字段');
  }
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(path, '必须是字符串');
  }
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  return value === null ? null : stringAt(value, path);
}

function enumAt<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail(path, `不在允许值 ${values.join(', ')} 中`);
  }
  return value as T;
}

function shaAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (!SHA256_PATTERN.test(text)) {
    fail(path, '必须是小写十六进制 SHA-256');
  }
  return text;
}

function uuidAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (!UUID_PATTERN.test(text)) {
    fail(path, '必须是 UUID');
  }
  return text;
}

function isoAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (!text.endsWith('Z') || !Number.isFinite(Date.parse(text))) {
    fail(path, '必须是 UTC ISO 8601 时间');
  }
  return text;
}

function nullableIsoAt(value: unknown, path: string): string | null {
  return value === null ? null : isoAt(value, path);
}

function validateRelativePath(value: unknown, path: string): void {
  if (value === null) {
    return;
  }
  const text = stringAt(value, path);
  if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/u.test(text) || text.split('/').includes('..')) {
    fail(path, '必须是使用 / 的工程相对路径');
  }
}

function validateSourceEvidence(value: unknown, path: string): void {
  const source = objectAt(value, path);
  exactKeys(source, [
    'kind',
    'relativePath',
    'sha256',
    'observedAt',
    'officialExtensionVersion',
    'evidence',
  ], path);
  enumAt(source.kind, SOURCE_KINDS, `${path}.kind`);
  validateRelativePath(source.relativePath, `${path}.relativePath`);
  shaAt(source.sha256, `${path}.sha256`);
  isoAt(source.observedAt, `${path}.observedAt`);
  nullableStringAt(source.officialExtensionVersion, `${path}.officialExtensionVersion`);
  enumAt(source.evidence, EVIDENCE_LEVELS, `${path}.evidence`);
}

export function validateRegistryDocument(value: unknown): asserts value is RegistryDocument {
  const document = objectAt(value, '$');
  exactKeys(document, ['schemaVersion', 'records'], '$');
  if (document.schemaVersion !== 1 || !Array.isArray(document.records)) {
    fail('$', 'schemaVersion 必须为 1 且 records 必须是数组');
  }
  const recordIds = new Set<string>();
  document.records.forEach((candidate, index) => {
    const path = `$.records[${index}]`;
    const record = objectAt(candidate, path);
    exactKeys(record, [
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
    ], path);
    const recordId = stringAt(record.recordId, `${path}.recordId`);
    if (recordIds.has(recordId)) {
      fail(`${path}.recordId`, '不能重复');
    }
    recordIds.add(recordId);
    enumAt(record.kind, REGISTRY_KINDS, `${path}.kind`);
    stringAt(record.name, `${path}.name`);
    stringAt(record.value, `${path}.value`);
    enumAt(record.scope, REGISTRY_SCOPES, `${path}.scope`);
    uuidAt(record.projectInstanceId, `${path}.projectInstanceId`);
    if (record.mapFingerprint !== null) {
      shaAt(record.mapFingerprint, `${path}.mapFingerprint`);
    }
    nullableStringAt(record.layerId, `${path}.layerId`);
    enumAt(record.environment, REGISTRY_ENVIRONMENTS, `${path}.environment`);
    enumAt(record.validity, REGISTRY_VALIDITIES, `${path}.validity`);
    validateSourceEvidence(record.source, `${path}.source`);
    nullableIsoAt(record.lastConfirmedAt, `${path}.lastConfirmedAt`);
    stringAt(record.notes, `${path}.notes`, true);
  });
}
