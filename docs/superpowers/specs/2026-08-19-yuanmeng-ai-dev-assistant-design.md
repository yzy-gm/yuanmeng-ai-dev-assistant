# 元梦 AI 开发助手设计规格

**产品英文名：** Yuanmeng AI Dev Assistant  
**文档日期：** 2026-08-19  
**目标版本：** 0.1.0  
**交付形态：** 独立 VSCode 伴随扩展、随扩展打包的本地 CLI、工作区本地结构化数据  
**产品命令前缀：** `yuanmengAi.*`  
**数据目录：** 每个元梦工程根目录下的 `.yuanmeng-inspector/`

## 1. 产品定义

元梦 AI 开发助手服务于使用 Lua 制作《元梦之星》UGC 地图的创作者。它与官方“元梦开发助手”并存，通过官方公开注册的 VSCode 命令发起已存在的导出或合成动作，再读取官方已经写入当前工程的文件。它不修改、复制、打补丁、替换或重新分发官方扩展，也不占用官方联动端口或冒充编辑器客户端。

首版把下列耗时工作变成可搜索、可审计、可由本机 AI 调用的流程：

1. 刷新并索引自定义 UI，按名称、ID 或完整路径查询。
2. 保留 UI 快照并精确区分新增、删除、改名、移父级和 ID 变化。
3. 管理带地图作用域和证据状态的 ID、信号与场景层注册记录。
4. 索引官方 Lua 声明、用户 Lua 源码、函数、信号字符串和可信 ID 引用。
5. 提供诊断、CodeLens、悬浮、Quick Fix、审计报告和安全代码生成。
6. 支持指定元件属性的读取、差异预览、备份和经二次确认后的官方推送。
7. 通过 CLI 与 `.yuanmeng-inspector/` JSON 文件向 Codex 和其他本机工具提供相同的数据语义。

产品默认中文显示；稳定的内部命令、JSON 字段和错误码使用英文，便于脚本与 AI 调用。

## 2. 项目边界与隐私红线

### 2.1 独立项目边界

- 产品仓库仅位于本独立任务的仓库根目录；所有命令先以 `git rev-parse --show-toplevel` 或当前任务工作目录确认边界。
- 开发、测试、打包和文档不得写入任何现有地图工程。
- 自动化测试只使用仓库内匿名、自造的 Lua、日志和 UI 夹具。
- 产品默认模板、示例、测试、截图、提交历史和发布物不得包含任何用户地图私有 ID、坐标、信号、日志、名称或业务代码。
- 本机官方扩展目录只读；不得把其中的二进制、压缩代码、图标、媒体、声明文件或版权资源复制进产品仓库或 VSIX。

### 2.2 本地数据与联网

- `.yuanmeng-inspector/` 的地图数据默认只保存在当前工程，不自动上传、遥测或同步。
- 扩展不提供公网监听，不启动远程 API，不绑定官方 UDP 端口。
- 首版不把 MCP 作为依赖。MCP 只能在后续独立规格中基于同一 CLI/JSON 契约增加。
- `.yuanmeng-inspector/.gitignore` 内容固定为忽略该目录内除自身外的全部文件；扩展同时检查仓库忽略状态并在可能被提交时显示警告，但不擅自修改用户工程根 `.gitignore`。
- GitHub 上传前必须执行密钥、令牌、日志、真实地图数据、官方二进制与版权资源扫描。仓库名固定为 `yuanmeng-ai-dev-assistant`，可见性必须为 public；公开源码不改变地图数据默认仅保存在本机的边界。

## 3. 已核对证据与能力边界

### 3.1 2026-08-19 本机官方扩展静态证据

只读检查对象：

`%USERPROFILE%\.vscode\extensions\dreamhelper.dream-helper-1.4.7`

已静态确认：

- `package.json` 声明显示名“元梦开发助手”、版本 `1.4.7`、VSCode 引擎 `^1.70.0`。
- 官方 README 声明开发/运行环境为 VSCode 大于 1.70、Node.js 大于 20，工程需含 `src/GameEntry.lua`，产物位于 `dist/play.lua` 或 `dist/play.min.lua`。
- `package.json` 注册：
  - `dreamhelper.startWork` / `dreamhelper.endWork`
  - `dreamhelper.scriptGen`
  - `dreamhelper.GetCustomUIData`
  - `dreamhelper.GetCustomPropertyData`
  - `dreamhelper.sendCustomPropertyData`
- 压缩后的本机代码静态显示：
  - 扩展实例从端口 `2356` 初始化本机联动；README 说明失败时可能使用后续端口。
  - 联动消息枚举包含 `MAP_INFO`、`CUSTOM_UI_DATA`、`CUSTOM_PROPERTY_DATA`、`UPLOAD_CUSTOM_PROPERTY_DATA` 和 `CUSTOM_DATA_RESULT`。
  - `MAP_INFO` 被保存为含 `mapName`、`curLayerId`、`layer[].layerId`、`layer[].layerName` 的对象并用于官方属性面板。
  - UI 数据写入激活工程 `src/Data/CustomUIData.lua`；分片消息可写入 `src/Data/CustomUIData2.lua`。
  - 属性数据按 `src/Data/CustomProperty_<layerId>_<uid>.lua` 写入。
  - `dreamhelper.GetCustomUIData` 向官方既有联动发送 `CUSTOM_UI_DATA` 请求。
  - 官方工程识别检查 `src` 与 `src/GameEntry.lua`，脚本合并写入 `dist/play.lua`。
- `res/lib` 中存在 46 个 `*.d.lua` 声明文件，可作为本机官方 API 静态索引来源。
- 官方 `activate` 静态代码没有返回可供其他扩展读取的 API 对象；当前不能通过 `extensions.getExtension(...).exports` 取得内部 `mapInfo`。
- 官方命令清单与定向静态搜索未发现“导出完整积木图”或“读取当前地图全部积木连接关系”的命令。

这些结论全部属于“本机官方扩展静态证据”，不证明官方编辑器当前已联动、导出格式在运行中可解析、属性已应用、脚本已在游戏中运行或多人行为正确。

