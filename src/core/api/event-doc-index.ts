import { ProductError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { ApiIndex, ApiConstantDeclaration } from './declaration-index.js';

export type EventScope = 'server' | 'client' | 'both' | 'originator' | 'unknown';
export type EventAvailability = 'matched' | 'declaration-only' | 'doc-only' | 'conflict';

export interface EventCallbackParameter {
  index: number;
  name: string;
  typeText: string;
  description: string;
}

export interface EventDocumentationEntry {
  name: string;
  description: string;
  scope: EventScope;
  scopeRaw: string | null;
  callbackParameters: EventCallbackParameter[];
  callbackState: 'confirmed' | 'partial' | 'missing' | 'conflict';
  registrationConstant: string | null;
  warnings: string[];
  conflicts: string[];
  source: { sourceId: string; sha256: string; lineStart: number; lineEnd: number };
}

export interface EventDocumentationIndex {
  schemaVersion: 1;
  sourceId: string;
  sha256: string;
  events: EventDocumentationEntry[];
}

export interface ResolvedEventMetadata extends EventDocumentationEntry {
  availability: EventAvailability;
  declaration: ApiConstantDeclaration | null;
  generationEligibility: 'allowed' | 'blocked';
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 2_000;
const HEADING = /^### Events\.([A-Z][A-Z0-9_]*)\s*$/u;
const DESCRIPTION = /^\* \u63cf\u8ff0:\s*(.*?)\s*$/u;
const PARAMETER = /^\u4e8b\u4ef6\u4f20\u53c2:\s*([A-Za-z_][A-Za-z0-9_]*):([^\s]+)(?:\s+--\s*(.*))?\s*$/u;
const CALLBACK = /\bfunction\s*\(([^)]*)\)/u;
const REGISTRATION = /System:RegisterEvent\s*\(\s*Events\.([A-Z][A-Z0-9_]*)\s*,/u;

const SCOPES = new Map<string, EventScope>([
  ['\u53ea\u6709\u670d\u52a1\u7aef\u80fd\u6536\u5230', 'server'],
  ['\u53ea\u6709\u5ba2\u6237\u7aef\u80fd\u6536\u5230', 'client'],
  ['\u670d\u52a1\u7aef\u548c\u5ba2\u6237\u7aef\u90fd\u80fd\u6536\u5230', 'both'],
  ['\u5728\u670d\u52a1\u7aef\u548c\u5ba2\u6237\u7aef\u90fd\u80fd\u6536\u5230', 'both'],
  ['\u53ea\u6709\u53d1\u8d77\u521b\u5efa\u7aef\u80fd\u6536\u5230', 'originator'],
]);

const OFFICIAL_TYPO_SCOPES = new Map<string, { raw: string; scope: EventScope }>([
  ['ON_CHARACTER_RUSH', { raw: '\u53ea\u6709\u5ba2\u6237\u7aef\u90fd\u80fd\u6536\u5230', scope: 'client' }],
  ['ON_CHARACTER_DIVE', { raw: '\u53ea\u6709\u5ba2\u6237\u7aef\u90fd\u80fd\u6536\u5230', scope: 'client' }],
  ['ON_PLAYER_CLICK_ITEM', { raw: '\u53ea\u6709\u5ba2\u6237\u7aef\u7aef\u80fd\u6536\u5230', scope: 'client' }],
]);

function invalid(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['\u4f7f\u7528\u672a\u4fee\u6539\u7684\u672c\u5730 Events.md \u6216\u79fb\u9664\u8be5文\u6863\u6765\u6e90\u3002'], 'STATIC_LOCAL');
}

function callbackNames(section: string): string[] | null {
  const match = CALLBACK.exec(section);
  if (match === null) return null;
  const raw = match[1]!.trim();
  if (raw === '') return [];
  const names = raw.split(',').map((value) => value.trim());
  return names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) ? names : null;
}

