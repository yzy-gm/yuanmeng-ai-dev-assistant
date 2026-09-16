import type { YuanmengMcpEnvelope, YuanmengMcpToolName, YuanmengMcpToolProfile } from './contracts.js';

export const MCP_RESOURCE_URIS = [
  'yuanmeng://project/current/status',
  'yuanmeng://project/current/ui',
  'yuanmeng://project/current/scene/status',
  'yuanmeng://project/current/scene/context',
  'yuanmeng://project/current/registry',
  'yuanmeng://project/current/gameplay/latest',
  'yuanmeng://project/current/feedback/open'
] as const;

export type YuanmengMcpResourceUri = (typeof MCP_RESOURCE_URIS)[number];

export interface ResourceToolCall {
  readonly tool: YuanmengMcpToolName;
  readonly input: Readonly<Record<string, unknown>>;
}

export const MCP_RESOURCE_TOOL_CALLS: Readonly<Record<YuanmengMcpResourceUri, ResourceToolCall>> = {
  'yuanmeng://project/current/status': { tool: 'yuanmeng_project_status', input: {} },
  'yuanmeng://project/current/ui': { tool: 'yuanmeng_ids_list', input: { kind: 'ui-control', allowStale: true, limit: 50 } },
  'yuanmeng://project/current/scene/status': { tool: 'yuanmeng_scene_status', input: {} },
  'yuanmeng://project/current/scene/context': { tool: 'yuanmeng_scene_types', input: { limit: 50 } },
  'yuanmeng://project/current/registry': { tool: 'yuanmeng_ids_list', input: { allowStale: true, limit: 50 } },
  'yuanmeng://project/current/gameplay/latest': { tool: 'yuanmeng_gameplay_status', input: {} },
  'yuanmeng://project/current/feedback/open': { tool: 'yuanmeng_feedback_list', input: { status: 'open', limit: 50 } }
};

export const MCP_RESOURCE_TITLES: Readonly<Record<YuanmengMcpResourceUri, string>> = {
  'yuanmeng://project/current/status': '当前元梦工程状态',
  'yuanmeng://project/current/ui': '当前工程 UI 索引摘要',
  'yuanmeng://project/current/scene/status': '当前工程场景状态',
  'yuanmeng://project/current/scene/context': '当前工程脱敏场景上下文',
  'yuanmeng://project/current/registry': '当前工程 ID 台账摘要',
  'yuanmeng://project/current/gameplay/latest': '当前工程玩法证据摘要',
  'yuanmeng://project/current/feedback/open': '当前工程未处理反馈'
};

const MCP_RESOURCE_PROFILE_RESOURCES: Readonly<Record<YuanmengMcpToolProfile, readonly YuanmengMcpResourceUri[]>> = {
  full: MCP_RESOURCE_URIS,
  workflow: [
    'yuanmeng://project/current/status',
    'yuanmeng://project/current/ui',
    'yuanmeng://project/current/scene/status',
    'yuanmeng://project/current/registry',
    'yuanmeng://project/current/gameplay/latest',
  ],
  scene: [
    'yuanmeng://project/current/status',
    'yuanmeng://project/current/ui',
    'yuanmeng://project/current/scene/status',
    'yuanmeng://project/current/scene/context',
    'yuanmeng://project/current/registry',
  ],
  gameplay: [
    'yuanmeng://project/current/status',
    'yuanmeng://project/current/scene/status',
    'yuanmeng://project/current/scene/context',
    'yuanmeng://project/current/gameplay/latest',
    'yuanmeng://project/current/feedback/open',
  ],
};

export function resourcesForMcpProfile(profile: YuanmengMcpToolProfile): readonly YuanmengMcpResourceUri[] {
  return MCP_RESOURCE_PROFILE_RESOURCES[profile];
}

export interface ResourceGateway {
  call(tool: YuanmengMcpToolName, input: unknown, signal: AbortSignal): Promise<YuanmengMcpEnvelope<unknown>>;
}
