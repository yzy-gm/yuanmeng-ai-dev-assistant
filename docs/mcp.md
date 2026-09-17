# 本机 MCP 手册

版本 `0.6.1`，服务只使用本机 stdio。它不发布到公共 MCP Gallery/GitHub registry，不要求 `.vscode/mcp.json`，也不开放网络端口。

## 工具（42）

- 工程/上下文/UI：`yuanmeng_project_status`、`yuanmeng_task_context`、`yuanmeng_set_map_display_name`、`yuanmeng_ui_refresh`、`yuanmeng_ui_find`、`yuanmeng_ui_resolve`、`yuanmeng_ui_inspect_screen_point`、`yuanmeng_ui_runtime_widgets`、`yuanmeng_ui_screen_snapshot`、`yuanmeng_ui_tree_screen_snapshot`、`yuanmeng_ui_layout_audit`、`yuanmeng_ui_diff`。
- ID/Lua/知识：`yuanmeng_ids_list`、`yuanmeng_where_used`、`yuanmeng_api_search`、`yuanmeng_project_audit`、`yuanmeng_official_audit`。
- 场景/探针：`yuanmeng_scene_status`、`yuanmeng_scene_bind`、`yuanmeng_scene_refresh`、`yuanmeng_scene_find`、`yuanmeng_scene_tree`、`yuanmeng_scene_fields`、`yuanmeng_group_members`、`yuanmeng_scene_diff`、`yuanmeng_scene_near`、`yuanmeng_scene_audit`、`yuanmeng_scene_types`、`yuanmeng_scene_capability_describe`、`yuanmeng_runtime_probe`、`yuanmeng_scene_geometry`、`yuanmeng_scene_plan`、`yuanmeng_scene_journal`、`yuanmeng_property_locate`。
- 玩法/反馈：`yuanmeng_gameplay_review`、`yuanmeng_gameplay_test`、`yuanmeng_gameplay_status`、`yuanmeng_task_completion_check`、`yuanmeng_feedback_add`、`yuanmeng_feedback_list`、`yuanmeng_feedback_resolve`。
- 自动交付：`yuanmeng_build_and_send_code`。顺序固定为 Save All、确认 Lua 已保存、刷新并确认 UI 诊断 fresh/零错误、运行与 `yuanmeng_project_audit` 相同的当前工程全量 Lua/UI/ID/API 审计、官方 `dreamhelper.scriptGen`、最长 60–70 秒轮询并等待稳定产物。两条静态门互不替代；`INVALID_LUA_SYNTAX`、`LUA_LIMIT_EXCEEDED` 或审计错误必须返回 `CHECK_FAILED`，保留具体阻断文件，并且不得调用官方命令。插件不会擅自排除 `*_backup.lua`。主产物为 `dist/code_YYYY-MM-DD-HH-MM-SS.zip`，兼容 `play.lua/play.min.lua`；旧文件删除不算成功，分段写入必须连续稳定采样。桥接 JSON 原子替换遇到短暂 `EPERM/EBUSY` 会有界重试，只清理本插件桥目录内、符合严格命名且已过期的临时文件。`play.json` 只访问并返回白名单 `type/pack/time` 与产物关联结果；密码字段不会被复制到返回对象、日志或输出。命令/fixture 返回本身最高只属于 `EXTENSION_HOST`，没有稳定新产物则返回 `EVIDENCE_INSUFFICIENT`。不得解释为地图保存、发布或游戏内共享成功。

### 紧凑任务上下文与工具档

开始一个新任务时优先调用 `yuanmeng_task_context`，可选提供 `focus` 和 `changedFiles`。它一次返回当前工程身份、UI/场景/Lua/代码交付就绪度、场景缓存体积告警、玩法 latest 摘要、官方扩展/游戏版本/UGC 只读索引和有界下一步建议；不会刷新、审计、模拟、打包或写地图。它只返回短哈希前缀、相对路径和计数，不返回完整 SHA、原始日志或绝对路径。

