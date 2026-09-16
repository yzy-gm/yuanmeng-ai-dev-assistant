# 元梦 AI 开发助手 0.6.0：全部功能 MIT 开源

感谢使用元梦 AI 开发助手。本次将原私有版本的全部插件功能公开，源码采用 MIT 许可证，允许使用、修改和再分发，保留版权与许可声明即可。

## 本次开放的功能

- UI 自动索引、控件查询、ID 台账、引用查找与布局检查。
- 本地场景数据只读索引、元件与编组查询、变更对比、空间计划及运行时探针。
- Lua 与官方 API 审查、官方安装数据兼容检查及模板差异比较。
- VS Code、CLI 和本机 MCP 三条入口；完整 MCP 档提供 42 个工具，默认工作流档只展示日常常用工具，可在设置中切换。
- 代码交付桥、可预览和撤销的修改流程、项目隔离、本地反馈与匿名诊断。
- AI 玩法自动建模和有界模拟，支持重复事件、重连、2/4/8 人竞争场景；模型结果不能替代官方编辑器与真实多人测试。

本次发布保留 47 个命令、11 个视图和 19 项设置，无另行保留的付费或私有功能档。官方软件与用户地图仍归各自权利人所有，不随源码发布。

## 已安装用户如何更新

扩展 ID 仍为 `bujianxingguang.yuanmeng-ai-dev-assistant`，从原公开版本 0.1.0 更新即可，无需安装另一款扩展。

需要 **VS Code 1.134 或更新版本**。市场安装且启用自动更新的用户可沿用市场更新渠道；手动更新可在扩展面板打开本扩展并检查更新。使用 VSIX 安装的用户请主动下载并安装新版。独立 CLI/MCP 需要系统 Node.js 20 或更新版本。

新版成功启动后显示一次本地公告。此提示不联网，不收集安装者信息；未更新的旧版不会收到新加入的弹窗。关闭通知或扩展的用户可能看不到提示。

地图代码、场景数据、日志和 `.yuanmeng-inspector/` 继续保存在你的本机工程。开源和更新都不代表这些数据会被上传。

- [安装与更新](https://marketplace.visualstudio.com/items?itemName=bujianxingguang.yuanmeng-ai-dev-assistant)
- [源码与使用文档](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant)
- [版本发布页](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/releases)
- [报告问题](https://github.com/yzy-gm/yuanmeng-ai-dev-assistant/issues)

本项目为第三方工具，并非腾讯或《元梦之星》官方产品。
