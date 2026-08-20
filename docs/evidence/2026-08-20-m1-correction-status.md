# M1 纠偏证据状态（2026-08-20）

## 官方 UI Schema 校准

- 状态：`calibrated`，证据等级 `OFFICIAL_EDITOR_SINGLE` 仅覆盖本节列出的导出行为。
- 用户明确指定当前测试 UI 和独立 `work/editor-calibration` 工程用于隐私安全校准。通过官方命令“获取自定义界面结构”完成一次真实导出；没有向官方 UDP 端口发送自制消息，也没有操作任何既有地图工程。
- 本机官方命令提供者版本：`dreamhelper.dream-helper-1.4.7`。一次导出同时原子观察到 `src/Data/CustomUIData.lua` 与 `src/Data/CustomUIData2.lua`；本次证据不支持把第二个文件描述为“仅在大数据时出现的分片”。
- `CustomUIData.lua` 是名称键投影：节点名称是字符串表键，节点含 `_uid: number`，子节点继续嵌套为名称键表。
- `CustomUIData2.lua` 是顺序索引投影：同级节点按连续 `_1`…`_n` 存放，每个节点含 `_uid: number`、`_name: string`，子节点继续使用连续索引。两个投影在本次导出的节点 ID、名称和父子关系上一致。
- 两个文件都未观察到控件类型字段。产品把类型输出为明确的 `unknown`，不根据名称、层级或 ID 猜测类型。
- 匿名结构哈希：名称键投影 `2888bbdf360b6025bc9bafe27476db22449af117daf0a9ebbc822e4b1074d36d`；索引投影 `e51357f39aff6c4fffedca53b53c8ab3418389cdea74cd09e2cc65ad2e6424ad`。计算前移除注释，并把所有字符串和数字值替换为类型占位符。
- 原始导出、真实生成 ID、控件名和截图均位于被 `.gitignore` 排除的 `work/`，没有复制进测试夹具或文档。仓库夹具是按字段和嵌套规则手工重建的匿名虚构数据。
- UI 名称证据边界：右侧属性顶部带铅笔的对象名称对应官方结构中的名称键/`_name`；“显示的文字”是视觉文本值，可能不改变结构文件。重复名称通过完整路径和 `CustomUIData2.lua` 的 `_1..._n` 索引区分。官方“编程元件”窗口的“下载工程 / 开启调试 / 导入脚本”不属于 UI 结构同步链路。
- 生产适配器只以 `CustomUIData2.lua` 作为无损规范来源；名称键投影仅保留来源、时间和哈希证据。缺失索引投影、非连续索引、未知字段或重复 ID 均安全失败为 `UNSUPPORTED_UI_SCHEMA`/`DUPLICATE_UI_ID`，不会静默选错。

## 2026-08-20 12:49 只读复核与附带构建观察

