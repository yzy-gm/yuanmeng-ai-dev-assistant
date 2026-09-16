# 构建与发布

源码采用 MIT 许可证。安装依赖使用 `npm ci`；Node.js 要求 >=20，VS Code 要求 >=1.134。

```powershell
npm ci
npm run typecheck
npm run lint
npm run package:release
```

最后一个命令在新的 `outputs/public/<时间戳>/` 生成完整源码目录、VSIX、SHA-256 和产物清单。先导出白名单文件并执行隐私扫描，再构建和检查 VSIX；不会调用 Git，不会联网上传或安装。源文件清单见 `scripts/public-release-files.mjs`，哈希清单见导出目录的 `SOURCE_MANIFEST.json`。

仅导出源码时：先创建目标父目录，再运行 `npm run export:public-repository -- --destination <尚不存在的目录>`。已有目录与符号链接会被拒绝，导出不带 `.git`、历史验收资料、账号数据、工程缓存、原始地图或本地构建产物。扫描失败的目录不是可发布产物；只有成功生成清单且命令退出码为零的目录才能使用。

`npm run preflight:public-release` 只验证公开元数据与文件清单；完整隐私和 VSIX 检查由 `package:release` 执行。`package.json` 的 `private: true` 和 npm 发布拦截仅防止误发布 npm 包；VSIX 与 MIT 源码发布不受影响。

发布时保留扩展 ID `bujianxingguang.yuanmeng-ai-dev-assistant`。使用作者的 Marketplace 发布者账户上传已检查的 VSIX，再将已检查源码提交到原 GitHub 仓库，创建同版本标签与 Release，并把 `RELEASE_NOTES.md` 用作公告。发布之后核对市场版本、公开源码许可证和下载附件。发布操作须由维护者明确授权，构建成功不代表已上线。

功能验证按需要使用 `test:integration`、`test:extension` 等脚本，记录实际执行范围。静态检查、模型、Extension Host、编辑器和多人实测分别报告；不要将构建成功描述为官方编辑器验证通过。