MCP 默认使用 `workflow` 工具档：保留日常 UI、场景、Lua、审计、玩法模拟和代码交付能力，隐藏低频运行时探针、几何规划和高级诊断工具。可在 VS Code 设置 `yuanmengAi.mcpToolProfile` 改为 `full`、`scene` 或 `gameplay`；切换后插件会刷新当前工程的本地启动器，已注册的 Codex MCP 需要重新打开会话。各档只是工具/资源/提示词可见性，不改变 CLI/MCP 的工程身份和写入安全门。

可选设置 `yuanmengAi.gameInstallPath` 与 `yuanmengAi.ugcDataPath` 后，紧凑上下文会只读游戏版本文本、`LetsGo/GameData/Saved/PersistentDownloadDir` 下的静态配置文件名、`UGCPDeviceInfo.json` 使用键、`UGCScriptProjectInfo.ini` 记录数和脚本包文件名。UGC 路径通常可指向 `<游戏安装目录>/LetsGo/GameData/Saved`。`.pbin/.ldata/.zip` 内容不被解密或执行；无法确认的内容保持“未解码”。

`scene-status` 和紧凑上下文的缓存摘要只统计 `.yuanmeng-inspector` 派生目录，不包含 `LayerData*.dat/pbin`、registry/runtime 或已提交玩法运行包；超过阈值只告警，不自动删除。`cleanSceneCache` 仍需用户在 VS Code 中逐次确认，当前工作流不会替用户清理任何地图工程文件。

`yuanmeng_project_audit` 默认仍为全量工程审计。对已经唯一确认官方签名的小型局部修复，可传 `files: ["src/Client/Example.lua"]` 和 `errorsOnly: true`：工具只读取所列 Lua 文件，保留该范围的完整错误/警告计数，但只返回错误明细；响应固定带 `scope.mode=targeted`、`fullProjectEvidence=false` 和省略条数。这个模式只节省 AI 查询时间和上下文，不会改变 `yuanmeng_build_and_send_code` 的全量门禁，也不会排除 `src` 中的备份 Lua。

### 玩法自动准备与模拟

`yuanmeng_gameplay_test` 默认不需要参数。它从 `GameEntry.lua` 的生产可达 Lua 闭包与当前台账/UI/场景/事件证据自动准备模型，按事件与运行端去重并优先根事件，为最多 5 个入口分别生成单人、重复、重连与 2/4/8 人竞争场景，另保留最多 2 个事件链诊断，总数不超过 32；超出入口预算的流程明确标记 GAMEPLAY_ENTRANCE_SCENARIO_BUDGET，并在有界模拟器中尽可能执行。`focus` 和 `changedFiles` 只帮助任务聚焦，不会缩小严格静态审查或把未知事实伪装成通过。自动输入可传 `preview: true`（CLI 对应 `gameplay-test --preview`）：仍执行完整自动建模和模型模拟，但不创建运行包、不更新 `latest.json`，适合先验证玩法模拟是否可用。普通自动运行只写插件私有、已校验的运行包，不修改地图代码或私有人工输入，也不调用打包、保存或发布。

只有同时显式提供 `modelPath`、`scenarioDirectory`、`out` 时才进入高级人工严格模式。人工规格或场景与当前工程知识指纹不一致时返回 stale/blocked，不自动刷新其玩法语义；人工输出也不会改写自动模式的 latest 指针。

响应并列保留 `strictStaticGate` 与 `simulationGate`，并使用四类 `classification`：`model-pass` 为可建模流程通过；`model-fail` 为模拟已运行且发现失败；`partial-needs-editor` 为可建模部分已运行但仍有跳过、截断、场景绑定/对象族证据缺口或编辑器必验项；`not-run-fatal` 为致命生产入口、可达语法、工程身份或模型边界问题导致未运行。无关信号盒、不可达坏备份或局部 unknown 仍出现在严格报告中，但不单独阻止其他可确认流程模拟。手工三路径模式仍对场景证据缺口严格 fail-closed。

