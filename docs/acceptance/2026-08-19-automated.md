# 自动化与本机打包验收（2026-08-20）

## 运行环境

- 工作区：本独立项目目录；没有读取或提交现有地图工程。
- 系统 Node：满足 `>=20`；Extension Host 稳定版为 VSCode `1.134.0`，内置 Node `24.18.1`。
- 精确 VSCode `1.70.3` 下载入口仍不可用；`1.70.2` 已通过同代宿主测试，但带已隔离宿主噪声，不能升级为 1.70.3 或 clean pass。

## 通过的自动化命令

```text
npm run typecheck             PASS
npm run lint                  PASS
npm run test:unit             PASS (23 files, 145 tests)
npm run test:integration      PASS (11 files, 67 tests)
npm run test:extension        PASS (stable Extension Host; calibrated gate simulation)
node scripts/verify-data-contracts.mjs  PASS (package/data contract only)
node scripts/privacy-audit.mjs --json   PASS (zero repository findings)
npm audit --omit=dev --registry=https://registry.npmjs.org --json  PASS (0 production vulnerabilities)
npm run verify                PASS (typecheck/lint/unit/integration/Extension Host)
```

### 默认集成回归稳定性（最终复跑）

- 公开导出集成用例使用明确的 `30_000ms` 测试上限；本轮完整并行回归实际约 4.6 秒，定向双用例回归约 3.0 秒。该调整只覆盖 Windows Git/杀毒并发抖动，不改变导出器的脏树、目标路径、危险文件名或单提交安全边界。
- CLI 全流程用例使用明确的 `60_000ms` 测试上限；本轮完整并行回归实际约 14.6 秒，定向双用例回归约 14.1 秒。没有扩大产品命令超时。
- `npm run test:integration` 仍使用 `vitest run --dir test/integration`，只发现 11 个仓库测试文件；被忽略的 `work/public-release-repository*` 不会被当作源测试再次扫描。完整结果为 11 文件/67 测试全部通过。

### Earlier dependency-restoration observation (2026-08-20 12:58–13:00)

- `npm run typecheck` and `npm run lint`: PASS.
- `npm run test:unit`: PASS, 23 files / 143 tests. The first post-install run had one timing-sensitive `build-workflow` failure under the initial dependency restoration; three consecutive reruns passed. No product change was made for that transient run.
- `npm run test:integration`: PASS, 10 files / 49 tests; the RSS gate remains explicitly unverified as described below.
- `npm run test:extension`: PASS on stable 1.134.0 with the existing host-noise separation; calibrated UI gate remains simulated Extension Host evidence.
- The machine's configured mirror did not leave the expected `.bin/tsc` launcher during this earlier attempt, so dependencies were temporarily restored with `npm install --ignore-scripts --no-audit --no-fund`. This remains an installation-environment observation; the clean gate was subsequently rerun successfully below using the official npm registry.

Task 17 的子进程大数据测试使用产品默认 Node 参数，并在建立索引后释放不再需要的原始文本/AST。六次连续运行的解析/索引 1.44–1.94 秒、exact-search P95 6.16–17.98 ms 均通过；RSS 为 491–547 MB，其中一次超过 `512 MiB`，因此继续标记 `PERFORMANCE_GATE_UNVERIFIED`。未用 `--optimize-for-size` 提升证据。完整记录见 `docs/evidence/2026-08-20-task17-status.md`。

## VSIX

