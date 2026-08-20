# Changelog

本文件记录项目的重要变更。

## [Unreleased]

- 使用按生效时间版本化的价格目录，历史事件不再统一套用最新价格。
- Web 与 CLI 启动时从官方模型 Markdown 页面校验价格，并支持安全的本地缓存回退。
- 将 `codex-auto-review` 与官方金额分离，按时期展示明确标注的参考路由。

## [0.1.0] - 2026-08-20

- 提供 Codex Token 用量 CLI 和本地 Web 仪表盘。
- 支持按时间、模型、工作目录和会话聚合统计。
- 支持 OpenAI API 标准价格的金额估算及 GPT-5.6 价格规则。
- 支持 WSL/Linux、Windows 当前会话和 Windows 归档会话目录。
- 增加 CI、Dependabot、Issue/PR 模板和安全维护文档。
