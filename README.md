# 元梦 AI 开发助手（Yuanmeng AI Dev Assistant）

**作者：不见星光**。这是一个与官方“元梦开发助手”并存的本机 VS Code 伴随工具，为《元梦之星》创作者提供本地 UI、ID、Lua 与 API 检查能力。它读取官方命令生成的 `CustomUIData*.lua`，建立可供 VSCode、CLI 和本机 AI 查询的结构化索引；不会修改、替换或重新分发官方扩展。公开扩展 ID 为 `bujianxingguang.yuanmeng-ai-dev-assistant`。

本项目是不见星光开发的第三方工具，并非腾讯或《元梦之星》官方产品，与腾讯不存在隶属或授权关系。

## 安装与卸载

Marketplace 发布后，可以在 VSCode 扩展面板搜索“元梦 AI 开发助手”“元梦”或“Yuanmeng”安装。开发验收版可在本目录执行 `npm install`、`npm run build`，然后用 VSCode 的“从 VSIX 安装…”安装 `outputs/yuanmeng-ai-dev-assistant-0.1.0.vsix`。安装后无需 npm 全局安装，也不会修改系统 `PATH`。

若曾安装开发身份 `yuanmeng-local.yuanmeng-ai-dev-assistant`，请先卸载该开发版，再安装公开身份 `bujianxingguang.yuanmeng-ai-dev-assistant`；二者是不同扩展 ID，VSCode 不会把前者自动升级成后者。工程中的 `.yuanmeng-inspector/` 数据仍按工程隔离，不需要复制到产品仓库。

卸载：在 VSCode 扩展面板卸载本扩展。旧工程启动器会在目标扩展路径或 CLI 不存在、哈希不匹配时返回“元梦 AI 开发助手已卸载或安装路径失效”，不会执行未知文件。

## 快速开始

1. 打开一个独立的元梦 Lua 工程，确认存在 `src/GameEntry.lua`。
2. 保持官方扩展启用并打开官方联动。
3. 执行“元梦 AI 开发助手: 打开新手向导”：检测官方命令、激活工程、更新 VSCode 工程/获取 UI 结构、搜索控件。
4. 在元梦编辑器中命名或调整控件后，在编辑器侧选择“更新 VSCode 工程”，再从 VSCode 执行“获取自定义界面结构”。VSCode 通过官方命令读取更新后的 `CustomUIData.lua`/`CustomUIData2.lua`，不是把文件导入元梦画布。
   - 要测试不同控件名，请修改 UI 控件右侧顶部带铅笔的对象名称，并在编辑器层级树确认名称已真正改变、保存后再更新 VSCode 工程；“显示的文字”只是视觉文本值，可能不会改变 UI 结构文件。
   - “编程元件”窗口中的“下载工程 / 开启调试 / 导入脚本”属于编程元件工程连接链路；UI 结构更新走官方 `dreamhelper.GetCustomUIData` 命令，不依赖该窗口提供第四个按钮。
5. 唯一名称可直接查询；重名会列出完整路径候选，不会静默选错。

## Codex/CLI 入口

扩展初始化每个工程的被忽略目录 `.yuanmeng-inspector/bin/`，原子生成 `ymai.cmd` 和 `cli-launcher.json`。向导可以复制当前工程命令：

```powershell
& ".\.yuanmeng-inspector\bin\ymai.cmd" status --json
```

Codex 先读取 `cli-launcher.json`，再调用该工程的 `ymai.cmd`；启动器绑定工程实例、工程根指纹、扩展安装根、CLI 哈希和版本。路径含空格或中文也受测试覆盖。扩展升级或安装路径变化会刷新启动器；系统 `PATH` 不会被改动，`package.json` 的 `bin.ymai` 仅用于打包元数据，不是 PATH 安装承诺。

