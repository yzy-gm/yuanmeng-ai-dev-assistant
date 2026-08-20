# 官方编辑器验收（2026-08-20）

## 已完成：UI Schema 校准

- 用户明确指定的独立无隐私测试 UI 已通过编辑器侧“更新 VSCode 工程”和官方“获取自定义界面结构”写入测试工程。
- UI 测试操作说明：要验证不同控件名，应修改控件右侧属性顶部带铅笔的对象名称，并在编辑器层级树确认名称已改变、保存后执行“更新 VSCode 工程”；“显示的文字”是视觉文本值，可能不改变结构文件。官方“编程元件”窗口的“下载工程 / 开启调试 / 导入脚本”是另一条工程连接链路，不是 UI 结构同步入口。
- 真实观察只记录字段名、嵌套规则、类型、双投影关系、官方扩展版本和匿名结构哈希；原始官方更新文件、真实 ID、名称和截图留在被忽略的 `work/editor-calibration`，没有进入仓库。
- `CustomUIData.lua` 是名称键投影，`CustomUIData2.lua` 是连续 `_1.._n` 索引投影；节点含 `_uid:number`，索引投影含 `_name:string`；本次未观察到类型字段，因此产品输出 `unknown`。
- 证据等级：`OFFICIAL_EDITOR_SINGLE` 仅覆盖这次真实文件更新观察，不覆盖下列未执行步骤。细节见 `docs/evidence/2026-08-20-m1-correction-status.md`。

### 2026-08-20 12:49 再次只读更新观察

- 在同一独立校准工程再次执行编辑器侧“更新 VSCode 工程”和官方“获取自定义界面结构”；两份相对路径 `src/Data/CustomUIData.lua`（943 字节）和 `src/Data/CustomUIData2.lua`（1040 字节）存在，当前适配器解析 10 个节点，匿名节点形状哈希为 `48cb0b0511d98e705bc970615073de04458e71145803d6577e26ce2a43fce363`。这是 `OFFICIAL_EDITOR_SINGLE` 的文件形状观察证据，不包含真实 ID 或名称。

## 附带构建观察（不构成构建验收）

- 12:48:33 误选官方命令后，独立校准工程生成了 `dist/code_2026-08-20-12-48-33.zip` 和 `dist/play.json`。文件存在、时间与 SHA-256 已登记在 `docs/evidence/2026-08-20-m1-correction-status.md`，证据等级为 `INCIDENTAL_OFFICIAL_BUILD_OBSERVATION`。
- 该观察只证明匿名测试工程被官方命令生成过文件，不证明代码语义、正式地图产物、运行时或多人行为；后续不再执行该命令作为本轮校准步骤。

## 伴随扩展刷新结果

- 正常 VSCode 中已安装官方 `dreamhelper.dream-helper` 与 `yuanmeng-local.yuanmeng-ai-dev-assistant`，并实际调用伴随扩展的“获取自定义界面结构”。修复前没有观察到新的结构哈希时，`.yuanmeng-inspector` 没有 UI snapshot/status，项目 launcher 返回 `OFFLINE`、退出码 2；这被确认为伴随扩展的旧等待逻辑误判，不是官方更新失败。
- 这条修复前结果不代表官方命令不可用；修复后的无变化分支已有自动化与 Extension Host 模拟证据，真实官方编辑器重复更新复测仍单列为 `UNVERIFIED`。

### 改名后的真实更新

- 用户改名后，官方获取命令在 13:17:57 写入了新的两份真实文件（949/1046 字节，匿名结构哈希 `fd92ee79fdcf0a9856d4f700069a5b8708eda6e099d9bf777b76233ee34b23d1`，10 个节点，类型 `unknown`）。这是官方单人更新变化观察，不包含真实名称或 ID。
- 伴随扩展 CLI 仍为 `OFFLINE`/退出码 2，尚未生成 snapshot/status；搜索和快照差异因此保持 `UNVERIFIED`。
- 13:16:33 的 `dist` 文件再次仅作为 `INCIDENTAL_OFFICIAL_BUILD_OBSERVATION` 登记，哈希和路径见 M1 证据文档，不代表脚本、运行时或多人通过。

## 真实伴随刷新与唯一搜索（13:32）

