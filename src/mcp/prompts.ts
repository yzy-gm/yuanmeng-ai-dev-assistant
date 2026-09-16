import { z } from 'zod';

import type { YuanmengMcpToolProfile } from './contracts.js';

export const MCP_PROMPT_NAMES = [
  'yuanmeng_analyze_current_map',
  'yuanmeng_inspect_scene_object',
  'yuanmeng_review_multiplayer_gameplay',
  'yuanmeng_task_completion_check'
] as const;

export type YuanmengMcpPromptName = (typeof MCP_PROMPT_NAMES)[number];

export const MCP_PROMPT_SCHEMAS = {
  yuanmeng_analyze_current_map: z.object({}).strict(),
  yuanmeng_inspect_scene_object: z.object({
    instanceId: z.string().regex(/^\d{1,20}$/u)
  }).strict(),
  yuanmeng_review_multiplayer_gameplay: z.object({
    focus: z.string().min(1).max(500).optional()
  }).strict(),
  yuanmeng_task_completion_check: z.object({
    focus: z.string().min(1).max(1000).optional()
  }).strict()
} as const;

const MCP_PROMPT_PROFILE_PROMPTS: Readonly<Record<YuanmengMcpToolProfile, readonly YuanmengMcpPromptName[]>> = {
  full: MCP_PROMPT_NAMES,
  workflow: MCP_PROMPT_NAMES,
  scene: ['yuanmeng_analyze_current_map', 'yuanmeng_inspect_scene_object'],
  gameplay: ['yuanmeng_analyze_current_map', 'yuanmeng_review_multiplayer_gameplay', 'yuanmeng_task_completion_check'],
};

export function promptsForMcpProfile(profile: YuanmengMcpToolProfile): readonly YuanmengMcpPromptName[] {
  return MCP_PROMPT_PROFILE_PROMPTS[profile];
}

export function promptText(name: YuanmengMcpPromptName, args: Record<string, unknown>): string {
  switch (name) {
    case 'yuanmeng_analyze_current_map':
      return '先调用 yuanmeng_task_context 获取有界上下文，再调用 yuanmeng_project_status、yuanmeng_scene_status 和 yuanmeng_project_audit；区分新鲜度与证据等级，遇到缺失或陈旧时按 nextActions 修复，不预设结果为通过。';
    case 'yuanmeng_inspect_scene_object':
      return `检查当前工程场景实例 ${String(args.instanceId)}：先调用 yuanmeng_scene_status，再调用 yuanmeng_scene_fields、yuanmeng_scene_tree 和 yuanmeng_where_used；重复或歧义 ID 必须列候选，不跨工程猜测。`;
    case 'yuanmeng_review_multiplayer_gameplay':
      return `审查当前工程多人玩法${typeof args.focus === 'string' ? `，重点关注：${args.focus}` : ''}。先调用 yuanmeng_task_context 获取有界上下文，再调用 yuanmeng_project_status 核对工程身份和新鲜度，随后调用 yuanmeng_project_audit 运行全量静态审查；需要先确认模拟入口而不写运行包时，调用 yuanmeng_gameplay_test 并传 preview=true；确认后再按需运行普通自动模式，检查玩家隔离、服务端权威、并发与生命周期。只有明确提供人工模型、场景目录和输出目录时才进入手工严格模式。自动化结果不得冒充官方编辑器或真实多人实测。`;
    case 'yuanmeng_task_completion_check': {
      const focus = typeof args.focus === 'string' ? `本次任务：${args.focus}。` : '';
      return `${focus}完成当前元梦任务前做条件化自检。先调用 yuanmeng_task_context 获取有界上下文，再调用 yuanmeng_project_status 核对当前工程身份、MCP 和证据新鲜度，随后调用 yuanmeng_project_audit 审查实际改动。若任务属于大型、复杂或多人修改，或触及客户端/服务端联动、网络与玩家身份、共享状态、计时器/回调、存档/奖励/经济、任务与升级链、NPC/导航、跨场景或多文件玩法流程，就必须调用 yuanmeng_gameplay_test，默认自动准备并尽可能模拟可建模生产流程。同一功能连续出错或返工 2 次及以上时，即使原本是小改动也必须升级；先读取日志、失败分支和运行证据，不得继续盲改。全量静态审计问题与模型模拟结果要并列报告，不因无关备份或未知 API 自动跳过可建模流程。只有显式提供人工模型、场景目录和输出目录时才进入手工严格模式。小型 UI、文案、固定 ID、纯布局或不涉及玩法状态的局部修改，且未达到重复失败阈值，才可记录 gameplay-skipped，并说明原因。本流程不调用 yuanmeng_build_and_send_code，不替用户打包、保存地图或发布。模型结果不得冒充官方编辑器或真实多人实测。`;
    }
  }
}
