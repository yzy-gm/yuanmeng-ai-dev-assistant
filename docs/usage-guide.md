# 元梦 AI 开发助手：详细使用手册

首次使用请先看 [首页快速上手](../README.md)。本页保留场景绑定、命令参数、玩法模拟与证据边界等详细说明。

## 快速开始

1. 打开一个独立的元梦 Lua 工程，确认存在 `src/GameEntry.lua`。
2. 保持官方扩展启用并打开官方联动。
3. 执行“元梦 AI 开发助手: 打开新手向导”。向导按 UI、场景、台账、Lua、官方 API、单元件属性和脚本构建排列完整流程；选择具体步骤才会执行对应命令，修改与构建仍会单独预览、确认。
   - 底部状态栏按“工程 / 地图 / 连接 / 刷新 / 问题”分成独立项；只有“地图:未设置”（或当前地图名）这一项可以点击并输入/修改地图名称。名称保存在当前工程被 Git 忽略的 `.yuanmeng-inspector/project-display.json`，只用于本机显示和 AI 识别，不改变官方地图身份或地图指纹。
   - 场景状态栏只显示场景元件数，并附带 `UI:n 个控件`；不会再把地图工程文件夹名当作场景名显示。连接状态只显示“已连接/未连接”；同一 VS Code 窗口内检测到官方 Dream Helper 输出的“连接成功”标记时显示“已连接”，不要求 UI 文件必须发生变化。
   - 也可以直接告诉本机 AI 当前地图名；AI 运行 `set-map-name <地图名称> --json` 后，插件会自动读取变化并刷新状态栏，不需要用户再点设置。
4. 在元梦编辑器中命名或调整控件后，在编辑器侧选择“更新 VSCode 工程”。`CustomUIData.lua`/`CustomUIData2.lua` 落盘后，插件会按工程防抖并稳定采样，自动刷新 UI 索引；“获取自定义界面结构”命令继续作为手动兜底。这个过程读取官方更新后的文件，不是把文件导入元梦画布。
   - 要测试不同控件名，请修改 UI 控件右侧顶部带铅笔的对象名称，并在编辑器层级树确认名称已真正改变、保存后再更新 VSCode 工程；“显示的文字”只是视觉文本值，可能不会改变 UI 结构文件。
   - “编程元件”窗口中的“下载工程 / 开启调试 / 导入脚本”属于编程元件工程连接链路；UI 结构更新走官方 `dreamhelper.GetCustomUIData` 命令，不依赖该窗口提供第四个按钮。
5. 唯一名称可直接查询；重名会列出完整路径候选，不会静默选错。
6. 场景索引是可选能力：只有工程实际存在官方落盘的 `LayerData.dat`、`LayerData-Auto.dat` 或 `LayerData.pbin` 时，才执行“导入已存在的场景数据源（私有只读，可选）”。官方编辑器没有提供这些文件时，插件会直接提示跳过；它不会读取编辑器内存或伪造场景快照。
7. 在“场景元件与编组”中可复制实例 ID/类型 ID/层级路径/Lua 常量/JSON 片段、查找 Lua 引用、查看 owner 与编组成员、检查字段证据和静态类型覆盖率、生成官方 API 测量探针、按自定义属性名定位实例，或生成贴地/对齐/等距/网格/行列/批量偏移预览。按信号名查询时会先按 owner/编组结构聚合候选编组，再列成员；候选不会冒充已确认的玩家自制物品。
8. 场景元件能力分为两条链：有 LayerData 时建立完整场景快照/树/查询/diff；没有 LayerData 时，用户仍可显式导入选中元件 ID，走单元件官方属性读取和只读运行时探针。后者是“已登记元件/运行时证据”，不是全场景枚举，插件不会后台猜测或读取编辑器内存。
9. “场景变更”只列当前 binding/role/adapter 的连续快照摘要；“空间计划”只保存当前 VSCode 会话、当前快照的 `execute=false` 预览。若只能从编辑器复制选中元件 ID，显式运行“从剪贴板显式导入当前场景实例 ID”，选择目标工程并确认后才登记为 `pending`；插件不会后台监控剪贴板。
10. 删除/重建元件导致 ID 改变时，运行“场景 ID 安全重绑”。它只比较同 lineage 前后快照；任一歧义/证据不足都不修改 Lua。只有全部唯一且台账/场景/源码哈希仍一致时，才能选择单个 Lua 文件预览、二次确认并创建可撤销备份。
11. “生成匿名私有诊断包”只输出版本、稳定错误码、计数、哈希前 12 位和匿名结构统计，不包含实例/UI ID、名称、信号、绝对路径、raw 或日志原文。
12. 实际使用中发现错误、费时步骤或改进建议时，运行“记录本地使用反馈”；插件自动附带当前插件版本、UI 快照和场景快照。AI 也可以直接运行 `feedback add`，不需要用户点弹窗。所有反馈只写当前工程的 `.yuanmeng-inspector/feedback`，可通过“打开本地反馈箱”集中查看。