### 3.2 VSCode 公共 API 边界

VSCode 公共 API 提供 `commands.getCommands`、`commands.executeCommand`、扩展枚举、文件系统监听、TreeView、诊断、CodeLens、悬浮和 OutputChannel 创建能力。`OutputChannel` 公共对象只有写入、显示、隐藏、清空和替换方法，没有读取另一个扩展 OutputChannel 内容或订阅其写入的公共方法。因此：

- 产品可以动态检测并调用官方注册命令。
- 产品不能宣称自动实时读取官方 Output Channel。
- 日志主流程必须是用户选择日志文件或当前可读取文本；内部 VSCode 日志目录扫描只能作为默认关闭、明确标注版本脆弱的兼容适配器。
- 若用户手动把输出通道内容打开为可访问的文本编辑器，产品可提供“导入当前文本”命令，但不把它描述为实时订阅。

参考：<https://code.visualstudio.com/api/references/vscode-api>、<https://code.visualstudio.com/api/extension-guides/command>。

### 3.3 证据标签

每个状态、报告和验收项使用以下标签之一，低等级不得替代高等级：

| 标签 | 证明范围 |
|---|---|
| `STATIC_LOCAL` | 本机文件、命令声明、源码结构或自动化静态检查 |
| `UNIT_E2E` | 核心库或 CLI 在隔离夹具中的自动化结果 |
| `EXTENSION_HOST` | VSCode Extension Host 中命令、视图、诊断和文件监听行为 |
| `VSIX_CLEAN_PROFILE` | VSIX 在干净 VSCode Profile 中可安装、激活和卸载 |
| `OFFICIAL_EDITOR_SINGLE` | 当前官方编辑器版本中的单人联动、文件导出或属性应用 |
| `OFFICIAL_EDITOR_MULTI` | 已说明人数和操作时序的多人实际结果 |
| `USER_ATTESTED` | 必须由用户观察编辑器画面后确认的结果 |

任何未获得对应证据的门槛都显示“未验证”，不得在总状态中折算为通过。

## 4. 架构选型

### 4.1 比较过的方案

| 方案 | 优点 | 风险 | 决策 |
|---|---|---|---|
| A. 独立伴随扩展 + 共享核心库 + CLI + 工作区文件队列 | 与官方共存；无端口冲突；UI 与 CLI 共享语义；可离线查询；易测试 | 不能直接读取官方内存状态；刷新完成需通过文件变化判断 | 采用 |
| B. 包装、修改或复用官方扩展内部模块 | 能接触更多内部状态 | 版本脆弱、版权和分发风险、会破坏官方更新与并存目标 | 拒绝 |
| C. 常驻 localhost HTTP/MCP 服务 | AI 调用方便、请求响应直接 | 增加监听面、鉴权和生命周期复杂度；首版并不需要远程能力 | 首版拒绝 |

### 4.2 CLI 到 VSCode 的桥接比较

首版采用受控文件请求队列，不采用 localhost 服务：

1. 扩展激活时为每个工程创建仅当前会话有效的随机令牌，并原子写入 `.yuanmeng-inspector/runtime/session.json`。
2. CLI `refresh-ui` 校验工程后写入带令牌、工程实例 ID、请求 ID、动作、创建时间和 60 秒过期时间的临时文件，再原子重命名到 `requests/pending/`。
3. 扩展只接受白名单只读动作 `refresh-ui`。令牌错误、工程不匹配、过期、重复或未知动作均拒绝并写结果。
4. 扩展调用官方命令并等待目标文件稳定更新；结果写入 `requests/results/<requestId>.json`。
5. CLI 默认等待 30 秒；Extension Host 不存在、会话过期或导出超时分别返回可区分状态。
6. 属性推送、代码写入、ID 替换和脚本合成不接受无人值守文件请求，必须从 VSCode 用户界面启动并确认。

文件队列没有监听端口，天然只对拥有本机文件访问权的进程开放；短期令牌、TTL、动作白名单、工程绑定和原子写入进一步防止旧请求或恶意仓库内容被自动执行。

## 5. 系统结构

仓库采用一个 TypeScript 包，按责任拆分而不引入多包工作区复杂度：

```text
src/
  core/         纯 TypeScript 领域模型、解析、索引、差异、审计、存储与启动器契约
  integrations/官方命令能力、API 声明源、构建与属性适配器
  extension/    VSCode 激活、视图、状态栏、诊断、交互确认与工程启动器生成
  cli/          命令行解析、文本/JSON 输出、退出码
  generated/    只含产品自有 JSON Schema 的构建产物
test/
  unit/         纯核心单元测试
  integration/ 目录、半写入、队列、CLI 进程测试
  extension/   Extension Host 测试
  fixtures/     匿名自造 Lua、UI、属性、日志和工程夹具
scripts/        构建、打包、隐私审计、干净 Profile 验收脚本
```

关键边界：

- `core` 不导入 `vscode`，CLI 和 Extension Host 使用同一套模型与规则。
- `integrations` 只通过接口访问文件、时间、哈希和官方命令，测试可替换为内存适配器。
- `extension` 不解析业务文件；它负责路由、交互、渲染和生命周期。
- `cli` 不尝试加载 VSCode 内部模块；离线命令直接读索引，需要 VSCode 的刷新命令只通过请求队列。

## 6. 核心数据契约

所有 JSON 顶层包含 `schemaVersion: 1`。时间使用 UTC ISO 8601；哈希使用小写十六进制 SHA-256；路径在 JSON 中保存为相对工程根目录、使用 `/` 分隔。

### 6.1 工程与地图身份

```ts
type LinkState = 'unknown' | 'online' | 'offline';
type Freshness = 'missing' | 'fresh' | 'stale';

interface ProjectIdentity {
  schemaVersion: 1;
  projectInstanceId: string; // 首次初始化生成的 UUID
  projectRootHash: string;   // 规范化绝对路径的 SHA-256，不暴露真实路径
  hasSrc: boolean;
  hasGameEntry: boolean;
  mapFingerprint: string | null;
  mapName: string | null;
  currentLayerId: string | null;
  layers: Array<{ layerId: string; layerName: string }>;
}
```