- 用户删除一个测试控件后，在正常 VSCode 测试窗口执行伴随扩展刷新；官方文件变化被观察到，伴随扩展写入 status、current snapshot 和首个 UI snapshot。
- `ymai status --json` 返回退出码 0、`OK`、`link=online`、`freshness=fresh`；`ymai find-ui` 对改名后的临时控件返回唯一候选，证据等级为 `OFFICIAL_EDITOR_SINGLE`。
- `ymai diff-ui` 返回 `NOT_FOUND`，因为当前只有一个 snapshot；完整新增/删除/改名/移父级/ID 变化序列仍为 `UNVERIFIED`。

## 真实重复无变化更新观察与证据口径纠正（13:53）

- 将修复后的 0.1.0 VSIX 强制安装到正常 VSCode 后，只重载独立 `editor-calibration` 窗口；官方扩展与伴随扩展继续并存，未修改官方扩展，也未操作其他 VSCode 工程。
- 在没有改名、增删或移动控件的情况下执行伴随扩展“获取自定义界面结构”。官方输出记录“联动环境未开启”，公开命令返回且现有两份 UI 结构文件稳定、安全解析；旧实现不再弹超时，但曾错误显示 `online/fresh` 并生成第二个同内容 snapshot。
- 后续证据复核确认：命令返回与稳定旧文件不能证明编辑器当前在线。当前实现已纠正为显示“结构无变化，继续使用现有快照”，`link.state=unknown`、`link.reasonCode=REFRESH_SUCCEEDED_UNCHANGED`，不生成重复 snapshot；`fresh/stale` 只按原快照时间和哈希判断。该纠正已有自动化和 Extension Host 回归，尚未在真实官方编辑器中重新执行，因此当前构建的真实 no-op 状态为 `UNVERIFIED`。
- 13:53 的现场只证明公开命令返回后的本地读取链路不再超时，不证明官方 UDP 联动在线、当前构建的状态语义、属性推送、运行时或多人；完整五类非空差异序列仍未完成。

## 真实 no-op 复测（16:50 变化基线；17:12 无变化）

- 用户在本次测试前手动恢复了官方联动。16:50 的官方日志观察到联动端口开启、连接成功、工程代码发送和 Custom UI 更新；伴随扩展随后得到 `REFRESH_SUCCEEDED/online/fresh`。这次不是 no-op：最后一份持久化快照为 10 个节点，本次为 9 个节点，记录了此前删除测试控件后的真实结构变化。
- 用户保持同一测试 UI、同一联动和同一 VSCode 窗口不变，于 17:12 再次执行“元梦 AI 开发助手：获取自定义界面结构”。两份官方文件的修改时间变化但内容哈希不变；伴随扩展返回 `REFRESH_SUCCEEDED_UNCHANGED`，`link.state=unknown`，没有把命令返回或稳定旧文件升级为当前在线证据。
- no-op 没有生成新 snapshot；`ui/current.json` 的 snapshot ID、节点数、来源哈希和 `lastRefreshAt=16:50:17` 均保持不变。`ui.freshness=fresh` 仅表示原快照仍处于 30 分钟时效窗内，不表示 17:12 已完成新的编辑器同步。
- 本条证据等级为 `OFFICIAL_EDITOR_SINGLE`，仅覆盖真实变化刷新与真实 no-op 的状态语义；不覆盖属性推送、脚本语义、游戏运行时或多人。

## 尚未执行的真实编辑器步骤

以下门槛保留为 `UNVERIFIED`，不能由模拟测试替代：

- 在 UI Tree/CLI 完成重名消歧以及新增/删除/改名/移父级/ID 变化的完整非空差异序列；真实重复无变化更新已经通过。
- 一个无隐私测试元件的属性读取、编辑差异、二次确认推送和编辑器画面值确认。
- 官方脚本合成命令与 `dist/play.lua`/`play.min.lua` 产物更新观察。
- 断联/离线降级后重新连接的状态证据。
- VSCode 1.70.3 Extension Host；Clean Profile 1.134.0 生命周期已经自动化通过，但它不替代官方扩展并存与真实编辑器行为证据。
- 两人房间或多人玩法实测：`OFFICIAL_EDITOR_MULTI: 未验证`。

产品能力边界：伴随扩展调用官方公开命令并读取 VSCode 工程文件；不会在元梦画布创建、移动、导入或编辑控件，也不会抢占官方 UDP 端口。
