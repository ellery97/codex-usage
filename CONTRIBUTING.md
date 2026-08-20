# Contributing

感谢你为 Codex Token 用量统计工具贡献代码、文档或问题反馈。

## 开发环境

- Node.js 22 或更高版本。
- 项目不依赖第三方 npm 运行时包。
- 不要把个人 Codex 会话日志、SQLite 索引、提示词或其他敏感数据复制到仓库。

## 本地验证

```bash
npm ci
npm test
node --check bin/codex-token-usage.mjs
node --check bin/codex-usage-server.mjs
node --check bin/openai-pricing.mjs
node --check public/app.js
git diff --check
```

如果修改了价格规则，还要补充或更新 `test/openai-pricing.test.mjs` 中的边界测试。

## 提交与 Pull Request

1. 从 `main` 创建主题分支，例如 `feat/...`、`fix/...` 或 `docs/...`。
2. 每个提交只解决一个清晰的问题，提交信息使用简短的祈使句。
3. Pull Request 说明背景、改动范围、验证命令和可能的兼容性影响。
4. 不要提交生成文件、本地数据库、会话日志、凭据或未经授权的第三方内容。
5. 等待 CI 通过并处理审查意见后再合并。