`mapFingerprint = sha256("ym-map-v1\0" + mapName + "\0" + sorted(layerId + "\0" + layerName))`。只有已获得当前官方 `MAP_INFO` 运行证据时才生成；否则为 `null`。注册中心不得把 `null` 指纹记录自动提升为正式状态。

### 6.2 来源、状态与陈旧规则

```ts
interface SourceEvidence {
  kind: 'official-export' | 'official-declaration' | 'user-entry' | 'source-scan' | 'imported-log';
  relativePath: string | null;
  sha256: string;
  observedAt: string;
  officialExtensionVersion: string | null;
  evidence: 'STATIC_LOCAL' | 'UNIT_E2E' | 'EXTENSION_HOST' | 'OFFICIAL_EDITOR_SINGLE' | 'OFFICIAL_EDITOR_MULTI' | 'USER_ATTESTED';
}

interface InspectorStatus {
  schemaVersion: 1;
  project: ProjectIdentity;
  officialCommands: Record<string, boolean>;
  link: { state: LinkState; reasonCode: string; lastProbeAt: string | null };
  ui: { freshness: Freshness; lastRefreshAt: string | null; sourceHashes: Record<string, string>; reasonCodes: string[] };
  issueCounts: Record<'error' | 'warning' | 'info', number>;
}
```

UI 数据在任一条件满足时为 `stale`：源文件哈希与索引不一致；最近一次刷新超时或断联；地图指纹变化；官方扩展版本变化后尚未重建；或距离最后一次成功刷新超过配置 `yuanmengAi.staleAfterMinutes`，默认 30 分钟。没有快照为 `missing`。只有本次请求后观察到稳定的新文件并成功解析、且地图指纹未冲突时为 `fresh`。

### 6.3 UI 节点与快照

```ts
interface UiNode {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  path: string;       // 例如 /HUD/经验
  depth: number;
  siblingIndex: number;
  sourceFile: 'src/Data/CustomUIData.lua' | 'src/Data/CustomUIData2.lua';
  sourceRange: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
}

interface UiSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  projectInstanceId: string;
  mapFingerprint: string | null;
  sources: SourceEvidence[];
  nodes: UiNode[];
  duplicateNames: Array<{ name: string; paths: string[] }>;
}
```

路径组件中的 `/` 与 `~` 分别转义为 `~1` 与 `~0`，使完整路径稳定且可逆。节点按 `path`、`id` 排序，JSON 输出可重现。

### 6.4 ID 与信号注册中心

```ts
type RegistryKind = 'ui-control' | 'scene-instance' | 'element-type' | 'scene-layer' | 'signal' | 'camera' | 'other';
type RegistryEnvironment = 'test' | 'formal' | 'unspecified';
type RegistryValidity = 'pending' | 'confirmed' | 'invalid' | 'suspected-change';
type RegistryScope = 'workspace' | 'map' | 'scene-layer';

interface RegistryRecord {
  recordId: string;
  kind: RegistryKind;
  name: string;
  value: string;
  scope: RegistryScope;
  projectInstanceId: string;
  mapFingerprint: string | null;
  layerId: string | null;
  environment: RegistryEnvironment;
  validity: RegistryValidity;
  source: SourceEvidence;
  lastConfirmedAt: string | null;
  notes: string;
}
```

`environment` 表达记录所属使用环境，`validity` 表达当前有效性，两者正交；因此 `test + confirmed`、`formal + suspected-change` 等组合均可表示。UI 快照只自动创建 `ui-control` 记录：`environment` 固定为 `unspecified`；当快照具有当前地图指纹且刷新为 fresh 时 `validity=confirmed`，否则 `validity=pending`。任何同步、导入或确认流程都不得把 `environment=test` 自动提升为 `formal`，`formal` 只能由用户在差异预览中明确选择。导入事务在写入前分别校验 `environment` 与 `validity`、重复 `recordId`、作用域、指纹和 CSV/YAML 类型。

### 6.5 CLI 信封与退出码

所有 `--json` 输出使用：

```ts
interface CliEnvelope<T> {
  schemaVersion: 1;
  ok: boolean;
  code: 'OK' | 'OFFLINE' | 'STALE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'VALIDATION_FAILED' | 'USAGE_ERROR' | 'INTERNAL_ERROR';
  message: string;
  data: T | null;
  warnings: string[];
}
```

| 退出码 | 语义 |
|---:|---|
| 0 | 成功且满足新鲜度要求 |
| 2 | VSCode/官方能力离线或不可用 |
| 3 | 有结果但数据陈旧；显式 `--allow-stale` 后可返回 0，信封仍保留警告 |
| 4 | 歧义，必须选择候选 |
| 5 | 未找到 |
| 6 | 输入、文件、Lua、Schema 或写入验证失败 |
| 7 | 命令用法或配置错误 |
| 8 | 未分类内部错误 |

## 7. 安全 Lua 解析

解析器使用 `luaparse` 只生成 AST，绝不执行 Lua。通用的 `parseLuaLiteralDocument` 只接受：

- 一个可选的 `return` 语句和一个根表；
- 字符串、有限数值、布尔、`nil`；
- 仅含上述值的嵌套表；
- 标识符键、字符串/数字字面量键和数组项；
- 数值字面量前的一元负号。

函数调用、函数定义、变量读取、成员访问、赋值、副作用语句、拼接、算术表达式、元表、循环和条件语句全部以 `UNSAFE_LUA_NODE` 拒绝。限制为单文件 16 MiB、最大 200,000 个 AST 节点、最大嵌套 256 层、字符串最大 4 MiB；超限返回验证失败。

文件监听采用“稳定窗口”：检测创建/变化后每 150 毫秒采样一次大小与 mtime，连续三次相同才读取，最长等待 5 秒；读取后再次校验哈希。半写入、UTF-8 损坏或解析失败保留上一份有效索引，并把新状态标记为 stale，不覆盖已知好快照。