export function parseEventDocumentation(input: { sourceId: string; source: string }): EventDocumentationIndex {
  if (input.sourceId.trim() === '' || input.sourceId.length > 256) invalid('\u4e8b\u4ef6\u6587\u6863\u6765\u6e90\u6807\u8bc6\u65e0\u6548\u3002');
  if (Buffer.byteLength(input.source, 'utf8') > MAX_BYTES) invalid('Events.md \u8d85\u8fc7 4 MiB \u4e0a\u9650\u3002');
  const source = input.source.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const lines = source.split('\n');
  const sha256 = sha256Hex(source);
  const headings: Array<{ name: string; line: number }> = [];
  for (const [index, line] of lines.entries()) {
    const match = HEADING.exec(line!);
    if (match !== null) headings.push({ name: match[1]!, line: index });
  }
  if (headings.length === 0 || headings.length > MAX_EVENTS) invalid('Events.md \u6ca1\u6709\u53ef\u7528\u7684 Events.* \u7ae0\u8282\u6216\u7ae0\u8282\u8fc7\u591a\u3002');
  if (new Set(headings.map((value) => value.name)).size !== headings.length) invalid('Events.md \u5305\u542b\u91cd\u590d\u4e8b\u4ef6\u7ae0\u8282\u3002');

  const events = headings.map((heading, headingIndex): EventDocumentationEntry => {
    const end = headings[headingIndex + 1]?.line ?? lines.length;
    const sectionLines = lines.slice(heading.line + 1, end);
    const section = sectionLines.join('\n');
    const descriptions = sectionLines.flatMap((line) => {
      const match = DESCRIPTION.exec(line);
      return match === null ? [] : [match[1]!.trim()];
    });
    const warnings: string[] = [];
    const conflicts: string[] = [];
    const exactScopes = descriptions
      .filter((value) => SCOPES.has(value))
      .map((value) => SCOPES.get(value)!);
    const typoScope = OFFICIAL_TYPO_SCOPES.get(heading.name);
    const typoMatched = typoScope !== undefined && descriptions.includes(typoScope.raw);
    const declaredScopes = [...new Set([
      ...exactScopes,
      ...(typoMatched ? [typoScope.scope] : []),
    ])];
    const scopeConflict = declaredScopes.length > 1;
    const scopeRaw = scopeConflict
      ? null
      : exactScopes[0] !== undefined
        ? descriptions.find((value) => SCOPES.has(value))!
        : (typoMatched ? typoScope.raw : null);
    const scope = scopeConflict ? 'unknown' : (declaredScopes[0] ?? 'unknown');
    if (typoMatched) warnings.push('\u5b98\u65b9\u6587\u6863\u7684\u8fd0\u884c\u7aef\u6587\u6848\u542b\u5df2\u77e5\u9519\u5b57，已按精确事件白名单归一。');
    if (scopeConflict) conflicts.push('事件文档声明了多个运行端范围，无法安全归一。');
    if (scope === 'unknown') conflicts.push('\u7f3a\u5c11\u53ef\u4e25\u683c\u8bc6\u522b\u7684\u8fd0\u884c\u7aef\u8303\u56f4\u3002');

    const parameterLines = descriptions.filter((value) => value.startsWith('\u4e8b\u4ef6\u4f20\u53c2:'));
    const callbackParameters: EventCallbackParameter[] = [];
    for (const [index, value] of parameterLines.entries()) {
      const match = PARAMETER.exec(value);
      if (match === null) {
        conflicts.push(`\u7b2c ${index + 1} \u6761\u4e8b\u4ef6\u53c2\u6570\u8bf4\u660e\u65e0\u6cd5\u4e25\u683c\u89e3\u6790\u3002`);
        continue;
      }
      callbackParameters.push({ index, name: match[1]!, typeText: match[2]!, description: match[3]?.trim() ?? '' });
    }
    const names = callbackNames(section);
    let callbackState: EventDocumentationEntry['callbackState'];
    if (names === null) {
      callbackState = 'missing';
      conflicts.push('\u7f3a\u5c11\u53ef\u4e25\u683c\u89e3\u6790\u7684\u56de\u8c03\u51fd\u6570\u53c2\u6570\u3002');
    } else if (parameterLines.length === 0 && names.length === 0) {
      callbackState = 'confirmed';
    } else if (
      callbackParameters.length === parameterLines.length
      && names.length === callbackParameters.length
      && names.every((name, index) => name === callbackParameters[index]!.name)
    ) {
      callbackState = 'confirmed';
    } else {
      callbackState = callbackParameters.length === 0 ? 'partial' : 'conflict';
      conflicts.push('\u7ed3\u6784\u5316\u4e8b\u4ef6\u53c2\u6570\u4e0e\u56de\u8c03\u793a\u4f8b\u7684\u6570\u91cf\u3001\u540d\u79f0\u6216\u987a\u5e8f\u4e0d\u4e00\u81f4\u3002');
    }
    const registrationConstant = REGISTRATION.exec(section)?.[1] ?? null;
    if (registrationConstant === null) conflicts.push('\u6ca1\u6709\u627e\u5230\u4e25\u683c System:RegisterEvent \u793a\u4f8b\u3002');
    else if (registrationConstant !== heading.name) conflicts.push(`\u6ce8\u518c\u793a\u4f8b\u4f7f\u7528 Events.${registrationConstant}，与章节 ${heading.name} 不一致。`);
    const description = descriptions.find((value) => !value.startsWith('\u4e8b\u4ef6\u4f20\u53c2:') && !SCOPES.has(value) && value !== typoScope?.raw) ?? '';
    return {
      name: heading.name,
      description,
      scope,
      scopeRaw,
      callbackParameters,
      callbackState,
      registrationConstant,
      warnings,
      conflicts: [...new Set(conflicts)],
      source: { sourceId: input.sourceId, sha256, lineStart: heading.line + 1, lineEnd: end },
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return { schemaVersion: 1, sourceId: input.sourceId, sha256, events };
}

export function resolveEventMetadata(
  apiIndex: ApiIndex,
  documentation: EventDocumentationIndex | null,
): ResolvedEventMetadata[] {
  const declarations = new Map(apiIndex.constants
    .filter((value) => value.module === 'Events')
    .map((value) => [value.name, value]));
  const docs = new Map((documentation?.events ?? []).map((value) => [value.name, value]));
  const names = [...new Set([...declarations.keys(), ...docs.keys()])].sort((a, b) => a.localeCompare(b, 'en'));
  return names.map((name) => {
    const declaration = declarations.get(name) ?? null;
    const doc = docs.get(name) ?? null;
    const declarationValid = declaration?.value === name;
    const availability: EventAvailability = declaration === null
      ? 'doc-only'
      : doc === null
        ? 'declaration-only'
        : declarationValid
          ? 'matched'
          : 'conflict';
    const base: EventDocumentationEntry = doc ?? {
      name,
      description: declaration?.description ?? '',
      scope: 'unknown',
      scopeRaw: null,
      callbackParameters: [],
      callbackState: 'missing',
      registrationConstant: null,
      warnings: [],
      conflicts: [],
      source: {
        sourceId: declaration?.source.relativePath ?? 'missing-declaration',
        sha256: declaration?.source.sha256 ?? '0'.repeat(64),
        lineStart: 0,
        lineEnd: 0,
      },
    };
    const conflicts = [...base.conflicts];
    if (availability === 'declaration-only') conflicts.push('\u5f53\u524d\u5b98\u65b9\u58f0\u660e\u5b58\u5728，但本地文档没有回调参数和运行端证据。');
    if (availability === 'doc-only') conflicts.push('\u672c\u5730\u6587\u6863\u5b58\u5728，但当前官方扩展声明不存在该事件。');
    if (availability === 'conflict') conflicts.push('\u5f53\u524d\u5b98\u65b9\u4e8b\u4ef6\u5e38\u91cf名与字面值不一致。');
    const generationEligibility = availability === 'matched'
      && base.scope !== 'unknown'
      && base.callbackState === 'confirmed'
      && conflicts.length === 0
      ? 'allowed'
      : 'blocked';
    return { ...base, conflicts, availability, declaration, generationEligibility };
  });
}