- `npm run package:vsix`：PASS，生成被 Git 忽略的 `outputs/yuanmeng-ai-dev-assistant-0.1.0.vsix`（18 文件，221.17 KB）。
- 直接读取 VSIX 内 `extension/package.json`：`author="不见星光"`，description 为“由不见星光开发，为《元梦之星》创作者提供本地 UI、ID、Lua 与 API 检查能力的 VS Code 伴随工具。”，扩展 ID 为 `bujianxingguang.yuanmeng-ai-dev-assistant`。这证明本地 VSIX 的详情元数据；Marketplace 页面实际展示仍须发布后单独验收。
- `inspect-vsix.mjs --json`：PASS；修复后重新打包为 22 个文件，包含 bundle、manifest、图标、README、CHANGELOG、NOTICE、第三方声明、验收文档和 schemas；不含 `extension-tests.cjs`、source map、node_modules、日志、`.yuanmeng-inspector`、官方文件、令牌或地图数据。
- Clean Profile 完整生命周期：PASS on VSCode `1.134.0`。一次性 Profile 路径含空格和中文，Trust 仅在该 Profile 禁用；安装、直接 Extension Host 激活日志、官方扩展缺失时的 `OFFLINE/OFFICIAL_COMMANDS_MISSING` 引导、0.1.0→0.1.1 测试升级、扩展目录迁移、显式禁用后不生成 `.yuanmeng-inspector`、正常重启后重新生成 launcher/session、卸载后旧 launcher 明确安全失败和 PATH 不变均有直接断言。窗口最小化启动、每段后按 Profile 精确关闭，测试数据成功后自动清理。本机日常 VSCode `1.133.0` 当时因自身更新锁拒绝启动，因此不作为该行通过证据。
- 最终 18 文件候选 VSIX 的四次独立激活日志 SHA-256：`dba14ed16728a4162fa2c7e72cec3ef24d27864d32c628706dc1dd3ed15d66e3`、`bc0a4bc3091e663cf716ba51c4d46a278e0aaf196d062358bb9304591eaf32f7`、`22106638f83f5c77fa4cae3620a9e1f7dbd11ea8ea9a6c6a95bbec790ef1fd59`、`98fe04c33e1ae2c26904749ec90fd7ba98bfa68414912f06f891707d5e6a9a56`。它们只证明隔离 Extension Host 中的产品激活记录，不证明官方编辑器联动。
- 正常 VSCode 中已确认官方 `dreamhelper.dream-helper` 与伴随扩展 `yuanmeng-local.yuanmeng-ai-dev-assistant` 同时安装。官方命令语义是“获取自定义界面结构”，编辑器侧操作是“更新 VSCode 工程”。真实文件变化仍返回 `REFRESH_SUCCEEDED/online`；稳定旧文件返回 `REFRESH_SUCCEEDED_UNCHANGED`，不报失败但 `link` 保持 `unknown`，并按原快照时间/哈希判断 `fresh/stale`，不能凭 no-op 宣称编辑器当前在线。

### 无变化更新修复回归（2026-08-20 13:48–13:49）

- `npm run verify`：PASS。最新回归为类型检查、lint、23 个单元测试文件/145 个测试、11 个集成测试文件/67 个测试、稳定版 Extension Host 与校准格式门全部通过。
- Extension Host 测试通过真实工作区管理器、工程内 launcher 和请求队列重复调用一次同内容官方命令模拟；返回文案为“结构无变化，继续使用现有快照”，status 为 `REFRESH_SUCCEEDED_UNCHANGED/unknown`，保留原 snapshot ID，快照新鲜度仍按原观察时间和哈希计算。
- 本节前两条仍是自动化/`EXTENSION_HOST` 模拟证据；修复后的 VSIX 随后已在独立校准工程完成真实重复无变化更新，具体证据单列于官方编辑器验收。稳定版宿主输出的账户/聊天通道噪声继续单独记录，不称为 clean pass。

### Task 19 clean gate（2026-08-20）

#### 公开 URL 元数据与最终候选（2026-08-20 19:58）

- `package.json` 已包含 `https://github.com/yzy-gm/yuanmeng-ai-dev-assistant` 的 `repository`、`homepage` 与 `bugs` 字段；`package:vsix` 与 `package:release` 均不使用 `--allow-missing-repository`。
- `npm run package:release`：PASS；同一路径 VSIX 18 文件、约 221.31 KB，SHA-256 `AE68AFC16365CD1C3F06727F823579476F7E9A0C483EA0620EB5583581BEF060`。
- `node scripts/inspect-vsix.mjs outputs/yuanmeng-ai-dev-assistant-0.1.0.vsix --json`：PASS，`findings: []`；包内 author、description、256×256 PNG 与真实仓库 URL 已核对。
- `npm audit --omit=dev --registry=https://registry.npmjs.org --json`：PASS，production vulnerabilities total = 0。
- GitHub 目标仓库已创建/推送；本条只记录本机候选包，不替代下方 GitHub 公开源码交付证据。

#### GitHub 公开源码交付（2026-08-20）

- 目标：`https://github.com/yzy-gm/yuanmeng-ai-dev-assistant`，API 返回 `private=false`、`visibility=public`。
- 最终公开快照来自本机提交 `57f015e`，公开仓库唯一提交为 `85dc9f620dbd28674b24d48edd352385565264ae`；`git ls-remote` 与新鲜克隆 `HEAD` 完全一致。
- 新鲜克隆再次运行 `node scripts/privacy-audit.mjs --repository <clone> --history --json` 与非最终 public preflight，均返回零 findings/`PUBLIC_RELEASE_PREFLIGHT_OK`。
- 本机开发仓库仍无 `origin`；只有被忽略的公开快照目录连接 GitHub，未暴露本机开发历史。