UI 适配器不根据任意表猜节点。它只接受经契约测试登记的字段组合，并在未知结构时输出 `UNSUPPORTED_UI_SCHEMA`、根表键摘要和匿名结构哈希。首次真实编辑器验收使用无隐私测试工程校准格式；进入仓库的回归夹具只能人工重建相同结构并使用虚构名称与 ID。

## 8. 功能设计

### 8.1 环境、工程与官方联动

- Extension Host 激活时检测系统 Node 仅用于 CLI 提示和工程启动器状态；扩展本身运行在 VSCode 自带 Extension Host，绝不把系统 Node 版本当作扩展宿主版本。
- 官方命令通过 `commands.getCommands(true)` 动态检测，不声明 `extensionDependencies`。
- 官方声明目录通过 `vscode.extensions.all` 的扩展元数据和 `res/lib/*.d.lua` 特征定位；多候选时让用户选择，不静默选取。
- 每个 Workspace Folder 独立检查 `src/GameEntry.lua`。没有活动编辑器且存在多个有效工程时，命令必须 QuickPick 选择工程。
- 联动初始状态为 `unknown`。成功调用刷新并观察到新导出后为 `online`；命令缺失或已发起刷新但超时为 `offline`。仅命令存在不能证明在线。
- `MAP_INFO` 没有本产品可直接读取的公共接口。产品只能在官方导出或兼容证据中实际取得字段时展示地图和场景层；否则显示“官方数据未提供”，不从目录名猜测。
- 版本 0.1.0 不把用户手填地图名伪装成官方 `MAP_INFO`。没有公共官方来源时，状态栏显示地图未知，注册中心仍以 `projectInstanceId` 隔离工程；自动记录使用 `environment=unspecified, validity=pending`，且不能提升为 formal。
- 一键刷新调用 `dreamhelper.GetCustomUIData`，以调用前哈希为基线，等待任一 UI 文件变化并稳定，再在 2 秒合并窗口内收集两个分片；总超时默认 15 秒。
- 文件未更新、仅一个分片损坏、地图指纹冲突或官方命令消失均保留旧索引并显示具体下一步。

### 8.2 UI 全量索引、搜索和差异

- `CustomUIData.lua` 与 `CustomUIData2.lua` 分别安全解析，再按根级顺序和来源文件合并；重复 ID 不覆盖，产生错误诊断。
- 精确名称搜索优先；唯一命中直接返回。多个同名命中返回 `AMBIGUOUS` 与完整路径候选。
- ID 搜索要求完整相等；路径搜索支持完整路径和路径片段；模糊搜索必须显式选择，不得覆盖精确结果。
- “经验”唯一时返回 ID、类型、完整路径、父级和来源；重名时只列候选，不选第一个。
- TreeView 节点操作：复制 ID、完整路径、`local NAME = <id>` 常量；常量标识符由名称规范化并在冲突时要求用户确认。
- 导出支持 JSON、UTF-8 BOM CSV 和 Markdown。首版不生成 XLSX；CSV 可被 Excel 打开且产品不依赖 Excel。

差异匹配规则：

1. 相同 ID 唯一匹配；比较名称、父 ID、路径和类型，分别产生 `renamed`、`moved`、`typeChanged`。
2. 未匹配节点按 `(type, escaped parent-name lineage, name)` 唯一匹配时产生 `idChanged`。
3. 同一对节点可同时包含多个字段变化。
4. 非唯一候选产生 `ambiguousPotentialChange`，保留为新增与删除，不做推测性配对。
5. 其余节点分别为 `added` 和 `removed`。

### 8.3 ID 与信号注册中心

- 分类和状态严格使用第 6.4 节枚举。
- 场景元件实例 ID 只来自用户登记或官方指定元件属性工作流；不提供全场景枚举入口。
- 记录显示来源哈希、最后确认时间、`environment`、`validity` 和证据标签。跨地图指纹的记录默认不参与 CodeLens、生成或自动修复，并产生 `CROSS_MAP_REFERENCE`。
- JSON/YAML/CSV 导入采用“解析 → 全量校验 → 差异预览 → 用户确认 → 原子替换”；任一行失败则整个事务不写入。
- 快照中已消失的 UI ID 只把 `validity` 标记为 `suspected-change`，保留原 `environment`；经用户确认后才把 validity 转为 `invalid`。

### 8.4 元件自定义属性

- 用户从已登记 `scene-layer` 与 `scene-instance` 记录选择 layerId/uid。
- 当当前 `mapFingerprint` 非空时，所选 layer/instance 必须与当前 `projectInstanceId` 和 `mapFingerprint` 严格匹配，且 validity 只能为 pending 或 confirmed。
- 当当前 `mapFingerprint` 为空时，只允许选择同一 `projectInstanceId` 内、由用户明确登记（`source.kind=user-entry`）、`environment` 为 test 或 unspecified、`validity` 为 pending 或 confirmed 的单个 layer 与单个 instance。formal、invalid、suspected-change、跨工程、批量目标或非用户登记记录全部拒绝。
- 空指纹流程的读取、编辑预览和两次确认界面始终显示“地图身份未由官方确认”；它不能改变 environment，不能把记录提升为 formal，也不能作为跨工程复用依据。
- 本产品复制 `layerId;uid` 提示并调用 `dreamhelper.GetCustomPropertyData`。本机静态证据显示官方命令会打开自己的属性面板，公共命令参数不能可靠预填，因此本产品不宣称自动填入官方面板。
- 监听对应 `CustomProperty_<layerId>_<uid>.lua`，稳定后安全解析、保存快照并显示属性搜索和差异。
- 结构化编辑只允许修改已有的字符串、数值、布尔和 nil 字面量源范围，不重排未知表结构。
- 写入前保存带原哈希的备份；展示 VSCode diff；首次确认后写文件。推送再显示目标 layerId/uid、地图指纹、文件哈希和变更摘要，要求第二次明确确认。
- 推送调用 `dreamhelper.sendCustomPropertyData` 并传入该文件 `Uri`。调用成功只记录 `push-requested`；没有 `OFFICIAL_EDITOR_SINGLE` 或 `USER_ATTESTED` 证据时不得显示“编辑器已应用”。
- 不提供批量推送。正式手工验收只使用无隐私测试元件。