- 通过官方“获取自定义界面结构”再次刷新独立校准工程；`work/editor-calibration/src/Data/CustomUIData.lua` 为 943 字节，`CustomUIData2.lua` 为 1040 字节。两份原始文件仍只存在于被忽略的校准工程，没有进入产品仓库。
- 本次匿名结构观察得到 10 个节点，类型集合仍只有 `unknown`；匿名节点形状哈希为 `48cb0b0511d98e705bc970615073de04458e71145803d6577e26ce2a43fce363`。该哈希不包含真实控件名或 ID。
- 12:48:33 曾因误选官方命令而在同一独立校准工程产生附带构建观察：`work/editor-calibration/dist/code_2026-08-20-12-48-33.zip`（227 字节，SHA-256 `D02A4EE3E4440B9C8BD970046EF6B2853716AF1EF9B312BD1B121CFDBB43F92D`）和 `work/editor-calibration/dist/play.json`（226 字节，SHA-256 `6A7470E691B432B6B6972C472B329239BD4863FBD05961ED82555872C6CA3C16`）。该证据等级固定为 `INCIDENTAL_OFFICIAL_BUILD_OBSERVATION`：只证明匿名测试工程被官方命令生成过文件，不证明脚本语义、正式地图产物、游戏运行时或多人行为；本轮后续不再执行脚本生成命令。
- 上述构建文件、校准工程的 `src/GameEntry.lua`、原始导出和日志均未被 Git 跟踪，也未进入 VSIX；隐私审计和 VSIX 清单检查均为零发现。
- 伴随扩展在正常 VSCode 中与官方扩展并存后，实际调用了“获取自定义界面结构”；最初因文件没有新哈希而误报 `OFFLINE`。当前实现对稳定旧文件返回 `REFRESH_SUCCEEDED_UNCHANGED` 且不报失败，但 `link` 保持 `unknown`，继续使用原快照并按原时间/哈希计算新鲜度；无文件、半写入或解析失败仍失败。命令返回不能单独证明编辑器在线。
- 用户随后在专用测试 UI 中完成改名并触发官方获取命令；13:17:57 两份真实导出内容发生变化：`CustomUIData.lua` 949 字节、SHA-256 `B851335A074672E5AF5C3C8C3506F0A84DC8A50474AF99D1A7C1592A034489D6`，`CustomUIData2.lua` 1046 字节、SHA-256 `ABD894208E9C841F7E315079226C773EBDE003A2C514162E3035B36B825DA85F`。适配器仍解析 10 个节点，类型集合仍为 `unknown`；匿名形状哈希（含字符串长度类别）为 `fd92ee79fdcf0a9856d4f700069a5b8708eda6e099d9bf777b76233ee34b23d1`。
- 这次变化之后 CLI 仍返回 `OFFLINE`/退出码 2，且 `.yuanmeng-inspector` 仍没有 UI snapshot/status；因此“官方文件变化”与“伴随扩展刷新成功”继续分开记录，后者保持 `UNVERIFIED`。
- 13:16:33 另观察到匿名校准工程产生 `work/editor-calibration/dist/code_2026-08-20-13-16-33.zip`（227 字节，SHA-256 `4BDD7D965BCF4CA4778628F3F6662F2B42225D973F8F0F26B0E20C63DF4AA45A`）和 `work/editor-calibration/dist/play.json`（226 字节，SHA-256 `7F628F0422BD614E7D1766751D431164A8B76CADE130C35ECCBED099AFE8C619`）。该条仍是 `INCIDENTAL_OFFICIAL_BUILD_OBSERVATION`，不证明脚本语义、运行时或多人。

## 2026-08-20 13:32 真实伴随刷新与唯一搜索

- 用户删除一个测试控件后，官方 UI 结构文件内容发生变化；伴随扩展刷新成功写入 `.yuanmeng-inspector/status.json`、`ui/current.json` 和首个 UI snapshot。这是变化链路证据，不表示用户每次都需要删除控件。
- `ymai status --json`：退出码 0，`code=OK`，`link.state=online`、`link.reasonCode=REFRESH_SUCCEEDED`、`ui.freshness=fresh`，两份来源哈希与本次导出一致。
- `ymai find-ui` 对用户改名后的临时控件返回唯一结果（深度 1、存在父级、类型 `unknown`、来源 `src/Data/CustomUIData2.lua`），退出码 0。真实 ID、完整路径和原始数据未写入仓库。
- `ymai diff-ui --json` 如实返回 `NOT_FOUND`：“没有足够的 UI 快照可供比较”；当前只有一个 snapshot，因此新增/删除/改名/移父级/ID 变化的完整差异验收仍未完成。

## 自动化与 Extension Host