独立 CLI 要求系统 Node.js >=20。VSCode Extension Host 使用 VSCode 自带 Node；扩展 bundle 以 VSCode 1.70 的运行时能力为边界，不使用 Node 20-only API。

支持命令：`status`、`refresh-ui`、`find-ui`、`diff-ui`、`list-ids`、`audit`、`export`、`api-search`、`where-used`。每条命令支持人类格式和 `--json`；退出码区分成功、离线、陈旧、歧义、未找到和验证失败。官方联动不可用时只能返回离线/陈旧状态，不能冒充最新。

## 数据、隐私与限制

- 数据默认只写当前工程的 `.yuanmeng-inspector/`，该目录及真实官方更新文件均被 Git 忽略。
- 产品源码公开可见，但不等于开源授权；版权归不见星光所有，未授予复制、修改或再分发许可，详见 `LICENSE` 与 `NOTICE.md`。第三方依赖继续遵守各自许可证，详见 `THIRD_PARTY_NOTICES.md`。
- Lua 只接受安全字面量 AST，禁止执行用户 Lua。
- 官方 UI 类型未在本机导出中出现时显示 `unknown`，不会猜测。
- 场景元件 ID 只能来自用户登记或官方指定元件属性流程；不能自动枚举整个 3D 场景，也不能导出完整积木连接图。
- `mapFingerprint` 为空时，属性工作流仅允许同一 `projectInstanceId` 下用户登记为 test/unspecified 且 validity 为 pending/confirmed 的单个目标，并显示“地图身份未由官方确认”；不得升级为 formal 或跨工程使用。
- 自动写代码、替换 ID、编辑属性和推送属性都先显示差异并需要确认；不直接修改 `dist/play.lua` 等官方生成物。
- 属性推送与脚本合成命令在 0.1.0 发布候选中明确标为“实验性（真实编辑器未验收）”；完成无隐私测试元件的读取→差异→二次确认→编辑器画面确认，以及一次脚本合成产物更新前，不暗示它们已通过官方编辑器验收。
- 构建命令只观察官方脚本合成产物，不代表代码语义、游戏运行或地图发布成功。
- VSCode 公共 API 不保证能读取其他扩展的 Output Channel；日志功能只导入用户选择的本机日志文件，并区分本机日志、编辑器画面和多人实测证据。

## 故障排查

- “官方命令不存在”：启用官方扩展和联动，确认当前窗口打开的是含 `src/GameEntry.lua` 的工程。
- “离线/数据陈旧”：重新打开官方联动并刷新；检查 `status --json` 的 `reasonCodes`、来源时间和哈希。
- “启动器校验失败”：不要手改 `ymai.cmd` 或 `cli-launcher.json`，在向导中重新初始化当前工程 CLI。
- “地图身份未由官方确认”：仅使用用户明确登记的 test/unspecified 单个目标；要使用 formal 目标，先让官方数据提供非空地图指纹。
- “RSS 性能门槛未验证”：当前 Windows 100,000 节点子进程 RSS 在 491–547 MB 间波动，仍有运行超过 512 MiB；这不是通过，也不等同 VSIX 或编辑器验收。

## 证据与验收边界

静态检查、单元测试、CLI 集成、Extension Host、VSIX Clean Profile、官方编辑器单人联动和多人实测分别记录。已校准的官方 UI 字段证据见 `docs/evidence/2026-08-20-m1-correction-status.md`；Task 17 自动化状态见 `docs/evidence/2026-08-20-task17-status.md`。VSIX Clean Profile 1.134.0 生命周期已通过；当前仍未把 1.70.2 提升为 1.70.3，也未宣称属性推送或多人实测完成。

## 开发验证

```powershell
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:extension
node scripts/privacy-audit.mjs --json
npm run package:vsix
```

`verify-data-contracts.mjs` 只检查 package/CLI launcher 数据契约；`privacy-audit.mjs` 才执行密钥、绝对地图路径、原始导出、日志和官方二进制扫描。