### 8.5 官方 Lua API 知识与检查

- 扫描当前选定官方扩展的 `res/lib/*.d.lua`、可识别补全数据和本地官方文档元数据，不复制源文件。
- 解析模块、方法、冒号/点调用形式、参数、返回值、枚举、注释摘要、相对来源路径、文件哈希和官方扩展版本。
- 搜索同时索引中文注释、英文模块名与方法名。未命中返回 `NOT_FOUND`，不生成相似 API。
- API 更新按稳定键 `module + callStyle + name` 比较新增、删除和签名变化。
- Lua 诊断只对已确认官方模块检查未知成员；参数数量按必需参数和可变参数检查；类型只检查字符串、数值、布尔、nil、表等可由字面量确认的情况。
- 每条提示区分 `official-signature-confirmed` 与 `editor-runtime-verified`，默认只有前者。

### 8.6 Lua 工程理解与导航

- 索引 `.lua` 文件、模块返回、顶层/局部函数、调用、require 字符串、信号候选、字符串字面量、数字字面量和配置字段。
- 数字只有在满足至少一项时才成为 ID 引用：与当前注册值完全匹配；位于已确认 API 的 ID 参数；或位于用户配置的 ID 字段。其他数字只作为普通字面量，不报“未登记 ID”。
- 信号发送/监听角色只有在官方签名或用户注册元数据确认调用语义时才标注；否则显示“信号字符串候选”。
- `where-used` 可按 ID、信号或 UI 名称返回相对路径、行列、上下文和置信度。
- 客户端/本地表现/服务端权威边界以调用 API、注册回调、数据流和用户注解作为证据，输出 `confirmed`、`inferred` 或 `unknown` 及理由，不凭文件名定性。
- 功能报告按入口函数或用户选择符号生成调用关系、读写 ID、信号、API 和未解析边。

### 8.7 VSCode 体验

活动栏容器“元梦 AI 开发助手”包含：

- 环境与当前工程视图；
- UI 树；
- 搜索结果；
- ID/信号注册中心；
- 项目问题与审计摘要。

状态栏固定显示“工程 | 地图 | 联动 | 最后刷新 | 问题数”。未知信息使用“未知/未提供”，不留空。

新手向导严格为：检测官方插件/命令 → 指引或调用“开启联动环境” → 选择并检查激活工程 → 刷新 UI → 搜索示例名称。每一步显示通过条件和修复动作。

诊断、CodeLens、悬浮和 Quick Fix：

- 已登记 ID 显示名称、状态、作用域、地图指纹匹配状态。
- 失效或跨地图 ID 提供“打开注册记录”“查看候选”“预览替换”操作。
- 未知官方 API 提供“搜索官方 API 索引”，不自动替换。
- Quick Fix 只生成预览；应用仍需确认。

多工程工作区由 `WorkspaceContextManager` 为每个 folder 建立独立存储、监听器和索引。任何命令先解析目标工程；无法唯一解析时必须让用户选择。

### 8.8 安全代码生成

- 所有模板从当前 UI/注册/API 索引读取参数，不携带产品默认 ID。
- 支持 Lua 常量/配置、按钮事件注册、显隐、文本刷新、信号发送和信号监听模板。
- 生成前要求目标 API 签名在当前官方索引唯一命中；否则拒绝。
- 网络或多人模板必须从已确认的服务器回调参数取得 `playerId`，不得使用客户端自报身份；没有可确认路由证据时拒绝生成。
- 生成结果先进入内存 `PatchProposal`，使用只读虚拟文档和 `vscode.diff` 预览。用户确认后保存备份并通过 `WorkspaceEdit` 应用。
- 备份记录原文件哈希、新文件哈希和相对路径；撤销时若当前哈希已变化则拒绝覆盖并要求人工合并。
- 永不直接编辑 `dist/play.lua`、`dist/play.min.lua`、官方扩展文件或未知生成物。

### 8.9 构建、审计与报告

- “合成游戏脚本”是显式用户动作。执行前说明官方流程可能清理 `dist`，记录目标产物哈希与 mtime，再调用 `dreamhelper.scriptGen`。
- 在 60 秒内观察 `dist/play.lua` 或 `dist/play.min.lua` 稳定更新。更新只证明产物变化；未更新、超时和命令缺失分别报告。
- 审计规则分别覆盖 `environment=test`、`validity=pending/invalid/suspected-change`、缺失注册、同名 UI、重复 ID、跨地图引用、未知 API、参数数量、过期快照、损坏导出和未验证属性推送。
- 验收清单和交接报告同时列出自动化、Extension Host、干净 VSIX、官方编辑器单人和多人证据，不自动勾选人工项。
- 产品不自动发布地图，不宣称替用户完成官方编辑器试玩。

### 8.10 日志诊断

- 主入口为“导入日志文件”和 CLI `log-import`；支持 UTF-8、UTF-8 BOM 和可识别的本机系统编码失败提示。
- 解析时间、级别、玩家、请求、信号和阶段字段；未知格式保留原始行并标记 `unparsed`。
- 聚合支持时间段、玩家、请求、信号、阶段和错误级别。
- “导入当前可读取文本”只读取用户明确打开并选择的文档。
- VSCode 内部日志目录适配器默认关闭、要求用户选择目录、显示当前 VSCode 版本和兼容风险，并始终提供文件导入回退。
- 报告分栏展示“本机日志证据”“编辑器画面证据”“多人实测证据”，不得互相替代。

### 8.11 CLI

CLI 代码随 VSIX 打包，但 `package.json#bin` 不被视为 VSIX 安装后的 PATH 安装机制。产品不修改系统或用户 PATH，也不要求 `npm install -g`。每个初始化工程由扩展原子生成并刷新：

