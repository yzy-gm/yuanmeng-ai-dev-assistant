# 元梦 AI 开发助手

**让 AI 根据你的地图资料写代码，减少手动查 ID、查接口和反复解释工程的时间。**

这是作者 **不见星光** 开发的《元梦之星》VS Code 辅助插件，可与官方“元梦开发助手”一起使用。全部功能免费，源码采用 MIT 许可证开放。

## 能帮你做什么

| 你想做的事 | 插件能提供的帮助 |
|---|---|
| 找按钮、面板和控件 ID | 按名称查控件、层级和代码引用，减少复制 ID、解释 UI 结构的工作。 |
| 让 AI 了解地图里的元件 | 绑定当前地图的场景文件后，查询元件 ID、类型、编组、坐标及保存后的变化。 |
| 检查 Lua 和官方接口 | 检查语法、UI/ID 引用与 API 用法，让 AI 根据本机官方资料排查问题。 |
| 提前找玩法逻辑问题 | 对可识别的流程做模型模拟，检查重复触发、重连、多人争抢等情况；仍需进编辑器试玩。 |
| 检查 UI 布局和场景摆放 | 有足够数据时检查遮挡、越界、贴合与穿插，生成可查看的调整计划。 |
| 把代码交给官方工具处理 | 提供静态检查、改动预览、部分修改的撤销及官方脚本打包交付入口。 |

**插件本身不是聊天 AI。** 你需要另外使用能读取本机工程、执行命令或连接 MCP 的 AI 编程工具；也可以直接通过 VS Code 侧栏和命令面板使用插件。

## 先做这 3 步

1. **安装插件。** 在 [VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=bujianxingguang.yuanmeng-ai-dev-assistant) 安装“元梦 AI 开发助手”。需要 **VS Code 1.134+**；让 AI 使用本地命令或 MCP 时，还需安装 **Node.js 20+**。
2. **打开你的地图工程。** 用 VS Code 打开包含 `src/GameEntry.lua` 的元梦 Lua 工程，保持官方“元梦开发助手”启用并打开联动。
3. **运行新手向导。** 按 `Ctrl+Shift+P`，搜索并执行“**元梦 AI 开发助手: 打开新手向导**”。需要查询 UI 时，先在元梦编辑器中保存，再执行官方“更新 VSCode 工程”。

## 怎么让 AI 使用这个插件

### 方法一：复制这段话给本机 AI，先用起来

适合能读取本机文件、运行终端命令的 AI 编程工具，**不需要先配置 MCP**。让 AI 打开与你的 VS Code 相同的地图工程，把下面的 `[工程路径]` 换成自己的路径：

```text
当前元梦地图的 Lua 工程是：[工程路径]。
我已在 VS Code 安装“元梦 AI 开发助手”，请用它读取工程资料后再帮助我开发。

先读取这个工程的 .yuanmeng-inspector/bin/cli-launcher.json，
再通过同目录的 ymai.cmd 运行 status --json 和 scene-status --json。
确认当前地图身份和数据是否最新，不要使用其他地图的数据，也不要猜控件或元件 ID。

这一步只检查接入状态，不改代码、不绑定场景、不打包。
如果启动器不存在或不可用，请说明缺少哪一步，不要自己伪造启动器。
检查成功后，简要告诉我当前能查询哪些资料，再等待我的具体开发需求。
```

**怎样判断接入成功？** AI 应实际执行命令，并返回当前工程、UI/场景是否就绪等结果；只回复“我已了解插件”不算接入成功。需要手动查看入口时，可在命令面板运行“**元梦 AI 开发助手: 复制当前工程 CLI 命令**”。

普通网页聊天不会因为电脑安装了插件就自动访问本机工程。请使用具有上述本机能力的 AI 工具，并允许它在当前工程中执行所需操作。

### 方法二：连接 MCP，让 AI 直接调用插件工具

MCP 可以理解为“给 AI 接上插件的工具按钮”。已经通过方法一使用的用户，可按需连接。

**Codex Desktop / CLI：**

1. 在打开当前地图工程的 VS Code 中按 `Ctrl+Shift+P`，运行“**元梦 AI 开发助手: 预览 Codex MCP 注册**”。
2. 确认是当前工程，再运行“**元梦 AI 开发助手: 注册/刷新当前工程到 Codex MCP**”，按提示确认。电脑需已安装可用的 Codex。
3. 重新打开 Codex 会话，让 AI **实际调用 `yuanmeng_task_context`**，确认返回的是当前工程。若工具未出现，可先用方法一继续。

