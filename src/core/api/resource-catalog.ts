import { basename } from 'node:path';

import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';

export type ResourceIdDomain =
  | 'ability' | 'animation' | 'audio' | 'bubble-emoji' | 'dialog-style' | 'effect'
  | 'face-emote' | 'filter' | 'guide-image' | 'image' | 'item' | 'line-effect'
  | 'npc-appearance' | 'prop' | 'skill' | 'skin-attribute' | 'skin-material'
  | 'skybox' | 'speaker-animation' | 'unknown';

export interface ResourceCatalogSource {
  relativePath: string;
  sha256: string;
}

export interface ParsedResourceCatalogDocument extends ResourceCatalogSource {
  domain: ResourceIdDomain;
  records: Array<{ name: string; id: string; categories: string[] }>;
}

export interface ResourceCatalogRecord {
  domain: ResourceIdDomain;
  name: string;
  id: string;
  categories: string[];
  sources: ResourceCatalogSource[];
  evidence: 'unversioned-local-official-doc';
}

export interface ResourceCatalogIssue {
  code: 'RESOURCE_ID_CONFLICT';
  domain: ResourceIdDomain;
  id: string;
  message: string;
}

export interface ResourceCatalog {
  schemaVersion: 1;
  records: ResourceCatalogRecord[];
  issues: ResourceCatalogIssue[];
}

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 20_000;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const DOMAIN_BY_FILE = new Map<string, ResourceIdDomain>([
  ['abilityid.md', 'ability'], ['animid.md', 'animation'], ['audioid.md', 'audio'],
  ['bubbleemojiid.md', 'bubble-emoji'], ['dialogboxstyleid.md', 'dialog-style'], ['effectid.md', 'effect'],
  ['faceemoteid.md', 'face-emote'], ['filterid.md', 'filter'], ['guideimageid.md', 'guide-image'],
  ['imageid.md', 'image'], ['itemid.md', 'item'], ['iteamid.md', 'item'], ['lineeffectid.md', 'line-effect'],
  ['npcappearanceid.md', 'npc-appearance'], ['propid.md', 'prop'], ['skillid.md', 'skill'],
  ['skinattrname.md', 'skin-attribute'], ['skinmaterialid.md', 'skin-material'], ['skyboxid.md', 'skybox'],
  ['speakeranimid.md', 'speaker-animation'],
]);

function fail(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['检查本地通用数据定义文档。'], 'STATIC_LOCAL');
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((value) => value.replace(/\u00a0/gu, ' ').trim());
}

function isSeparator(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => /^:?-{3,}:?$/u.test(value));
}

export function parseResourceCatalogDocument(input: { relativePath: string; source: string }): ParsedResourceCatalogDocument {
  if (Buffer.byteLength(input.source, 'utf8') > MAX_DOCUMENT_BYTES) fail('单个通用数据定义文档超过 2 MiB 上限。');
  const relativePath = basename(input.relativePath);
  if (relativePath !== input.relativePath || !/^[A-Za-z0-9_.-]+\.md$/u.test(relativePath)) fail('通用数据定义只接受目录内 Markdown 文件名。');
  const domain = DOMAIN_BY_FILE.get(relativePath.toLowerCase()) ?? 'unknown';
  const lines = input.source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');
  const records: ParsedResourceCatalogDocument['records'] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index]!.trim().startsWith('|')) continue;
    const headers = cells(lines[index]!);
    if (!isSeparator(cells(lines[index + 1]!))) continue;
    const idIndex = headers.findIndex((header) => /(?:ID|Id|id)$/u.test(header));
    const nameIndex = headers.findIndex((header) => /(?:名字|名称|Name)$/iu.test(header));
    if (idIndex < 0 || nameIndex < 0) continue;
    index += 2;
    while (index < lines.length && lines[index]!.trim().startsWith('|')) {
      const values = cells(lines[index]!);
      const id = values[idIndex]?.replace(/\s/gu, '') ?? '';
      const name = values[nameIndex]?.trim() ?? '';
      if (id !== '' || name !== '') {
        if (!SAFE_ID.test(id) || name.length === 0 || name.length > 256) fail(`${relativePath} 存在无效资源 ID 或名称。`);
        const categories = values.filter((_value, cellIndex) => cellIndex !== idIndex && cellIndex !== nameIndex && values[cellIndex] !== '');
        records.push({ name, id, categories });
        if (records.length > MAX_ROWS) fail('通用数据定义条目超过安全上限。');
      }
      index += 1;
    }
  }
  return { relativePath, sha256: sha256Hex(input.source), domain, records };
}

export function buildResourceCatalog(documents: readonly ParsedResourceCatalogDocument[]): ResourceCatalog {
  const records = new Map<string, ResourceCatalogRecord>();
  const issues = new Map<string, ResourceCatalogIssue>();
  for (const document of [...documents].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))) {
    for (const candidate of document.records) {
      const key = `${document.domain}\0${candidate.id}`;
      const source = { relativePath: document.relativePath, sha256: document.sha256 };
      const existing = records.get(key);
      if (existing === undefined) {
        records.set(key, { ...candidate, domain: document.domain, sources: [source], evidence: 'unversioned-local-official-doc' });
        continue;
      }
      if (existing.name === candidate.name && stableJson(existing.categories) === stableJson(candidate.categories)) {
        if (!existing.sources.some((value) => value.relativePath === source.relativePath && value.sha256 === source.sha256)) existing.sources.push(source);
        continue;
      }
      issues.set(key, {
        code: 'RESOURCE_ID_CONFLICT', domain: document.domain, id: candidate.id,
        message: `${document.domain} 资源 ID ${candidate.id} 在本地文档中存在冲突；拒绝猜测名称。`,
      });
    }
  }
  return {
    schemaVersion: 1,
    records: [...records.values()].sort((left, right) => left.domain.localeCompare(right.domain, 'en') || left.id.localeCompare(right.id, 'en')),
    issues: [...issues.values()].sort((left, right) => left.domain.localeCompare(right.domain, 'en') || left.id.localeCompare(right.id, 'en')),
  };
}

export function searchResourceCatalog(catalog: ResourceCatalog, query: string): ResourceCatalogRecord[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === '') return [];
  const matches = catalog.records.filter((record) => (
    record.id === query.trim()
    || record.name.toLocaleLowerCase().includes(normalized)
    || record.domain.includes(normalized)
    || record.categories.some((value) => value.toLocaleLowerCase().includes(normalized))
  ));
  return matches.sort((left, right) => (
    Number(right.id === query.trim()) - Number(left.id === query.trim())
    || left.domain.localeCompare(right.domain, 'en')
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id, 'en')
  )).slice(0, 500);
}