```text
.yuanmeng-inspector/bin/ymai.cmd
.yuanmeng-inspector/bin/cli-launcher.json
```

`cli-launcher.json` 包含 schemaVersion、extensionId、extensionVersion、extensionRootHash、cliPath、cliSha256、projectInstanceId、projectRootHash 和 generatedAt。`ymai.cmd` 内嵌同一目标路径与 SHA-256，并通过固定的本机 PowerShell 校验逻辑完成以下门槛后才调用系统 Node：目标真实路径位于记录的扩展安装根目录；文件存在；文件哈希与内嵌值及 JSON 一致；扩展 ID/版本与 JSON 一致；系统 Node 主版本至少为 20。校验逻辑不使用 `Invoke-Expression`，不把 JSON 字段拼成命令字符串。

扩展升级、安装路径或 CLI 哈希变化时，扩展对两个启动器文件执行同目录临时文件 + flush + rename 的原子刷新。扩展卸载或路径失效后，旧 `ymai.cmd` 必须输出“元梦 AI 开发助手已卸载或安装路径失效”，返回退出码 2，并且不执行该路径中的任何文件；哈希或根目录校验失败返回退出码 6。拥有工程文件写权限的进程可以篡改启动器本身，不在产品可防御范围内；产品保证未篡改的旧启动器不会因路径复用而执行哈希不符的文件。

向导提供“复制当前工程 CLI 命令”，复制的 PowerShell 命令固定为：

```powershell
& ".\.yuanmeng-inspector\bin\ymai.cmd" status --json
```

Codex 从工程根目录优先发现 `.yuanmeng-inspector/bin/cli-launcher.json`，再调用同目录 `ymai.cmd`；无需全局安装。文档中的简写 `ymai` 仅表示该工程启动器，实际用户命令均显示工程内路径。

首版 CLI 子命令：

```text
& ".\.yuanmeng-inspector\bin\ymai.cmd" status [--project <path>] [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" refresh-ui [--project <path>] [--timeout 30] [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" find-ui <query> [--path] [--fuzzy] [--allow-stale] [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" diff-ui [--from <snapshotId>] [--to <snapshotId>] [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" list-ids [--kind <kind>] [--environment <test|formal|unspecified>] [--validity <pending|confirmed|invalid|suspected-change>] [--allow-stale] [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" audit [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" export <ui|ids|audit> --format <json|csv|md> --out <path> [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" api-search <query> [--json]
& ".\.yuanmeng-inspector\bin\ymai.cmd" where-used <value> [--kind <id|signal|ui>] [--json]
```

CLI 从启动器绑定工程或显式指定路径向上查找 `src/GameEntry.lua`；启动器绑定与 `--project` 冲突时返回验证失败。发现零个工程返回用法错误，发现多个候选拒绝猜测。人类输出面向创作者，JSON 输出严格使用信封。所有读取旧数据的命令遵守 stale 退出码。

## 9. 错误模型与恢复

错误对象包含稳定 `code`、中文 `message`、`nextActions[]`、`evidence` 和可选 `cause`。用户消息必须指出下一步。例如：

- `OFFICIAL_COMMAND_MISSING`：启用/安装官方扩展并重新载入窗口。
- `LINK_NOT_CONFIRMED`：运行官方“开启联动环境”并在编辑器建立连接。
- `EXPORT_TIMEOUT`：确认当前工程已激活、编辑器联动在线，再重试。
- `SOURCE_NOT_STABLE`：等待官方写入完成；旧快照仍可读取但已标陈旧。
- `AMBIGUOUS_UI_NAME`：从完整路径候选选择，不自动返回 ID。
- `MAP_FINGERPRINT_MISMATCH`：切换正确工程或重新确认注册记录。
- `UNSAFE_LUA_NODE`：导出包含可执行 Lua，产品拒绝执行并保留旧索引。
- `PUSH_NOT_VERIFIED`：官方推送已请求，但需在编辑器检查测试元件。

原子写入统一使用同目录临时文件、`fsync`、重命名；Windows 下重命名冲突进行最多 5 次、指数间隔不超过 1 秒的重试。写入失败不删除上一版本。

## 10. 配置默认值

| 设置 | 默认值 | 说明 |
|---|---:|---|
| `yuanmengAi.staleAfterMinutes` | 30 | 快照年龄陈旧阈值 |
| `yuanmengAi.uiRefreshTimeoutSeconds` | 15 | 官方 UI 导出等待上限 |
| `yuanmengAi.buildTimeoutSeconds` | 60 | 脚本产物更新等待上限 |
| `yuanmengAi.fileStableSampleMilliseconds` | 150 | 文件稳定采样间隔 |
| `yuanmengAi.fileStableSampleCount` | 3 | 连续稳定样本数 |
| `yuanmengAi.enableRequestQueue` | true | 只允许白名单只读 CLI 请求 |
| `yuanmengAi.enableInternalLogAdapter` | false | VSCode 内部日志兼容适配器 |
| `yuanmengAi.officialExtensionPath` | 空 | 仅在自动发现歧义时由用户配置 |

## 11. 技术栈、兼容性与依赖

