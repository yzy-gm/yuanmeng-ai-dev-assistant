import type { LinkState } from '../model.js';

export interface CompanionStatusDisplayInput {
  projectName: string;
  mapDisplayName: string | null;
  officialMapName: string | null;
  linkState: LinkState;
  linkReasonCode?: string;
  lastRefreshAt: string | null;
  problemCount: number;
}

export type CompanionStatusSegmentKey = 'project' | 'map' | 'link' | 'refresh' | 'problems';
export type CompanionStatusAction = 'open-wizard' | 'set-map-name';

export interface CompanionStatusSegment {
  key: CompanionStatusSegmentKey;
  text: string;
  tooltip: string;
  action: CompanionStatusAction | null;
}

function linkLabel(state: LinkState): string {
  return state === 'online' ? '已连接' : '未连接';
}

function linkTooltip(state: LinkState, reasonCode: string | undefined): string {
  if (state === 'online' && reasonCode === 'OFFICIAL_OUTPUT_CONNECTED') {
    return '已连接：官方插件输出已报告连接成功（只读日志证据）。';
  }
  if (state === 'offline' && reasonCode === 'OFFICIAL_OUTPUT_DISCONNECTED') {
    return '未连接：官方插件输出已报告联动已结束或没有设备连接。';
  }
  if (state === 'online') return '已连接：已观察到官方联动产生新的 UI 结构证据。';
  if (state === 'offline') return '未连接：官方命令缺失、超时或未响应。';
  return '未连接：尚未获得可确认的官方联动成功证据。';
}

export function formatCompanionStatusSegments(input: CompanionStatusDisplayInput): CompanionStatusSegment[] {
  const mapName = input.mapDisplayName ?? input.officialMapName ?? '未设置';
  const refreshed = input.lastRefreshAt === null ? '刷新:从未' : `刷新:${input.lastRefreshAt}`;
  return [
    { key: 'project', text: input.projectName, tooltip: '打开元梦 AI 开发助手向导。', action: 'open-wizard' },
    { key: 'map', text: `地图:${mapName}`, tooltip: '点击设置或修改当前地图名称。', action: 'set-map-name' },
    { key: 'link', text: `连接:${linkLabel(input.linkState)}`, tooltip: linkTooltip(input.linkState, input.linkReasonCode), action: null },
    { key: 'refresh', text: refreshed, tooltip: '最近一次 UI 结构检查时间。', action: null },
    { key: 'problems', text: `问题:${input.problemCount}`, tooltip: '当前工程诊断问题数量。', action: null },
  ];
}

export function formatCompanionStatus(input: CompanionStatusDisplayInput): string {
  return formatCompanionStatusSegments(input).map((segment) => segment.text).join(' | ');
}
