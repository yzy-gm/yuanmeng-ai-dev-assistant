import type { ApiDeclaration, ApiIndex } from '../api/declaration-index.js';
import { ProductError } from '../errors.js';
import type { RegistryDocument, RegistryRecord } from '../model.js';
import { createPatchProposal, type PatchProposal } from '../patch/proposal.js';

export interface ApiSelector {
  module: string;
  name: string;
  callStyle: 'colon' | 'dot';
}

interface CommonGenerateRequest {
  projectInstanceId: string;
  mapFingerprint: string | null;
  targetPath: string;
  existingContent: string | null;
  multiplayer: boolean;
  playerRoutingEvidence: 'callback-derived' | 'not-required' | 'none';
  createdAt: string;
}

export type GenerateLuaRequest = CommonGenerateRequest & (
  | { kind: 'constants'; recordIds: string[] }
  | { kind: 'config'; recordIds: string[] }
  | { kind: 'button-handler'; recordId: string; handlerExpression: string; api: ApiSelector }
  | { kind: 'visibility'; recordId: string; visible: boolean; api: ApiSelector }
  | { kind: 'text-refresh'; recordId: string; text: string; api: ApiSelector }
  | { kind: 'signal-send'; recordId: string; api: ApiSelector }
  | { kind: 'signal-listen'; recordId: string; handlerExpression: string; api: ApiSelector }
);

function validation(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['确认注册记录、地图范围和官方 API 签名后重试。'], 'STATIC_LOCAL');
}

function requireRouting(request: GenerateLuaRequest): void {
  if (request.multiplayer && request.playerRoutingEvidence !== 'callback-derived') {
    throw new ProductError(
      'PLAYER_ROUTING_UNCONFIRMED',
      '多人代码缺少回调来源 playerId 路由证据，已停止生成。',
      ['先从官方回调取得 playerId，并将证据标为 callback-derived。'],
      'STATIC_LOCAL',
    );
  }
}

function selectRecord(request: GenerateLuaRequest, registry: RegistryDocument, recordId: string): RegistryRecord {
  const record = registry.records.find((candidate) => candidate.recordId === recordId);
  if (record === undefined) validation(`注册记录不存在：${recordId}`);
  if (record.projectInstanceId !== request.projectInstanceId) validation(`注册记录属于其他工程：${recordId}`);
  if (
    record.mapFingerprint !== null
    && request.mapFingerprint !== null
    && record.mapFingerprint !== request.mapFingerprint
  ) validation(`注册记录属于其他地图：${recordId}`);
  if (record.validity !== 'confirmed') validation(`注册记录尚未确认：${recordId}`);
  return record;
}

function selectApi(index: ApiIndex, selector: ApiSelector, parameterCount: number): ApiDeclaration {
  const matches = index.declarations.filter((candidate) => (
    candidate.module === selector.module
    && candidate.name === selector.name
    && candidate.callStyle === selector.callStyle
  ));
  if (matches.length === 0) {
    throw new ProductError(
      'API_NOT_FOUND',
      `官方 API 索引未命中：${selector.module}.${selector.name}`,
      ['重建当前官方扩展版本的 API 索引后重试。'],
      'STATIC_LOCAL',
    );
  }
  if (matches.length !== 1) validation(`官方 API 签名存在歧义：${selector.module}.${selector.name}`);
  const declaration = matches[0]!;
  if (declaration.params.length !== parameterCount) {
    validation(`官方 API 参数数量不匹配：${declaration.signature}`);
  }
  return declaration;
}

function luaString(value: string): string {
  const encoded = Array.from(value, (character) => {
    if (character === '\\') return '\\\\';
    if (character === '"') return '\\"';
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 ? `\\${codePoint.toString(10).padStart(3, '0')}` : character;
  }).join('');
  return `"${encoded}"`;
}

function luaValue(value: string): string {
  return /^(?:0|[1-9][0-9]*)$/u.test(value) ? value : luaString(value);
}

function identifier(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/gu, '_').replace(/^([0-9])/u, '_$1').toLocaleUpperCase('en-US');
  return normalized === '' ? 'VALUE' : normalized;
}