### 每个地图怎样首次绑定场景源

场景绑定是**每个地图 Lua 工程各做一次**，不是全局安装一次。官方“更新 VSCode 工程”通常能更新 Lua/UI 文件，但不会自动把完整 `LayerData` 放进 Lua 工程；插件必须知道当前地图在本机 UGC 缓存中的准确文件，才能读取场景 ID、类型、Owner、编组和坐标。

默认由本机 AI 先操作，不要求用户点击：AI 读取当前工程的 `.yuanmeng-inspector/bin/cli-launcher.json`，调用项目本地 `ymai.cmd` 检查、绑定、刷新并查询。只有第一次绑定新地图且存在多个无法由地图目录、已知 ID 或用户刚保存证据唯一消歧的 `LayerData` 候选时，才让用户在文件选择器中选择一次。

人工兜底操作：

1. 在元梦编辑器保存当前地图。
2. 回到打开该地图工程的 VS Code 窗口，按 `Ctrl+Shift+P`。
3. 运行“元梦 AI 开发助手: 导入已存在的场景数据源（私有只读，可选）”。
4. 选择当前地图、当前图层目录中的 `LayerData.dat`、`LayerData-Auto.dat` 或 `LayerData.pbin`。
5. 再运行“元梦 AI 开发助手: 刷新场景元件与 ID”。“场景元件与编组”显示实例数量后即完成。

文件通常位于：

```text
<元梦安装目录>\LetsGo\GameData\Saved\UGCLevelData\ugc\<账号目录>\<地图目录>\<图层目录>\LayerData.pbin
```

给本机 AI 操作（首选入口）：

```powershell
$ymai = '<当前地图工程>\.yuanmeng-inspector\bin\ymai.cmd'
& $ymai scene-status --json
& $ymai bind-scene raw-pbin '<当前地图的 LayerData.pbin 绝对路径>' --json
& $ymai refresh-scene raw-pbin --json
& $ymai scene-status --json
& $ymai field-inspect '<已知实例ID>' --json
& $ymai group-members '<已知编组ID>' --json
```

对应关系是：`LayerData.dat` 使用 `manual-dat`，`LayerData-Auto.dat` 使用 `auto-dat`，`LayerData.pbin` 使用 `raw-pbin`。AI 只有在路径已由当前地图证据唯一确认时才能直接绑定；不能只按修改时间选择最新文件，也不能沿用另一地图的绑定。若 `scene-status` 返回 `bindings: []`，路径已确认时 AI 必须直接执行 `bind-scene`、`refresh-scene` 和已知 ID 校验；只有路径不能唯一确认时才给出上述人工文件选择入口，不能只回复“请添加场景源”。

绑定记录保存在当前工程被 Git 忽略的 `.yuanmeng-inspector/scene/`。同一个源文件后续保存变化可直接刷新；地图或图层换成新的 UGC 目录时重新绑定。`field-inspect` 能找到 ID 而 `group-members` 返回 `SCENE_GROUP_NOT_FOUND`，说明是 ID 分类或编组解析问题，不是场景源仍未绑定。

绑定完成后无需每次手动点刷新：编辑器把新增、删除、坐标、旋转、缩放、Owner、编组、属性或信号变化保存到同一个已绑定文件后，插件会防抖、等待文件稳定、生成新快照和差异。UI 的 `CustomUIData*.lua` 落盘后也会自动刷新。尚未保存的编辑器内存状态仍无法读取。

## AI 任务上下文与 MCP 工具档

开始一个新任务时，推荐先调用 MCP 的 `yuanmeng_task_context`。它一次返回当前工程身份、UI/场景/Lua/代码交付就绪度、私有缓存体积告警、玩法 latest 摘要和官方数据源摘要；输出有界，只保留相对路径、计数和短哈希前缀，不刷新、不运行模拟、不打包、不写地图。