- `git status --short`：无输出，工作树干净；`outputs/` 中的 VSIX 按设计被忽略。
- `npm ci --registry=https://registry.npmjs.org --no-audit --no-fund`：PASS，安装 457 个包，并生成 `node_modules/.bin/tsc.cmd`。显式使用官方 registry 是为了绕过上述本机镜像未生成 launcher 的环境问题；npm 同时给出依赖弃用与 allow-scripts 提示，但未阻止后续构建或测试。
- 随后在同一全新依赖树运行 `npm run verify`：PASS（typecheck、lint、23 个单元测试文件/144 个测试、10 个集成测试文件/52 个测试、稳定版 Extension Host、校准格式门）。之后补齐 Git 历史隐私扫描契约，最终定向回归为 10 个集成测试文件/53 个测试；Extension Host 再次通过，但仍带已隔离的宿主/账户噪声，不称为 clean host output。
- `npm run package:vsix` 与 VSIX 内容检查：PASS；最新最小化产物为 18 文件、221.17 KB，检查 findings 为 0；包含 256×256 PNG、Activity Bar SVG、`LICENSE.txt`、声明/NLS/schemas/bundle，不含 `.gitignore` 或 `docs/**`。
- 上述 2026-08-20 19:58 更新已替代早期缺少 `repository` 的候选包记录；早期记录保留为历史观察，本机最终候选已包含真实 URL 且无该警告。最终发布仍须通过公开目标、匹配 origin 与 Publisher 确认门。
- 该 clean gate 关闭 Task 19 的本机自动化与打包步骤；Clean Profile 完整生命周期随后另行通过。两者都不代表官方属性推送、脚本语义、运行时或多人实测通过。

### 本机隐私扫描与公开历史边界

- 审查发现旧脚本曾忽略 `--repository` / `--history` 参数，只扫描当前工作树；该结果没有被冒充为历史扫描通过。
- 先增加失败测试，证明“秘密曾提交、随后从工作树删除”必须仍被发现；再实现对全部可达 Git blob 的历史扫描，并保留当前工作树、匿名夹具排除和零内容泄露输出规则。
- `node scripts/privacy-audit.mjs --repository . --history --json`：按已实现的密钥、绝对地图路径、原始导出文件名、日志和官方二进制规则返回 `findings: []`。后续人工复核发现本机旧开发历史仍有不适合公开的旧校准文本，因此这条 PASS 不再被解释为“整个本机开发历史适合公开”。
- 公开发布不会改写或推送本机开发历史。新增 `export-public-repository.mjs` 只从最终干净提交导出当前跟踪文件到忽略的 `work/public-release-repository`，拒绝脏源、越界/非空目标和危险跟踪路径，并初始化一个单提交 `main`；公开导出、危险 fixtures 拒绝和越界/脏源回归均已通过。真正上传前必须再对该导出树和唯一历史运行隐私审计。
- 在提交 `6956001` 后实际生成公开导出：`PUBLIC_EXPORT_READY`，146 个跟踪文件，唯一提交 `0bd5cd8 chore: publish source snapshot`；导出工作树和 Git 历史隐私审计均返回 `findings: []`，没有 `origin`，未执行 GitHub 创建或推送。由于后续文档修订会改变公开快照，真正上传前必须重新生成该目录并再次审计。
- 在文档修订提交 `fab2c3d` 后，使用新目标 `work/public-release-repository-final` 重新生成：`PUBLIC_EXPORT_READY`，146 个跟踪文件，唯一提交 `02e5113 chore: publish source snapshot`；导出工作树、历史隐私审计和非最终模式 preflight 均通过，没有 `origin`，仍未执行 GitHub 创建或推送。
- 隐私审计不再豁免整个 `test/fixtures/**`；只有播种检测字符串的 `test/integration/privacy-audit.test.ts` 单文件跳过。危险官方形状文件名、密钥和绝对地图路径即使位于 fixtures 下也会失败；属性与日志夹具改为普通匿名 `.txt` 文件名，测试运行时才在临时目录生成官方形状。

### 生产依赖安全

- `yaml` 从 2.8.1 定向升级到 2.9.0，以修复 GHSA-48c2-rrv3-qjmp；未执行 `npm audit fix --force`，未顺带升级其他直接依赖。
- 注册中心导入在调用解析器前执行 UTF-8 4 MiB 上限与 YAML 64 层流式/缩进嵌套边界；超限统一返回 `VALIDATION_FAILED`，深层/超大输入回归通过。
- 官方 registry 命令 `npm audit --omit=dev --registry=https://registry.npmjs.org --json` 返回 production vulnerabilities total = 0。

## 证据边界

以上是静态、单元、CLI 集成、Extension Host、打包和安装证据；不代表官方编辑器属性推送、多人实测或 VSCode 1.70.3 通过。
