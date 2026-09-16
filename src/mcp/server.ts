import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';

import { toolsForMcpProfile, type YuanmengMcpEnvelope, type YuanmengMcpToolName, type YuanmengMcpToolProfile } from './contracts.js';
import { boundMcpEnvelope, toCallToolResult } from './presentation.js';
import { MCP_PROMPT_SCHEMAS, promptText, promptsForMcpProfile } from './prompts.js';
import {
  MCP_RESOURCE_TITLES,
  MCP_RESOURCE_TOOL_CALLS,
  resourcesForMcpProfile,
  type ResourceGateway
} from './resources.js';
import { MCP_TOOL_INPUT_SCHEMAS } from './tool-schemas.js';

const WRITE_TOOLS: ReadonlySet<YuanmengMcpToolName> = new Set([
  // MCP annotations describe every supported input, including saveBaseline=true.
  'yuanmeng_official_audit',
  'yuanmeng_set_map_display_name',
  'yuanmeng_ui_refresh',
  'yuanmeng_scene_bind',
  'yuanmeng_scene_refresh',
  'yuanmeng_gameplay_review',
  'yuanmeng_gameplay_test',
  'yuanmeng_task_completion_check',
  'yuanmeng_feedback_add',
  'yuanmeng_feedback_resolve',
  'yuanmeng_build_and_send_code'
]);

const NON_IDEMPOTENT_TOOLS: ReadonlySet<YuanmengMcpToolName> = new Set([
  'yuanmeng_feedback_add',
  'yuanmeng_build_and_send_code'
]);

const TOOL_DESCRIPTIONS: Readonly<Record<YuanmengMcpToolName, string>> = {
  yuanmeng_project_status: '读取当前固定工程的本机状态；不修改数据，不能证明官方编辑器运行结果。',
  yuanmeng_task_context: '一次读取当前工程的有界任务上下文：就绪度、场景摘要、缓存告警和玩法最新摘要；只读、不刷新、不模拟、不写地图。',
  yuanmeng_set_map_display_name: '修改当前工程被 Git 忽略的本机显示名；不修改官方地图名。',
  yuanmeng_ui_refresh: '请求刷新当前工程私有 UI 索引；只读取官方已落盘数据。',
  yuanmeng_ui_find: '查询当前工程 UI 索引；不读取编辑器未保存状态。',
  yuanmeng_ui_resolve: '用十进制 ID、完整层级路径或唯一精确名称解析控件；拒绝模糊猜测和重名静默选择。',
  yuanmeng_ui_inspect_screen_point: '查询当前设备屏幕点实际命中的控件；缺少当前快照绑定证据时返回受控只读探针。',
  yuanmeng_ui_runtime_widgets: '读取运行时复制控件与列表子项 ID 台账；仅接受当前 UI 快照绑定的结构化探针证据。',
  yuanmeng_ui_screen_snapshot: '读取单个控件在本次客户端分辨率下的运行时屏幕矩形；无匹配日志时返回只读探针，不猜坐标。',
  yuanmeng_ui_tree_screen_snapshot: '读取控件及全部后代的运行时屏幕矩形；仅接受当前 UI 快照绑定证据。',
  yuanmeng_ui_layout_audit: '审计当前 UI 树的越界、裁切、中心遮挡与可选兄弟重叠；不修改界面。',
  yuanmeng_ui_diff: '比较当前工程 UI 快照；不修改 UI 或官方文件。',
  yuanmeng_ids_list: '列出当前工程私有 ID 台账；不跨工程、不证明运行时绑定。',
  yuanmeng_where_used: '查找当前工程 Lua/UI/场景引用；结果是静态本机证据。',
  yuanmeng_api_search: '搜索本机官方 API 索引；命中签名不等于运行时通过。',
  yuanmeng_official_audit: '只读审查官方 Dream Helper/DreamCode 文件、API 版本差异、模板结构和脚本 ZIP 使用痕迹；默认不写入，saveBaseline=true 只保存插件私有 API 基线。',
  yuanmeng_project_audit: '运行当前工程静态审计；可按 files 定向并用 errorsOnly 精简输出。定向结果不代表全项目通过，也不替代编辑器或多人测试。',
  yuanmeng_scene_status: '读取当前工程场景 binding、快照与新鲜度；不读取未保存选择。',
  yuanmeng_scene_bind: '把明确场景源只读绑定到当前私有工程；绝不写 LayerData。',
  yuanmeng_scene_refresh: '刷新当前工程私有场景快照；原始场景文件保持只读。',
  yuanmeng_scene_find: '查询当前工程场景实例或候选；歧义时不静默选择。',
  yuanmeng_scene_tree: '读取当前工程场景层级；仅静态快照证据。',
  yuanmeng_scene_fields: '检查当前工程场景字段证据；未知字段不猜语义。',
  yuanmeng_group_members: '读取当前工程编组成员；不把普通实例误报为编组。',
  yuanmeng_scene_diff: '比较同工程同血缘场景快照；不修改场景。',
  yuanmeng_scene_near: '按当前快照证据查询邻近对象；不证明运行时碰撞。',
  yuanmeng_scene_audit: '审计当前场景关系、变换与证据缺口；默认返回聚合。',
  yuanmeng_scene_types: '聚合当前工程场景类型与能力证据；未知类型保持待校准。',
  yuanmeng_scene_capability_describe: '按当前场景对象类型和字段证据说明可用事件与接口；不能确认时返回受控测量探针，不猜碰撞能力。',
  yuanmeng_runtime_probe: '只生成白名单内的只读运行时探针：屏幕点、运行时 UI 树或场景能力；不接受任意 Lua。',
  yuanmeng_scene_geometry: '只读查询可信场景包围盒、贴地状态和严格体积穿插；边界接触不算穿插，缺证据时拒绝猜测。',
  yuanmeng_scene_plan: '只生成 execute=false 的空间计划；不写场景文件。',
  yuanmeng_scene_journal: '读取当前工程私有场景变更日志摘要。',
  yuanmeng_property_locate: '生成只读属性定位探针；不直接控制官方编辑器。',
  yuanmeng_gameplay_review: '生成当前工程私有静态玩法审查报告；不等于多人实测。',
  yuanmeng_gameplay_test: '默认从当前生产 Lua 自动准备并尽可能执行有界模型模拟；自动输入可传 preview=true 先做不落盘预览；只有显式提供三条路径时才使用人工严格模式。物理、导航与网络仍需运行时验证。',
  yuanmeng_gameplay_status: '校验并读取当前工程 latest 指向的完整玩法运行包摘要；不运行模拟、不修改工程。',
  yuanmeng_task_completion_check: '完成任务前核对工程、全量静态审计，并按规模或重复失败条件自动准备和模拟可建模生产流程；绝不自动打包或发布。',
  yuanmeng_feedback_add: '向当前工程私有反馈箱新增记录；不上传网络。',
  yuanmeng_feedback_list: '读取当前工程私有反馈箱；不修改状态。',
  yuanmeng_feedback_resolve: '更新当前工程私有反馈记录为已处理；不上传网络。',
  yuanmeng_build_and_send_code: '保存当前工程 Lua、通过静态检查后调用官方 dreamhelper.scriptGen，并核对产物或明确发送输出；不修改 LayerData，不代表地图保存、发布或游戏内共享成功。'
};