MCP 默认使用 `workflow` 工具档，保留日常 UI、场景、Lua、审计、玩法模拟和代码交付能力，同时隐藏低频运行时探针、几何规划和高级诊断工具，以减少 Codex 的工具选择与上下文负担。把 VS Code 设置 `yuanmengAi.mcpToolProfile` 改为 `full`、`scene` 或 `gameplay` 后，项目本地 MCP 进程只暴露对应目录；切换后会自动刷新项目启动器，已注册的 Codex MCP 需要重新打开会话。这个设置不改变任何工程身份校验或写入门禁。

如果希望索引官方安装数据，可配置 `yuanmengAi.gameInstallPath`（游戏安装根目录）和 `yuanmengAi.ugcDataPath`（通常指向 `<游戏安装目录>/LetsGo/GameData/Saved`）。插件只读取版本文本、`LetsGo/GameData/Saved/PersistentDownloadDir` 下的静态配置文件名、UGC 使用键/记录数和脚本包文件名；不会解密、执行或修改 `.pbin`、`.ldata`、地图源文件或账号数据。`scene-status` 的缓存摘要超过阈值只告警，`cleanSceneCache` 仍必须逐次人工确认。

## AI 玩法测试助手（0.6）

默认入口是“AI 玩法测试：自动准备并尽可能模拟”。它从 `src/GameEntry.lua` 的生产可达 `require` 闭包读取当前 Lua，并结合 ID/信号台账、UI/场景快照和官方事件元数据，自动提取有证据的入口、运行侧、状态写入、事件发射、计时器与守卫；随后按事件与运行端去重并优先选择根入口，为最多 5 个入口分别生成单人、重复、重连和 2/4/8 人竞争场景；另保留最多 2 个独立事件链诊断，总数不超过 32。超出预算的入口以 GAMEPLAY_ENTRANCE_SCENARIO_BUDGET 列为未覆盖，不宣称穷尽验证。与当前流程无关的信号盒、不可达坏备份和局部未知 API 仍完整留在严格审查中，但不会仅凭这些无关项阻止可确认流程进入模拟。

自动模式无需人工 `spec.json` 或 `scenarios/`：VS Code 运行默认命令；CLI 运行 `gameplay-test --json`，也可附加 `--focus <说明>` 与重复的 `--file <src/相对路径>`；MCP 调用 `yuanmeng_gameplay_test` 时省略三个人工路径。需要验证“只读、不落盘”时使用 CLI `gameplay-test --preview --json`，或在 MCP 自动输入中传 `preview: true`；它仍完整执行自动建模和模型模拟，但不创建玩法运行包、不切换 `latest.json`。普通自动运行只写插件私有的已校验运行包，不修改地图 Lua、UI 导出、场景文件、ID 台账或人工规格，也不会调用脚本打包、地图保存或发布。

每次自动运行把完整、原子提交的私有证据写入 `.yuanmeng-inspector/gameplay/runs/<runId>/`，`latest.json` 只在全部产物写入、回读和摘要验证成功后切换。取消、崩溃、跨工程、知识指纹过期、产物缺失或损坏都不能制造新的 current/pass。历史运行不会被“清理私有场景缓存”自动删除；该目录被 Git 忽略，隐私审计和 VSIX 检查会阻止它进入源码或安装包。

报告把全量严格静态门与模型模拟门并列显示，并统一给出四类结果：`model-pass` 表示已建模流程完成并通过；`model-fail` 表示模拟已运行且发现失败；`partial-needs-editor` 表示可建模部分已运行，但仍有跳过流程、截断、场景绑定/对象族证据缺口或编辑器必验项；`not-run-fatal` 表示生产入口、可达 Lua 语法、工程身份或模型边界等致命问题阻止了模拟。严格审查错误不会因为模型能运行而被隐藏；自动模式不会因单个场景证据缺口把全部模型流程判为未运行，手工严格模式仍保持原门禁。

高级兼容入口仍保留：先运行“生成待确认玩法草案”，人工确认后再运行“运行已确认人工规格（高级）”；CLI 使用 `gameplay-test <spec.json> <scenarios目录> --out <报告目录>`，MCP 必须同时显式提供 `modelPath`、`scenarioDirectory` 和 `out`。人工模型继续严格绑定当前 Lua、注册表、UI 和场景知识指纹；任一证据变化都会按 stale 阻断，且人工输出不会覆盖自动模式的 `latest.json`。