- TypeScript strict，`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride` 开启。
- 系统 Node.js 要求 `>=20`，只用于独立 CLI、开发、测试和打包。本机核对版本为 `v24.18.0`。
- VSCode 引擎为 `^1.70.0`，与本机官方扩展声明一致。扩展及被扩展导入的共享 core 必须兼容 VSCode 1.70.3 实际 Extension Host Node 运行时；系统 Node >=20 不能替代此门槛。
- 构建分为两个目标：extension bundle 使用 Node 16 类型边界并以 esbuild `target=node16.13` 打包；CLI bundle 使用 `target=node20`。`src/core`、`src/integrations` 和 `src/extension` 禁止引用 Node 20-only API，只有 `src/cli` 可以使用 Node 20 能力。
- ES2020 语法目标只是必要条件，不是兼容性证据。1.70.3 Extension Host 测试必须记录 `process.versions.node`，并在真实宿主中执行哈希、原子文件、随机令牌、Lua 解析、YAML 解析和工作区上下文 smoke test；任一缺失或异常阻止发布。
- 本机 VSCode 为 `1.133.0`；自动化同时覆盖可运行的 1.70.x 最低版本和当前稳定版。
- 运行时依赖仅：`luaparse`（MIT，AST 解析）与 `yaml`（ISC，YAML 导入导出）。
- 开发依赖：TypeScript、esbuild、Vitest、`@vscode/test-electron`、`@vscode/vsce`、ESLint 与必要类型包。
- 不加入数据库、Web 框架、遥测 SDK、Excel 自动化、MCP SDK 或网络服务器。

公开仓库不自动授予开源许可。首版使用 `license: "UNLICENSED"`，并以 `LICENSE` 与 `NOTICE.md` 明确“源码公开可见、All rights reserved、未授予复制、修改或再分发许可”；不采用 MIT、Apache-2.0 等开源许可证。`THIRD_PARTY_NOTICES.md` 只列出运行时和发布包中实际包含的第三方依赖、版本、许可证与来源。若未来开源，必须由用户另行选择许可证并单独审查。

## 12. 测试策略

### 12.1 单元与 CLI 端到端

- 安全 Lua：允许字面量，拒绝调用/变量/函数，覆盖损坏 UTF-8、16 MiB、深度、节点数和半写入。
- UI：双分片、10 万节点、重复名称、重复 ID、路径转义、唯一/歧义搜索、五类差异和歧义不配对。
- 注册中心：`environment` 与 `validity` 全部合法组合、地图隔离、test 永不自动升级 formal、三种格式事务导入和双字段筛选。
- API：声明解析、中文/英文搜索、未知 API、参数数量、字面量类型、版本差异。
- Lua 索引：require、函数、信号候选、可信 ID、普通数字不误报、where-used。
- 属性：文件名、layerId/uid 绑定、字面量源范围编辑、备份、哈希冲突和二次确认状态机。
- CLI：工程启动器生成/刷新/发现、每条命令的人类/JSON输出和 0/2/3/4/5/6/7/8 退出码。

### 12.2 Extension Host

- 官方命令存在/缺失检测。
- 多根工作区隔离与活动工程选择。
- UI 文件创建、变化、分片、超时和半写入监听。
- 请求令牌、TTL、重复、错误工程、未知动作和正常 refresh-ui。
- 工程启动器的安装路径含空格/中文、扩展升级、路径变化、卸载失效、哈希不符、Node 缺失/低版本和 CLI 参数转发。
- VSCode 1.70.3 宿主能力 smoke test，证明 extension/core 不依赖 Node 20-only API。
- TreeView、状态栏、诊断、CodeLens、悬浮、Quick Fix 与 diff 确认流程。
- 代码写入、属性写入、属性推送和脚本合成均验证确认门。

### 12.3 性能门槛

在本机 Node 20+ 自动化环境，匿名 100,000 节点、总 16 MiB 的双分片 UI：解析、规范化和索引在 5 秒内完成，峰值 RSS 小于 512 MiB；精确名称查询 P95 小于 100 毫秒。性能失败阻止 VSIX 发布。

### 12.4 打包和真实验收

- `npm run verify` 必须完成类型检查、lint、单元、CLI E2E、Extension Host、构建、依赖/许可证和隐私扫描。
- `npm run package:vsix` 生成 VSIX；VSIX 内容清单不得含夹具原始日志、`.yuanmeng-inspector`、官方文件、源码映射、令牌或 `node_modules` 非打包副本。
- 在全新 `--user-data-dir` 与含空格/中文路径的 `--extensions-dir` 中安装 VSIX，验证与官方插件并存、禁用官方插件时优雅降级、工程启动器可发现。测试脚本在 `work/` 生成并随后删除仅版本/构建哈希不同的升级夹具 VSIX，实际安装它以验证启动器刷新，再更换 extensions-dir 验证路径迁移；夹具不进入 outputs、Git 或发布物。卸载后旧启动器必须明确失败且不执行未知文件，并确认不修改官方插件或系统 PATH。
- 官方编辑器单人验收使用专门的无隐私测试工程和测试元件，不使用现有地图工程。

## 13. 分阶段交付

### M0：证据、契约与工程基线

建立项目、数据 Schema、错误码、测试夹具和证据清单。结果是可运行的核心契约测试，不包含假 UI。

### M1：官方能力、UI 刷新、解析、搜索、树、快照与 CLI

完成官方命令检测、文件稳定监听、UI 双分片、安全解析、搜索、差异、导出、TreeView 和 `status/refresh-ui/find-ui/diff-ui/export`。该阶段必须能在离线时读取旧快照并明确 stale。

### M2：注册中心、where-used、诊断与报告

完成地图隔离注册、JSON/YAML/CSV、Lua 工程索引、ID/信号引用、CodeLens/悬浮/Quick Fix 和健康报告。

### M3：API 索引、安全生成与构建辅助

完成本机官方声明索引、API 诊断、签名变化、安全模板、补丁预览/备份/撤销和官方脚本合成观察。

### M4：元件属性

完成登记目标选择、官方读取命令、属性快照/搜索/差异、受限字面量编辑、两次确认和应用证据状态。

### M5：日志与证据分类

完成日志文件导入、时间段/玩家/请求/信号/阶段聚合、当前文本导入和默认关闭的内部日志兼容适配器。

### M6：发布候选与真实验收

完成全部自动化、性能、VSIX、干净 Profile、隐私与依赖审计；再进行无隐私官方编辑器单人验收。需要用户参与而未完成的步骤必须记录为未验证。满足上传前置条件后才创建或使用公开 GitHub 仓库并推送，再发布到官方 Visual Studio Marketplace。

每个里程碑都必须有可运行增量、独立测试和提交；不把关键联动集中到最后。

## 14. 验收清单

