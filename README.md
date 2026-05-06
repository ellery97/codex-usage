# Codex Usage

本目录提供一个本地 Codex token 使用量统计工具。它默认读取
`~/.codex/sessions/**/rollout-*.jsonl` 中的 `event_msg.token_count` 事件，
按月、按天、按模型、按工作目录或按会话聚合 token 用量。

## 使用

```bash
node ./bin/codex-token-usage.mjs
```

本地可视化页面：

```bash
npm run web
```

启动后打开 `http://127.0.0.1:8787`。页面会调用本项目的 CLI 读取本地
`~/.codex/sessions` 并展示总量、输入、缓存输入、输出、推理输出、缓存命中率、
扫描状态、趋势图和明细表。

Web 服务会维护一个 SQLite 持久索引，默认路径是 `.codex-usage/cache.sqlite`。首次打开
需要完整扫描历史 JSONL 并写入索引；之后切换范围、分组、排序或刷新时，会先按文件
`size/mtime` 做快速检查，只重扫新增或变化过的会话文件，再用 SQL 聚合结果。重启
`npm run web` 后索引仍会复用，不需要重新完整扫描。

可选环境变量：

- `CODEX_USAGE_DB`: 指定 SQLite 索引文件路径。
- `CODEX_USAGE_SCAN_CHECK_TTL_MS`: 文件变更检查 TTL，默认 `1000`。
- `CODEX_USAGE_SCAN_CONCURRENCY`: 首次建索引或重扫文件的并发数，默认 `8`。
- `CODEX_USAGE_GC=0`: 关闭 Web 服务中的显式 GC。

常用示例：

```bash
# 按天统计 2026-04-01 到 2026-04-30
node ./bin/codex-token-usage.mjs --from 2026-04-01 --to 2026-04-30 --group day

# 找出 token 消耗最高的 20 个工作目录
node ./bin/codex-token-usage.mjs --group cwd --sort total --desc --limit 20

# 统计最近 7 天，输出 JSON
node ./bin/codex-token-usage.mjs --last 7d --group day --json

# 输出 CSV，方便导入表格
node ./bin/codex-token-usage.mjs --group month --csv > codex_usage.csv

# 如果需要按单个 JSONL 文件原始口径统计，关闭跨文件去重
node ./bin/codex-token-usage.mjs --dedupe-scope file
```

也可以通过 npm script 运行：

```bash
npm run usage
npm run web
npm run smoke
```

## 字段说明

- `input_tokens`: 输入 token。它包含 `cached_input_tokens`。
- `cached_input_tokens`: 输入 token 中命中缓存的部分。
- `uncached_input_tokens`: `input_tokens - cached_input_tokens`。
- `output_tokens`: 输出 token。它包含 `reasoning_output_tokens`。
- `reasoning_output_tokens`: 输出 token 中用于推理的部分。
- `total_tokens`: Codex 记录的总 token，通常等于 `input_tokens + output_tokens`。

注意：`cached_input_tokens` 和 `reasoning_output_tokens` 是子集字段，不要再叠加到
`total_tokens` 上。

## 统计口径

工具逐行读取本地 JSONL 会话文件，只聚合 token 事件，不输出会话正文。Codex 有时会在
同一会话里重复写入相同的累计 `token_count`，工具会按累计 token 向量去重，避免重复计算。

默认 `--dedupe-scope global` 会进一步跨文件去重。这个口径主要是为了处理旧版 Codex
把历史 rollout 内容嵌入后续 rollout 文件的情况，避免历史 token 被重复累加。如果你想看
每个 JSONL 文件自身记录的原始合计，可以使用 `--dedupe-scope file`。

时间范围过滤基于 token 事件的时间戳：

- `--from` / `--since`: 包含该时间点之后的事件。
- `--to` / `--until`: 如果传入 `YYYY-MM-DD`，包含这一天整天。
- `--last`: 支持 `24h`、`7d`、`4w` 这样的写法。

分组可选值：

- `month`: 按月，默认。
- `day`: 按天。
- `model`: 按模型。
- `cwd`: 按工作目录。
- `session`: 按会话。
- `none`: 只输出总计。