多人矩阵区分服务端共享、服务端每玩家和客户端本机状态，检查重复投递、交错、广播/单播、共享竞争和重连等可建模行为。需要真实流程证据时可使用详细玩法日志探针；探针修改仍必须预览确认并可撤销，导入时只保存结构化字段，不保存原始日志行。

AI 完成任务时可使用 MCP 提示词 `yuanmeng_task_completion_check` 做条件化玩法自检。大型、复杂、多人或涉及服务端/客户端、共享状态、计时器、存档经济、NPC、任务链和跨场景的改动，以及同一功能连续失败或返工 2 次以上，会直接调用默认自动模式；小型 UI、文案、固定 ID 和纯布局且未重复失败时，才可记录跳过并说明原因。该链路不调用 `yuanmeng_build_and_send_code`。

本地严格审查、模型模拟、Extension Host、官方编辑器单人运行和真实多人实测是五种独立证据。`model-pass` 只证明静态可提取模型中的有界流程，不等于官方编辑器运行；物理、NPC 可达、镜头和真实网络顺序仍必须标为需要官方编辑器或多人验证。

## Codex/CLI 入口

扩展初始化每个工程的被忽略目录 `.yuanmeng-inspector/bin/`，原子生成 CLI 的 `ymai.cmd`/`cli-launcher.json` 和 MCP 的 `ymai-mcp.cmd`/`mcp-launcher.json`。向导可以复制当前工程 CLI 命令：

```powershell
& ".\.yuanmeng-inspector\bin\ymai.cmd" status --json
```

Codex 先读取 `cli-launcher.json`，再调用该工程的 `ymai.cmd`；启动器绑定工程实例、工程根指纹、扩展安装根、CLI 哈希和版本。路径含空格或中文也受测试覆盖。扩展升级或安装路径变化会刷新当前工程的 CLI/MCP 启动器；不会卸载扩展、修改全局配置或自动重载 VS Code。`status --json` 的 `environment` 字段会同时报告 CLI/MCP 启动器、代码交付桥、官方 UI 刷新命令和官方打包命令是否健康，供 AI 在任务开始前自行诊断。系统 `PATH` 不会被改动，`package.json` 的 `bin.ymai` 仅用于打包元数据，不是 PATH 安装承诺。

独立 CLI/MCP 要求系统 Node.js >=20。VS Code Extension Host 使用 VS Code 自带 Node；0.5 的稳定 MCP Provider API 要求 VS Code >=1.134。

除原有 `status`、`refresh-ui`、`find-ui`、`diff-ui`、`list-ids`、`audit`、`export`、`api-search`、`where-used` 外，完整版本还提供：