### 14.1 自动化必须通过

1. 唯一名称“经验”返回准确虚构 ID、类型和完整路径；重名返回歧义退出码与完整路径候选。
2. 双快照准确报告新增、删除、改名、移父级和 ID 变化，歧义变更不误配。
3. 损坏 Lua、可执行 Lua、半写入、超大 UI、重复 ID、官方扩展缺失、离线、超时、多工程并行、启动器失效/篡改和 VSCode 1.70 宿主能力均有失败测试。
4. 已知失效 ID、跨地图 ID、未知 API 和参数数量错误产生诊断；普通数字不被一律当 ID。
5. CLI 无需全局安装或修改 PATH；工程启动器可被 Codex 发现，所有命令提供人类与 JSON 输出并返回规定退出码。
6. 写代码、替换 ID、属性写入、属性推送和脚本合成都不能绕过确认门。
7. `npm run verify`、VSIX 内容审计和干净 Profile 安装全部通过。

### 14.2 官方编辑器单人验收

在无隐私测试工程中：

1. 官方插件与本插件同时启用，官方脚本合成与调试入口仍可使用。
2. 编辑器把控件命名为“经验”；本插件请求刷新后观察官方文件更新并返回正确名称、ID、类型和路径。
3. 创建第二个同名控件后刷新，产品只显示两个完整路径候选。
4. 依次执行新增、删除、改名、移父级和 ID 改变，差异与编辑器实际结构一致。
5. 禁用官方插件或断开联动，产品保留旧快照、显示 stale/offline，且不声称最新。
6. 对一个无隐私测试元件读取属性，编辑一个允许的字面量、预览差异、两次确认推送，并由用户观察编辑器中的实际值。
   - 若官方 `MAP_INFO` 可用，验证严格地图指纹匹配。
   - 若 `mapFingerprint` 为空，验证同工程的 test/unspecified + pending/confirmed 单目标可用，同时验证 formal、跨工程、invalid/suspected-change 和批量目标被拒绝，且界面持续显示“地图身份未由官方确认”。
7. 调用官方脚本合成后，产品只在产物稳定更新时标记“构建产物已更新”，官方插件功能不受影响。

### 14.3 多人证据

产品核心 UI 索引不要求多人房间。任何涉及玩家身份或网络模板的安全结论仅以静态生成约束成立；如未进行两人房间实测，报告明确写 `OFFICIAL_EDITOR_MULTI: 未验证`，不得宣称多人运行通过。

### 14.4 GitHub 与 Visual Studio Marketplace

上传前必须满足：全部本机自动化通过；人工编辑器清单已完成或逐条记录未验证；隐私与 Git 历史扫描为零命中；VSIX 不包含禁止内容；GitHub 已登录且有公开仓库权限。推送前先以 `gh` 查询当前登录账号、目标仓库身份、`PUBLIC` 可见性及权威 SSH/HTTPS URL；若本地 `origin` 已存在，只允许它与该公开目标的权威 URL 一致，禁止盲目 `git remote add`、覆盖或改写不一致的 origin。不一致时在创建仓库或推送前停止并报告。

公开仓库不携带本机开发历史。发布工具只从最终干净提交的当前跟踪文件生成忽略目录内的单提交公开仓库，明确拒绝复制源 `.git`、脏工作树、越界或非空目标、真实导出、日志、VSIX 与其他危险路径；随后对该公开仓库的工作树和唯一历史重新做隐私审计。这样保留本机审计历史而不把旧校准文本公开，也不需要破坏性改写当前仓库。

Marketplace 对外作者名固定为“不见星光”，`package.json.author` 使用该字符串，标题下 description 以“由不见星光开发”开头；计划的 Publisher ID 候选为 `bujianxingguang`，当前候选扩展 ID 为 `bujianxingguang.yuanmeng-ai-dev-assistant`。该 ID 只用于本地打包测试，待用户在 Marketplace 官方管理页成功创建后才最终确认，不能称为已注册、已保留或稳定 ID。Publisher ID 创建后不可变；若候选已被占用，必须在任何公开发布前停止并报告，不能改用本机开发 ID `yuanmeng-local` 或静默选择另一个账号。最终发布预检必须要求 Publisher 已确认、真实 GitHub `repository`/`homepage`/`bugs`、公开目标与匹配 origin；本地 `GalleryFlags=Public` 不等于 Marketplace 已上线。发布包必须使用已审计的同一 VSIX；认证信息只通过官方登录、受控环境变量或 Microsoft Entra 身份进入发布进程，不写入仓库、日志、命令参数、VSIX 或 GitHub Actions 明文。Marketplace 发布后还要从 VSCode 扩展搜索中按名称/关键词找到并安装验证。GitHub 或 Marketplace 失败时报告具体命令、错误与尚未发布状态，不得伪称成功。

## 15. 明确非目标

- 不破解、修改、替换或重新分发元梦客户端、官方扩展和版权资源。
- 不自动枚举完整 3D 场景的全部元件实例 ID。
- 不在元梦编辑器画布创建、移动、删除 UI 控件或场景元件。
- 不读取或回写完整积木连接图；当前静态证据没有确认接口。
- 不自动发布地图或代替官方编辑器试玩。
- 不监听或占用官方 UDP 端口，不冒充官方编辑器客户端。
- 不把静态、单元、CLI、Extension Host 或日志结果描述为官方编辑器或多人实测。
- 不使用任何现有地图工程作为开发目录、测试夹具或示例来源。

## 16. 完成定义

版本 0.1.0 只有在代码、测试、README、CHANGELOG、NOTICE、第三方声明、VSIX、干净 Profile 证据、自动化验收报告和人工门槛状态全部存在时才可称为发布候选。若官方编辑器人工步骤未完成，交付状态必须是“自动化完成，官方编辑器验收未完成”，而不是“全部完成”。GitHub 公开仓库成功推送、Visual Studio Marketplace 成功发布且两端隐私检查通过后，才完成公开交付；这仍不自动提升任何未完成的编辑器或多人证据。