完整自动运行包原子写入当前工程 `.yuanmeng-inspector/gameplay/runs/<runId>/`；`latest.json` 仅在全部产物摘要复核完成后更新。`yuanmeng_gameplay_status` 和 `yuanmeng://project/current/gameplay/latest` 只返回已验证的有界 manifest 摘要，不暴露绝对路径或完整 trace。

运行历史不会被场景缓存清理，且隐私/VSIX 审计会阻止工程私有派生目录进入源码或安装包。

`yuanmeng_ids_list`、`yuanmeng_scene_find`、`yuanmeng_scene_types` 与 `yuanmeng_feedback_list` 支持 `limit` 和签名 `cursor`；`yuanmeng_api_search` 也支持有界 `limit`（默认 200）。游标绑定当前工程、当前快照或数据哈希、工具名与查询条件；篡改游标返回 `VALIDATION_FAILED`，数据变化返回 `STALE`，不会把旧页混入新地图。单次结构化输出有 64 KiB 上限；未提供分页能力的异常大结果会被明确标记为已压缩。UI、场景、台账和反馈资源默认只读取轻量首页，AI 需要更多时按 `page.nextCursor` 继续。

`yuanmeng_api_search` 还会在本机检测到 DreamCode `api.json` 和工具箱脚本时返回 `blockApiCatalogState`、`blockApiExtensionVersion`、`blockResults` 以及 `blockToolboxResults`，用于查询编程元件的分类、服务、方法、参数、事件和值/绑定符号。该目录不等于当前地图的完整积木连接图；积木实际使用仍需当前工程的 UGC 使用痕迹、生成脚本或编辑器运行证据。

`yuanmeng_official_audit` 只读检查官方 Dream Helper/DreamCode 的 API、工具箱脚本、模板 ZIP 和 UGC 脚本 ZIP 使用痕迹，并在工程私有目录中比较 API 基线。默认不会写入；只有显式传入 `saveBaseline=true` 才写入 `.yuanmeng-inspector/official/api-index-baseline.json`，不修改地图工程文件。

该工具因支持保存基线，MCP 的 `readOnlyHint=false`；严格只读任务仅可执行不保存的查询。API `diff.categories` 分别提供 declarations/constants/enums 的增删改，`totals` 为裁切前计数，`truncated` 标记超过每列表 500 项的结果；空基线不能被解释为无变化。

模板 `comparison=bytes`：`matched` 只在所有标准文件字节相同后返回；`different` 表示内容变化，`partial/missing` 表示文件缺失，`invalid` 表示读取、大小、格式或校验和验证失败。每个文件包含状态与双方哈希，不输出原文，不写回工程。业务源码与初始模板不同通常是正常情况。

脚本扫描仅在明确配置的目录内进行，最多 4 层、65 个目录、2,000 个目录项、32 个包；单包最多 64 MiB，串行读取，不跟随符号链接。返回 `scope/scannedDirectoryCount/discoveredArchiveCount/archiveCount/complete/truncated/skippedCount/skipped`；跳过明细最多 128 项。单个坏包不会抹去其他包的结果。包内文件名示例最多 128 项，以 `scriptLikeEntryCount/entriesTruncated` 说明裁切。

从 .7 起，官方扩展、事件/资源文档、游戏与 UGC 路径统一传给 Provider 和两个项目启动器。已配置路径按当前项目根解析并优先于继承环境，空设置保留环境变量兜底；不复制其他地图的配置。VS Code 激活或相关配置变化会更新启动器；已运行的 Codex/MCP 进程仍需重启才会取得新值。直接运行 bundle 不经过项目启动器时继续使用显式环境变量。

`yuanmeng_where_used` 同时返回 `impact`：UI/场景/台账候选、直接 Lua 引用、受影响文件与运行侧。它不会把多个候选静默合并为同一对象，也不会声称已经读取完整调用图；`scope=direct-references-only` 明确限定证据范围。