- `audit [--file src/相对路径.lua ...] [--errors-only]`：默认仍审计全部 `src`；小型已确认 API 修复可只分析指定生产文件并精简非错误明细。返回的 `scope` 会明确区分 `full` 与 `targeted`，定向结果不能冒充全项目、打包、编辑器或多人通过
- `set-map-name <地图名称>`：为当前工程保存或修改本机地图显示名；只影响显示和 AI 识别
- `scene-status`
- `bind-scene <manual-dat|auto-dat|raw-pbin> <文件>`
- `refresh-scene [来源角色]`
- `find-scene <实例ID|type:类型ID|owner:OwnerID|signal:信号名>`
- `scene-tree <ID>`、`group-members <编组ID>`、`field-inspect <实例ID>`
- `scene-diff [--from 快照 --to 快照]`
- `scene-plan <承载面ID> <移动实例ID...>`
- `scene-types`：按官方类型 ID 聚合数量、代表实例、已校准名称/对象族、能力证据和待校准类型；未知类型保持 unknown，不需要用户逐个口述
- `ui-screen-snapshot <名称|ID|路径>`：读取单控件在一次真实客户端分辨率下的屏幕矩形；无证据时返回绑定当前 UI 快照的只读探针
- `ui-tree-screen-snapshot <名称|ID|路径>`（`GetTreeScreenSnapshot`）：严格按 `parentId` 递归读取根弹窗及全部子控件、孙控件和更深后代的屏幕矩形，最多 500 个控件；不按路径前缀猜层级
- `resolve-ui <名称|ID|完整路径>`：只做确定性解析；唯一精确名称、十进制 ID 或完整路径命中，重名时明确拒绝
- `ui-inspect-point <X> <Y>`：读取真实屏幕点的触摸命中；没有当前快照证据时返回 `UI:CheckWidgetByScreenPosition` 只读探针
- `ui-runtime-widgets <名称|ID|完整路径>`：读取运行时复制控件和列表子项 ID 台账；旧 UI 快照证据不会复用
- `api-search <关键词> [--limit <1-1000>]`：搜索官方 Lua API、本地资源和事件元数据；检测到 DreamCode `api.json` 时同时返回编程元件 API 条目。编程元件目录只证明目录/方法/参数，不证明当前地图存在完整积木连接图
- `where-used <ID|名称|信号>`：除 Lua 引用外，返回有界 `impact` 摘要，合并 UI/场景/台账候选、受影响文件和运行侧；只表示直接静态关联，重名/多对象候选不自动消歧
- `runtime-probe <ui-screen-point|ui-runtime-tree|scene-capability> ...`：只生成三类受控模板，不接受任意 Lua
- `scene-capabilities <实例ID>`：按类型、字段与运行证据说明应该使用碰撞、信号盒进入/离开或其他接口；不能确认时保持 unknown
- `ui-layout-audit <名称|ID|路径> [--include-overlaps]`：检查越界、裁切、中心遮挡和可选兄弟显著重叠
- `scene-geometry bounds <实例或编组ID>`、`scene-geometry contact <目标ID> <承载面ID> [--tolerance 数值]`、`scene-geometry overlaps <ID...>`：查询可信包围盒、贴合状态和严格体积穿插；不执行移动
- `scene-audit [--detailed]`：默认按问题聚合并仅给少量示例，需要全部明细时再加 `--detailed`
- `property-locate <属性名> <官方属性类型>`
- `gameplay-review <spec.json> --out <报告目录>`
- `gameplay-test [--preview] [--focus <说明>] [--file <src/相对路径>...]`：默认自动准备并尽可能模拟；`--preview` 只读运行，不写玩法运行包或 `latest.json`
- `gameplay-test <spec.json> <scenarios目录> --out <报告目录>`：高级人工严格模式；证据过期时 fail-closed
- `feedback add <bug|friction|improvement> <标题> --message <内容>`
- `feedback list [all|open|resolved] [all|bug|friction|improvement]`
- `feedback resolve <反馈ID> --message <处理说明>`
- `export scene --format <json|csv|md> --out <文件>`

每条命令支持人类格式和 `--json`。项目启动器由轻量 Node 校验器完成工程身份、扩展版本和 CLI 哈希检查，不再为每次查询启动 PowerShell/Get-FileHash。CLI 不会把绝对地图路径写进输出；`scene-plan` 在静态边界证据不足时返回不可执行状态和已验证算法的射线测量预览 Lua，不会猜尺寸。

AI 开始任务时应先运行 `status --json` 和 `scene-status --json`，需要识别官方类型时运行 `scene-types --json`，需要审查全图时先用默认紧凑 `scene-audit --json`。实际使用发现问题时，AI 应立即写入 `feedback add ... --json`；集中维护时运行 `feedback list open all --json`，修复并验证后再运行 `feedback resolve ... --message ... --json`。

## 本机 MCP 与三条客户端通道

本 MCP 只在本机使用 stdio，不监听 HTTP/SSE/WebSocket 端口，不上传遥测。协议能力、VS Code 自动发现和 Codex 注册是三件不同的事：

| 客户端 | 发现方式 | 是否自动 | 验证 |
|---|---|---|---|
| VS Code Agent | 已安装 VSIX 的 `McpServerDefinitionProvider` 为每个当前工程提供 `ymai-mcp.cmd` | 扩展激活后自动；无需 `.vscode/mcp.json`，不依赖 Preview 公共 Gallery | `MCP: List Servers`、Agent 工具列表和实际调用 |
| Codex Desktop/CLI | 命令面板先“预览 Codex MCP 注册”，再“注册/刷新当前工程到 Codex MCP”；内部调用 `codex mcp add <name> -- <launcher>` | 需要一次明确确认，随后重启或新建 Codex 会话 | `codex mcp list`，再在新会话实际列出并调用；当前会话不会伪装成已动态加载 |
| 其他 stdio MCP host | 把当前工程 `.yuanmeng-inspector/bin/ymai-mcp.cmd` 配为本机 command | 取决于 host | 该 host 的 server/tool 列表与真实调用 |