export interface McpGatewayLike extends ResourceGateway {
  call(tool: YuanmengMcpToolName, input: unknown, signal: AbortSignal): Promise<YuanmengMcpEnvelope<unknown>>;
}

export interface CreateYuanmengMcpServerOptions {
  readonly gateway: McpGatewayLike;
  readonly version: string;
  readonly toolProfile?: YuanmengMcpToolProfile;
}

function annotations(tool: YuanmengMcpToolName): ToolAnnotations {
  return {
    readOnlyHint: !WRITE_TOOLS.has(tool),
    destructiveHint: false,
    idempotentHint: !NON_IDEMPOTENT_TOOLS.has(tool)
  };
}

export function createYuanmengMcpServer(options: CreateYuanmengMcpServerOptions): McpServer {
  const toolProfile = options.toolProfile ?? 'full';
  const server = new McpServer({
    name: 'yuanmeng-ai-dev-assistant',
    version: options.version
  }, {
    instructions: '仅操作进程启动时固定的当前元梦工程。开始任务优先调用 yuanmeng_task_context 获取有界上下文，再检查状态、新鲜度和证据等级；不得跨地图猜测，不得把静态或模型结果冒充官方编辑器或多人实测。场景源只读，绝不写 LayerData。完成大型、复杂或多人任务前优先使用 yuanmeng_task_completion_check 编排条件化玩法自检；不因自检自动打包或发布。工具档可按 workflow、scene 或 gameplay 缩小，但不改变安全门。'
  });

  for (const tool of toolsForMcpProfile(toolProfile)) {
    server.registerTool(tool, {
      title: tool,
      description: TOOL_DESCRIPTIONS[tool],
      inputSchema: MCP_TOOL_INPUT_SCHEMAS[tool],
      annotations: annotations(tool)
    }, async (input, context) => {
      const envelope = await options.gateway.call(tool, input, context.mcpReq.signal);
      return toCallToolResult(envelope) as CallToolResult;
    });
  }

  for (const uri of resourcesForMcpProfile(toolProfile)) {
    server.registerResource(uri, uri, {
      title: MCP_RESOURCE_TITLES[uri],
      description: '当前固定工程的脱敏本机只读资源；不含原始 LayerData、日志原文或私有绝对路径。',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 0, cacheScope: 'private' }
    }, async (_resourceUri, context) => {
      const call = MCP_RESOURCE_TOOL_CALLS[uri];
      const envelope = await options.gateway.call(call.tool, call.input, context.mcpReq.signal);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(boundMcpEnvelope(envelope))
        }]
      };
    });
  }

  for (const name of promptsForMcpProfile(toolProfile)) {
    const argsSchema = MCP_PROMPT_SCHEMAS[name] as ZodType<Record<string, unknown>>;
    server.registerPrompt(name, {
      title: name,
      description: '编排元梦 MCP 工具并保留证据边界的短提示词。',
      argsSchema
    }, async (args) => ({
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: promptText(name, args) }
      }]
    }));
  }

  return server;
}