- 单元、集成和 CLI 测试是本机自动化证据。
- 2026-08-20 无变化更新回归修复：`waitForStableExport` 仅在 UI 刷新调用中允许读取稳定的同内容文件；脚本构建观察仍只接受内容变化。`REFRESH_SUCCEEDED` 可在真实文件变化与解析成功时证明 `online`；`REFRESH_SUCCEEDED_UNCHANGED` 只表示本地结构无变化，`link=unknown`，不更新快照时间。
- 自动化覆盖已有文件且哈希/签名均不变、同内容重写导致签名变化、无文件超时、半写入/非法 Lua 拒绝、内容变化成功；Extension Host 模拟通过真实 `WorkspaceContextManager`、工程内 `ymai.cmd` 请求队列完成重复无变化更新，并断言明确文案、`unknown` 状态、原 snapshot ID 保留与按原时间过期。
- `test/extension/m1-ui.test.ts` 注册假的 `dreamhelper.GetCustomUIData`，只属于 `EXTENSION_HOST` 模拟证据；它不能证明官方编辑器联动。
- `test/extension/official-schema-gate.test.ts` 也只用匿名文件模拟已校准格式，属于 `EXTENSION_HOST`；测试断言来源证据不能升级为 `OFFICIAL_EDITOR_SINGLE`。
- VSCode 1.70.2 Extension Host 使用内置 Node 16.13.2；系统 Node >=20 只约束开发命令和独立 CLI。
- 当前稳定版 1.134.0 Extension Host 已通过模拟 UI、运行时能力和 CLI launcher 测试，内置 Node 为 24.18.1；它不能替代 1.70.3。
- 最新完整 `npm run verify` 通过：类型检查、lint、23 个单元测试文件/145 个测试、11 个集成测试文件/67 个测试、稳定版 Extension Host 与校准格式门。Extension Host 仍有已分离的宿主/账户噪声，不能写成 clean pass；100,000 节点本轮 RSS 为 515,198,976 bytes，单次低于 512 MiB，但此前同机运行曾超过门槛，内存门继续明确保持未验证。

## VSCode 1.70.2 宿主噪声隔离

可重复隔离命令：

```powershell
node scripts/run-extension-tests.mjs --version 1.70.2 --host-noise-probe --grep "host-noise probe"
```

该探针不激活本产品，只在自动创建并自动清理的匿名临时工作区写入一个 `CustomUIData.lua`。VSCode 1.70.2 仍会输出：

```text
Cannot read properties of undefined (reading 'installAndRestartMessage')
```

因此该消息属于 1.70.2 在新 `.lua` 文件出现后的宿主噪声，不是产品命令、文件观察器或启动器触发。测试启动器补齐 `WINDIR`、`PUBLIC` 后，成功运行不再出现 `path argument undefined`；成功退出也未再出现 `Cannot call write after a stream was destroyed`。1.70.2 结果必须写为“通过，带已隔离宿主噪声”，不能写为 clean pass。

## 尚未获得的证据

- VSCode 1.70.3 Extension Host：官方测试下载入口当前不可用；1.70.2 不能冒充 1.70.3。
- 13:53 的旧构建在独立校准工程完成过真实重复无变化读取：公开命令返回、两份稳定文件安全解析，不再误报超时；但它错误显示 `online/fresh` 并生成第二个同内容 snapshot。当前实现已在自动化与 Extension Host 中纠正。
- 官方编辑器属性推送：未执行。
- 多人实测：未执行。
- VSIX Clean Profile：VSCode 1.134.0 完整生命周期已通过；该证据与官方编辑器联动分离。

## 2026-08-20 16:50/17:12 真实变化刷新与 no-op 闭环

- 用户在复测前手动恢复官方联动；16:50 的官方日志观察到端口开启、连接成功、工程代码发送和 Custom UI 更新。伴随扩展于 16:50:17 记录 `REFRESH_SUCCEEDED/online/fresh`。快照从此前 10 个匿名节点变为 9 个，说明这次对应先前删除测试控件后的真实结构变化，不是 no-op，也不是安装后凭空产生的状态。
- 用户保持测试 UI、联动和工程不变，于 17:12 再次执行伴随扩展命令。两份官方文件修改时间更新但内容哈希与 16:50 基线相同；状态于 17:12:47 返回 `REFRESH_SUCCEEDED_UNCHANGED`、`link.state=unknown`。
- `ui/current.json` 继续引用 16:50:17 的 9 节点 snapshot，snapshot 文件数保持 3，未新增重复快照。`ui.lastRefreshAt` 仍为 16:50:17；17:12 的 `fresh` 只来自原快照尚未超过 30 分钟时效，不是本次同步成功证据。
- 原始文件、真实 ID、名称与路径继续只存在于被忽略的 `work/editor-calibration`。本条只记录状态、数量和相等关系，不提交原始导出或地图内容。