**VS Code Agent：** 扩展激活后会为当前工程提供 MCP 服务。运行 `MCP: List Servers` 检查服务状态，再在 Agent 中启用相应工具；如出现信任或启动提示，按客户端提示处理。

默认工具档已包含日常功能。需要高级场景或诊断工具时，再把设置 `yuanmengAi.mcpToolProfile` 改为 `full`，并重新打开相关 AI 会话。详细配置见 [MCP 手册](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/docs/mcp.md)；Codex 通用配置见 [官方 MCP 文档](https://developers.openai.com/codex/mcp)。

### 接入后，可以这样提需求

- “用插件查一下‘购买按钮’的 ID、所属面板，以及哪些 Lua 文件引用了它。”
- “用插件检查这次修改涉及的 Lua 和官方 API，先列问题，不要直接改代码。”
- “查询当前场景里这个编组有哪些成员；数据不足就告诉我缺少什么。”
- “对当前玩法做一次自动模型模拟，重点检查重复领奖和多人同时购买，并列出还要进编辑器测试的部分。”

## 想让 AI 查询场景元件，再绑定一次场景

**UI 数据和场景数据是两回事。** 官方“更新 VSCode 工程”不一定会带上完整场景文件；每个地图工程需要分别绑定自己的场景来源。

在编辑器保存当前地图后，运行“**元梦 AI 开发助手: 导入已存在的场景数据源（私有只读，可选）**”，选择当前地图、当前图层的 `LayerData.dat`、`LayerData-Auto.dat` 或 `LayerData.pbin`，再运行“**刷新场景元件与 ID**”。不知道文件位置时，可让 AI 按 [场景绑定说明](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/docs/usage-guide.md) 协助确认，不要只凭文件修改时间选择。

绑定后，编辑器保存到同一文件的变化会自动刷新。没有场景文件仍可使用 UI 和 Lua 检查，但不能声称已经读到完整地图。

## 使用前了解这几点

- **只能读取已保存的数据。** 插件看不到编辑器中尚未保存的改动，也不能直接读取鼠标当前选中的对象。
- **模拟通过不等于游戏里通过。** 物理、镜头、NPC 和真实多人网络效果仍需在官方编辑器或游戏内验证；脚本打包也不等于地图发布。
- **插件不写回场景文件。** 调整计划、ID 替换和属性修改应先查看差异；实验性属性推送需在自己的地图中验证。
- **插件索引保存在本机工程。** `.yuanmeng-inspector/` 按工程隔离，不随源码开源；插件不上传遥测。连接外部 AI 后，工具返回的内容如何被处理，取决于你使用的 AI 服务及其设置。

## 常见问题

| 遇到的问题 | 先做什么 |
|---|---|
| AI 说找不到插件或启动器 | 确认同一地图工程已在 VS Code 打开，插件已启用，运行新手向导；不要手动编造启动器文件。 |
| UI 查询不到新控件 | 在编辑器保存并“更新 VSCode 工程”；控件对象名称与显示文字不是一回事。 |
| 场景里没有元件 | 检查当前地图是否已绑定正确的场景文件并刷新。 |
| Codex 没有显示 MCP 工具 | 完成当前工程注册后重新打开会话；也可用方法一的本地命令入口。 |
| 官方命令不可用或连接离线 | 保持当前工程的 VS Code 窗口打开，确认官方扩展和联动已启用。 |

## 更新、文档与源码

原扩展 ID 为 `bujianxingguang.yuanmeng-ai-dev-assistant`，老用户直接更新即可。市场安装且开启自动更新的用户沿用原更新渠道；VSIX 用户可从 [版本下载页](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/releases) 下载后，在 VS Code 执行“扩展：从 VSIX 安装…”。卸载可在扩展面板完成。

- [详细使用手册与 CLI 命令](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/docs/usage-guide.md)
- [MCP 工具手册](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/docs/mcp.md)
- [更新记录](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/CHANGELOG.md) · [MIT 开源公告](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/RELEASE_NOTES.md)
- [源码与问题反馈](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant) · [构建与发布](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/docs/public-release.md) · [编辑器验收清单](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/blob/main/docs/editor-acceptance-checklist.md)

第三方工具，非腾讯或《元梦之星》官方产品。插件自有源码采用 MIT 许可证；官方软件、资源与用户地图仍归各自权利人所有。