### UI 屏幕坐标闭环

`yuanmeng_ui_resolve` 只接受三种确定性身份：十进制控件 ID、完整路径、唯一精确名称。名称重名会返回 `AMBIGUOUS`，不会退化为模糊匹配。`yuanmeng_ui_inspect_screen_point` 用 `UI:CheckWidgetByScreenPosition` 获取真实触摸命中；`yuanmeng_ui_runtime_widgets` 读取运行时复制控件与列表子项台账。三者均绑定当前 `projectInstanceId` 与 UI `snapshotId`，UI 保存更新后旧证据失效。

`yuanmeng_runtime_probe` 不是任意代码执行器，只能生成 `ui-screen-point`、`ui-runtime-tree`、`scene-capability` 三类白名单只读模板。动态控件模板要求业务代码在获得 `DuplicateWidget` 返回 ID 或 `GetListViewItemUID` 返回 ID 后调用探针提供的记录函数；它不会 Hook 官方插件，也不会把未知控件猜成动态子项。

AI 先调用 `yuanmeng_ui_screen_snapshot`、`yuanmeng_ui_tree_screen_snapshot` 或 `yuanmeng_ui_layout_audit`。若返回 `EVIDENCE_INSUFFICIENT`，响应会给出只读 `probeLua`，并绑定当前 `projectInstanceId`、UI `snapshotId` 和精确控件 ID 集合。把探针放入当前地图客户端测试代码、试玩一次，再用命令“导入本机日志”选择该次日志。插件只保存结构化几何，不保留原始日志行。重新调用工具后才会返回 `STANDALONE_LOG` 证据。任何旧地图、旧 UI 快照或错误选择集的日志都会被拒绝。

`GetTreeScreenSnapshot` 的正式 MCP 名称是 `yuanmeng_ui_tree_screen_snapshot`。它以唯一匹配的弹窗根控件为起点，严格按 `parentId` 递归收集直接子控件、孙控件和全部更深后代；`path` 只用于查找、显示和稳定排序。路径相似但无父子关系的控件不会被纳入，循环层级、重复实例 ID 或超过 500 个节点会返回 `VALIDATION_FAILED`，不会静默截断或输出半棵树。

屏幕结果属于一次设备分辨率，不外推到所有设备。布局审计报告越界、裁切、中心遮挡；`includePotentialSiblingOverlap=true` 额外报告同父级显著重叠，但只作为人工复核提示。

### 场景几何

`yuanmeng_scene_capability_describe` 根据当前场景快照的类型、字段和已导入运行时证据说明对象可能支持的事件/API。运行时探针使用官方 `MiscService.EQueryableObjectType` 的 Character、Creature、Element、LogicElement、Player、TriggerBox 六类逐项查询；信号盒必须走角色进入/离开信号盒事件，普通 Element 才考虑碰撞，生物和逻辑元件会列出对应官方事件。旧三类探针证据中的新增三类保持 unknown，必须重新采集，不能当成 absent。

同一未知类型 ID 的多个实例若在当前工程、当前快照、当前场景源哈希下都得到完全一致且唯一的对象族，`yuanmeng_scene_types` 会标记为 `runtime-calibrated`，以后同类型可直接复用该对象族能力；官方显示名称仍不猜。任一冲突、探针错误、重复实例或跨快照证据都会阻断自动学习。

`yuanmeng_scene_audit` 把 transform、自定义属性、信号、资源和 bounds 的 observed/candidate/unsupported/absent 数量放入 `coverage`，普通证据缺口不再按实例重复制造告警。重复 ID、场景结构 issue、未知 variant 和台账疑似变化仍在 `findings` 中保留。