公共 MCP Gallery 仍可处于 Preview；本项目没有发布到公共 registry，因此不会出现在 Gallery，也不能按名字从公共商城搜索安装。VS Code Provider 的自动发现只对已安装并激活的同 ID 扩展 生效。Codex 不会被 VS Code Provider 自动注入；卸载 Codex 条目使用“从 Codex MCP 移除当前工程”，只调用 `codex mcp remove`，不解析或覆盖现有 `config.toml`。

完整清单见 [MCP 工具手册](mcp.md)：共 42 个工具、7 个资源、4 个提示词。`yuanmeng_build_and_send_code` 是唯一自动交付工具，固定执行 Save All → 确认当前工程 Lua 无脏文档 → 刷新并确认 UI 诊断 fresh/零错误 → 对当前 `src` 运行与 `yuanmeng_project_audit` 相同的全量 Lua/UI/ID/API 审计 → `dreamhelper.scriptGen` → 最长 60–70 秒轮询并等待产物连续稳定。UI 新鲜度门与全量项目审计是两条独立门；包括 `*_backup.lua` 在内的工程 Lua 若语法无效，会以 `CHECK_FAILED` 报告具体文件并在官方命令前停止。主产物为 `dist/code_YYYY-MM-DD-HH-MM-SS.zip`，兼容观察 `play.lua/play.min.lua`；旧文件消失本身不算成功。交付桥遇到短暂 `EPERM/EBUSY` 会在限定时间内重试，并且只清理 `.yuanmeng-inspector/mcp-bridge` 中符合本插件严格命名规则的过期临时文件。官方 `dist/play.json` 仅访问并复制 `type/pack/time` 三个构建证据字段；密码字段不会进入插件结果、日志或 MCP 输出。`LINK_OFFLINE` 表示 VS Code 桥未激活，客户端会先短暂等待同一工程桥租约恢复；`COMMAND_UNAVAILABLE` 表示官方命令缺失，`CHECK_FAILED`/`SAVE_FAILED` 会在调用官方命令前停止，`EVIDENCE_INSUFFICIENT` 表示缺少绑定证据或超时仍没有稳定的新产物。命令或 fixture 返回文字最高只属于 `EXTENSION_HOST`，不能冒充真实官方编辑器证据。该工具不修改 `LayerData*.dat/pbin`，也不代表地图保存、地图发布或游戏内共享成功。

## 数据、隐私与限制