function handler(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(value)) {
    validation('处理函数必须是已存在的安全 Lua 标识符路径。');
  }
  return value;
}

function call(api: ApiDeclaration, args: string[]): string {
  const separator = api.callStyle === 'colon' ? ':' : '.';
  return `${api.module}${separator}${api.name}(${args.join(', ')})`;
}

function evidenceComment(record: RegistryRecord): string {
  return `-- record=${record.recordId} environment=${record.environment} validity=${record.validity}`;
}

function appendBlock(existing: string | null, kind: GenerateLuaRequest['kind'], lines: string[]): string {
  const prefix = existing ?? '';
  const separator = prefix === '' || prefix.endsWith('\n') ? '' : '\n';
  return `${prefix}${separator}\n-- Yuanmeng AI generated preview: ${kind}\n${lines.join('\n')}\n`;
}

export function generateLua(
  request: GenerateLuaRequest,
  apiIndex: ApiIndex,
  registry: RegistryDocument,
): PatchProposal {
  requireRouting(request);
  let lines: string[];
  switch (request.kind) {
    case 'constants': {
      if (request.recordIds.length === 0) validation('至少选择一条注册记录。');
      lines = request.recordIds.flatMap((recordId) => {
        const record = selectRecord(request, registry, recordId);
        return [evidenceComment(record), `local ${identifier(record.name)} = ${luaValue(record.value)}`];
      });
      break;
    }
    case 'config': {
      if (request.recordIds.length === 0) validation('至少选择一条注册记录。');
      lines = ['local YuanmengGeneratedConfig = {'];
      for (const recordId of request.recordIds) {
        const record = selectRecord(request, registry, recordId);
        lines.push(`    ${evidenceComment(record)}`, `    ${identifier(record.name)} = ${luaValue(record.value)},`);
      }
      lines.push('}');
      break;
    }
    case 'button-handler': {
      const record = selectRecord(request, registry, request.recordId);
      if (record.kind !== 'ui-control') validation('按钮事件必须使用 UI 控件记录。');
      const api = selectApi(apiIndex, request.api, 2);
      lines = [evidenceComment(record), call(api, [luaValue(record.value), handler(request.handlerExpression)])];
      break;
    }
    case 'visibility': {
      const record = selectRecord(request, registry, request.recordId);
      if (record.kind !== 'ui-control') validation('显隐操作必须使用 UI 控件记录。');
      const api = selectApi(apiIndex, request.api, 2);
      lines = [evidenceComment(record), call(api, [luaValue(record.value), request.visible ? 'true' : 'false'])];
      break;
    }
    case 'text-refresh': {
      const record = selectRecord(request, registry, request.recordId);
      if (record.kind !== 'ui-control') validation('文本刷新必须使用 UI 控件记录。');
      const api = selectApi(apiIndex, request.api, 2);
      lines = [evidenceComment(record), call(api, [luaValue(record.value), luaString(request.text)])];
      break;
    }
    case 'signal-send': {
      const record = selectRecord(request, registry, request.recordId);
      if (record.kind !== 'signal') validation('信号发送必须使用信号记录。');
      const api = selectApi(apiIndex, request.api, 1);
      lines = [evidenceComment(record), call(api, [luaValue(record.value)])];
      break;
    }
    case 'signal-listen': {
      const record = selectRecord(request, registry, request.recordId);
      if (record.kind !== 'signal') validation('信号监听必须使用信号记录。');
      const api = selectApi(apiIndex, request.api, 2);
      lines = [evidenceComment(record), call(api, [luaValue(record.value), handler(request.handlerExpression)])];
      break;
    }
  }
  const newContent = appendBlock(request.existingContent, request.kind, lines);
  return createPatchProposal({
    projectInstanceId: request.projectInstanceId,
    targetPath: request.targetPath,
    originalContent: request.existingContent,
    newContent,
    summary: `generate ${request.kind} from confirmed registry and API evidence`,
    createdAt: request.createdAt,
  });
}