`yuanmeng_scene_geometry` 有三种操作：`bounds` 合并实例或递归编组的可信成员 AABB；`contact` 计算目标底面与承载面顶面的 `aligned/floating/penetrating/no-horizontal-overlap`；`overlaps` 检查不同目标成员间严格体积相交。刚好边界接触不算穿插。缺失、候选或未校准 bounds 固定返回 `EVIDENCE_INSUFFICIENT`，不会用零坐标、位置点或类型尺寸代替。

## 资源（7）

`yuanmeng://project/current/status`、`yuanmeng://project/current/ui`、`yuanmeng://project/current/scene/status`、`yuanmeng://project/current/scene/context`、`yuanmeng://project/current/registry`、`yuanmeng://project/current/gameplay/latest`、`yuanmeng://project/current/feedback/open`。

## 提示词（4）

`yuanmeng_analyze_current_map`、`yuanmeng_inspect_scene_object`、`yuanmeng_review_multiplayer_gameplay`、`yuanmeng_task_completion_check`。提示词只编排工具，不预设 PASS，不提升证据等级。

`yuanmeng_task_completion_check` 用于 AI 交付任务前的条件化自检。小型 UI、文案、固定 ID 和纯布局可在说明原因后跳过玩法模拟；大型、复杂、多人，或涉及客户端/服务端联动、共享状态、计时器、存档经济、NPC、任务链与跨场景的修改，会先运行全量静态审查，再直接调用默认自动 `yuanmeng_gameplay_test`。同一功能连续出错或返工 2 次及以上也会强制升级为该路线：先根据日志和失败证据修正，再重跑静态审查和流程模拟，不继续盲改。自动准备的局部未知会形成 `partial-needs-editor`，致命边界才形成 `not-run-fatal`，不得生成假 PASS。该自检不调用打包工具，不代替用户保存、打包或发布。

同一 MCP 会话里，同一工具、错误码和稳定原因连续失败 2 次时，服务会自动向当前工程反馈箱写入一条脱敏问题。它只保存工具名、错误码、稳定原因分类和次数，不保存原始参数、路径、日志、地图内容或密钥；同类问题每个会话只记一次，写反馈失败也不改变原工具结果。

维护插件源码前后可在插件源码根目录运行 `npm run baseline:private`。它只在 `outputs/private/rollback/<UTC时间>/` 生成 `source.tar.gz`、SHA-256 `manifest.json` 与文件清单，排除依赖、构建产物、缓存、工程私有索引、地图源文件、日志、VSIX 和 `.env`。该命令不提交 Git、不上传网络，也不修改地图工程。

## AI 使用与恢复

先调用 `yuanmeng_task_context` 获取短上下文；需要确认身份时再调用 `yuanmeng_project_status`，按任务检查 `readiness.ui/scene/lua/api/codeDelivery/gameplay` 与顶层 `freshness`。其 `environment` 会诊断当前工程的 CLI/MCP 启动器、工程身份、交付桥租约及官方 UI 刷新/代码打包命令；AI 只处理与当前任务相关的阻断项，例如 UI 陈旧不会阻断纯场景或 Lua 只读查询，且不能把旧地图或旧启动器当成当前工程。扩展激活和工作区变化时只自动刷新当前工程启动器，不卸载扩展、不修改全局配置、不重载 VS Code。自动交付出现 `LINK_OFFLINE` 时会先短暂等待同工程桥恢复，仍失败再检查当前工程是否在已安装本 VSIX 的 VS Code 中打开；`COMMAND_UNAVAILABLE` 时启用官方元梦开发助手和联动；`SAVE_FAILED`/`CHECK_FAILED` 时修复后重试。所有工具固定绑定启动时工程，多根工作区由 Provider 生成多个独立 server，不能跨工程复用 cursor、binding 或 launcher。

VS Code 用 `MCP: List Servers` 验证；Codex 需独立预览和注册，并在新会话用 `codex mcp list` 与真实工具调用验证；其他 host 直接使用项目本地 `ymai-mcp.cmd`。三条结果不得互相替代。