- 数据默认只写当前工程的 `.yuanmeng-inspector/`，该目录及真实官方更新文件均被 Git 忽略。
- 插件自有源码采用 MIT 许可证，允许使用、修改和再分发，须保留版权及许可声明。第三方依赖遵守各自许可证；官方软件、资源与用户地图不因此获得再分发许可。
- Lua 只接受安全字面量 AST，禁止执行用户 Lua。
- 官方 UI 类型未在本机导出中出现时显示 `unknown`，不会猜测。
- 用户明确绑定本人地图文件后，插件可自动读取已校准结构中的实例 ID、类型 ID、owner、位置/旋转/缩放、编组及成员，并把实例/类型同步为 `pending + unspecified` 台账记录；不会自动升级为 formal/confirmed。
- `.dat` 先经过单条目 ZIP、Central Directory、CRC、data descriptor、路径和解压上限校验；wire 的未知 bytes/fixed 字段保持 opaque/raw bits，不按猜测命名。
- v6 场景快照可读取已校准路径中的实例/类型/owner、两类 transform 分支、编组父子与嵌套成员、数值自定义属性、实例信号名、根级信号注册表、图层名、编辑器版本候选和实例索引一致性。字段检查器同时显示静态资产目录覆盖率；目录未收录的官方资产仍是 unknown，必须靠后续校准或运行时对象族探针识别。未校准的资源、碰撞、物理、可见、抓取和真实模型边界仍保持 candidate/unknown，不从二进制位猜语义。
- 运行时只读探针会分别检查 Element、LogicElement、TriggerBox，并逐项读取位置、旋转、缩放、尺寸、网格中心、可见、物理、碰撞、抓取、attach parent 和 child count；每项独立记录 present/absent/error/ok，且证据必须绑定当前工程、binding、快照和场景源哈希。
- 场景监听只覆盖编辑器已经保存/更新到磁盘的变化，不能读取尚未落盘的鼠标选择或内存状态；MCP 同样只读取已保存数据。
- UI 自动刷新也只响应已经落盘的官方导出文件；多根工作区按工程分别监听、串行刷新。剪贴板只在用户显式运行导入命令时读取，并把记录绑定到当次选择的 `projectInstanceId`/`mapFingerprint`。
- UI 屏幕坐标不能从静态 `CustomUIData*.lua` 凭空推算；首次查询会返回客户端只读探针。探针运行并导入同一次试玩日志后，MCP 才返回该设备分辨率下的屏幕矩形。隐藏控件或官方 API 调用失败会保留为失败证据，不临时改显隐。
- 场景几何只接受已观察且经过确认/可重复验证的 AABB。编组递归合并成员边界；贴合只比较有水平覆盖的目标底面与承载面顶面；穿插使用严格体积相交，刚好接触不算穿插。
- 插件从不写回 `LayerData*`，不注入/Hook 编辑器、不扫描进程内存、不拦截私有通信、不绕过鉴权/审核/反作弊。所有空间调整只生成报告或可审查的官方 Lua API 代码。
- 元件属性读取是交互式流程：官方面板需要你填写元件 ID 并点击“确认”，因此使用独立的 `propertyReadTimeoutSeconds`（默认 120 秒），不与 UI 结构刷新计时共用；官方返回空属性表 `return {}` 仍记录为成功读取。
- `mapFingerprint` 为空时，属性工作流仅允许同一 `projectInstanceId` 下用户登记为 test/unspecified 且 validity 为 pending/confirmed 的单个目标，并显示“地图身份未由官方确认”；不得升级为 formal 或跨工程使用。
- 自动写代码、替换 ID、编辑属性和推送属性都先显示差异并需要确认；不直接修改 `dist/play.lua` 等官方生成物。
- 属性推送与脚本合成命令仍标为“实验性（真实编辑器未验收）”；具体形状、旋转和障碍物需逐地图验证。
- 构建命令只观察官方脚本合成产物，不代表代码语义、游戏运行或地图发布成功。
- VSCode 公共 API 不提供读取其他扩展 Output Channel 的稳定接口。为修正连接指示，插件默认只在当前扩展主机日志目录下读取有界的 `*dreamhelper.log` 文件尾部，并仅解析“连接成功/断开”标记与脱敏工程名，不保存日志原文、IP、端口、密码或绝对路径；`yuanmengAi.enableInternalLogAdapter` 可关闭该兼容适配器。完整日志仍只能通过用户显式选择文件导入，并区分本机日志、编辑器画面和多人实测证据。

## 故障排查

- “官方命令不存在”：启用官方扩展和联动，确认当前窗口打开的是含 `src/GameEntry.lua` 的工程。
- “离线/数据陈旧”：重新打开官方联动并刷新；检查 `status --json` 的 `reasonCodes`、来源时间和哈希。
- “环境 degraded/blocked”：检查 `status --json` 的 `environment.issues`；扩展只会刷新当前工程启动器，不会自动卸载扩展、修改全局配置或重载 VS Code。
- “启动器校验失败”：不要手改 `ymai.cmd` 或 `cli-launcher.json`，在向导中重新初始化当前工程 CLI。
- “地图身份未由官方确认”：仅使用用户明确登记的 test/unspecified 单个目标；要使用 formal 目标，先让官方数据提供非空地图指纹。
- “RSS 性能门槛未验证”：既有 Windows 大数据测试曾超过 512 MiB；这不是通过，也不等同 VSIX 或编辑器验收。场景树采用懒加载，但超大真实地图仍需单独测量。

## 证据与验收边界

静态检查、单元测试、CLI 集成、Extension Host、VSIX Clean Profile、官方编辑器单人联动和多人实测分别记录。验收步骤见 [编辑器验收清单](editor-acceptance-checklist.md)，构建与发布流程见 [构建与发布说明](public-release.md)。自动化通过不能替代官方编辑器画面或多人验收。

## 开发验证

```powershell
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:extension
node scripts/privacy-audit.mjs --json
npm run package:vsix
```

`verify-data-contracts.mjs` 只检查 package/CLI launcher 数据契约；`privacy-audit.mjs` 才执行密钥、绝对地图路径、原始导出、日志和官方二进制扫描。

`package.json` 中的 `private: true` 仅防止误发 npm 包，不限制 MIT 授权、GitHub 公开源码或 Marketplace 发布。源码导出与安装包都由 `npm run package:release` 生成到新的 `outputs/public/<时间戳>/` 目录；该流程不调用 Git，也不自动上传。
