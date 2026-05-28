# Codex Token 用量统计

一个本地 Codex token 用量统计工具。它读取本机 Codex 会话目录中的 JSONL 日志，
统计输入、缓存输入、输出、推理输出、总 token、请求数、会话数、缓存命中率和预估金额，并提供
命令行输出和本地 Web 仪表盘两种使用方式。

默认数据来源是：

```text
~/.codex/sessions/**/*.jsonl
/mnt/c/Users/<WindowsUsername>/.codex/sessions/**/*.jsonl  # 目录存在时自动加入
```

工具只读取 `event_msg.token_count`、`turn_context` 和 `session_meta` 相关记录，用于还原
token 用量、模型、工作目录和会话信息，不输出会话正文。

## 功能

- 按月、按天、按模型、按工作目录、按会话聚合 token 用量。
- 支持全部时间、最近一段时间、今天、自定义起止日期统计。
- 支持文本、JSON、CSV 三种命令行输出。
- 提供本地 Web 页面，展示汇总卡片、Token 用量趋势、Token 构成、扫描状态和明细表。
- Web 服务使用 SQLite 持久索引，首次扫描后复用索引，只增量重扫新增或变更过的会话文件。
- 按 OpenAI API 官方标准 token 价格估算美元消耗，并支持按金额排序。
- 在 WSL 环境下默认自动合并 Windows 侧 Codex 会话目录 `/mnt/c/Users/<WindowsUsername>/.codex/sessions`。
- 默认启用全局去重，减少旧会话内容被复制进后续 rollout 文件后造成的重复计数。

## 环境要求

- Node.js，需要支持内置 `node:sqlite` 的版本。当前项目已在 `v22.22.0` 下验证。
- 不需要安装第三方 npm 依赖，项目只使用 Node.js 标准库。
- 本机需要存在 Codex 会话日志目录，默认是 `~/.codex/sessions`；如果 Windows 侧目录存在，也会自动加入。

如果启动 Web 服务时报 `No such built-in module: node:sqlite`，请升级 Node.js。

## 快速开始

查看命令行统计：

```bash
npm run usage
```

启动本地 Web 仪表盘：

```bash
npm run web
```

启动后打开：

```text
http://127.0.0.1:8787
```

运行 smoke 检查：

```bash
npm run smoke
```

## Web 仪表盘

Web 服务入口是：

```bash
node --no-warnings --expose-gc ./bin/codex-usage-server.mjs
```

对应 npm script：

```bash
npm run web
```

页面会请求 `/api/usage`，由后端从 SQLite 索引中聚合数据。默认索引文件是：

```text
.codex-usage/cache.sqlite
```

首次打开页面时会完整扫描历史 JSONL 文件并写入索引；之后刷新或切换范围、分组、排序时，
服务会根据文件 `size` 和 `mtime` 判断哪些文件发生变化，只重扫变化文件。
页面上的“数据源”筛选可以在全部目录、WSL/Linux、Windows 三种口径间切换。

`.codex-usage/` 已写入 `.gitignore`，不会提交到 Git。

## CLI 用法

直接运行：

```bash
node ./bin/codex-token-usage.mjs [options]
```

常用示例：

```bash
# 按月统计全部时间，输出文本表格
node ./bin/codex-token-usage.mjs

# 按天统计 2026-04-01 到 2026-04-30
node ./bin/codex-token-usage.mjs --from 2026-04-01 --to 2026-04-30 --group day

# 统计最近 7 天，输出 JSON
node ./bin/codex-token-usage.mjs --last 7d --group day --json

# 找出 token 消耗最高的 20 个工作目录
node ./bin/codex-token-usage.mjs --group cwd --sort total --desc --limit 20

# 按官方 API 标准价估算模型消耗金额
node ./bin/codex-token-usage.mjs --group model --sort cost --desc --limit 20

# 只统计 Windows 侧 Codex 会话
node ./bin/codex-token-usage.mjs --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions

# 显式合并多个会话目录
node ./bin/codex-token-usage.mjs --sessions ~/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions

# 输出 CSV，方便导入表格
node ./bin/codex-token-usage.mjs --group month --csv > codex_usage.csv

# 查看每个 JSONL 文件自身记录的原始口径，关闭跨文件去重
node ./bin/codex-token-usage.mjs --dedupe-scope file
```

可用参数：

| 参数 | 说明 |
| --- | --- |
| `--codex-home PATH` | Codex home 目录，默认 `$CODEX_HOME` 或 `~/.codex` |
| `--sessions PATH` | 会话目录，可重复传入；显式传入后不会自动追加默认目录 |
| `--from`, `--since DATE` | 只包含该时间点之后的 token 事件 |
| `--to`, `--until DATE` | 只包含该时间点之前的 token 事件；传 `YYYY-MM-DD` 时包含整天 |
| `--last DURATION` | 最近一段时间，例如 `24h`、`7d`、`4w` |
| `--today` | 从本地当天 0 点开始统计 |
| `--group VALUE` | 分组方式：`none`、`day`、`month`、`model`、`cwd`、`session` |
| `--sort VALUE` | 排序字段：`key`、`total`、`input`、`output`、`cached`、`reasoning`、`requests`、`sessions`、`cost` |
| `--asc`, `--desc` | 排序方向；日期分组默认升序，其它分组默认降序 |
| `--limit N` | 限制输出行数；`0` 表示不限制 |
| `--dedupe-scope VALUE` | 去重范围：`global` 或 `file`，默认 `global` |
| `--timezone`, `--tz TZ` | 日期分组使用的时区，默认本机时区 |
| `--json` | 输出 JSON |
| `--csv` | 输出 CSV |
| `-h`, `--help` | 查看帮助 |

## 统计口径

Codex 会话文件里可能存在两类容易导致重复计数的情况：

1. 同一个 JSONL 文件里重复写入相同累计值的 `token_count`。
2. 较新的 rollout 文件中嵌入较早历史 rollout 的 token 事件。

工具会先在单个文件内按累计 token 向量去重。默认 `--dedupe-scope global` 还会跨文件按
累计 token 向量去重，避免历史事件被复制后重复累加。

如果你希望查看每个 JSONL 文件自己的原始记录口径，可以使用：

```bash
node ./bin/codex-token-usage.mjs --dedupe-scope file
```

注意：全局去重会优先保留第一次出现的累计 token 事件，然后再做时间范围过滤。这个口径更适合
看长期真实总量；如果你正在排查某个文件内部的原始日志，应改用 `file` 去重。

## 字段说明

| 字段 | 含义 |
| --- | --- |
| `input_tokens` | 输入 token，包含缓存命中的输入 token |
| `cached_input_tokens` | 输入 token 中命中缓存的部分 |
| `uncached_input_tokens` | 未缓存输入，等于 `input_tokens - cached_input_tokens` |
| `output_tokens` | 输出 token，包含推理输出 token |
| `reasoning_output_tokens` | 输出 token 中用于推理的部分 |
| `total_tokens` | Codex 记录的总 token，通常等于 `input_tokens + output_tokens` |
| `cache_hit_ratio` | 缓存命中率，等于 `cached_input_tokens / input_tokens` |
| `estimated_cost_usd` | 按本地价格快照估算的美元金额 |
| `priced_requests` | 已匹配到价格表的请求数 |
| `unpriced_requests` | 未匹配到价格表的请求数 |
| `unpriced_total_tokens` | 未计入金额的 token 数 |
| `requests` | token 事件数量，可近似理解为记录到 token 用量的请求数 |
| `sessions` | 参与统计的 Codex 会话数 |

`cached_input_tokens` 和 `reasoning_output_tokens` 是子集字段，不要再叠加到 `total_tokens` 上。

## 金额估算口径

金额估算使用 `bin/openai-pricing.mjs` 中的本地价格快照，当前快照时间为 `2026-05-14`，
口径是 OpenAI API 标准 text token 价格，不包含 Batch 折扣、Flex/Priority 差异、区域加价、
订阅权益、税费或账户级优惠。

估算公式：

```text
estimated_cost_usd =
  (未缓存输入 token * input 单价
   + 缓存输入 token * cached input 单价
   + 输出 token * output 单价) / 1,000,000
```

`input_tokens` 已包含缓存输入，因此会先扣除 `cached_input_tokens` 再按普通输入计价。
`output_tokens` 已包含 `reasoning_output_tokens`，所以推理输出不会重复计价。

如果某个模型没有出现在价格快照中，对应请求会计入 `unpriced_requests` 和
`unpriced_total_tokens`，金额按 `0` 处理，前端会提示有未计价 token。

价格来源主要参考：

- <https://openai.com/api/pricing/>
- <https://developers.openai.com/api/docs/models/gpt-5.5>
- <https://developers.openai.com/api/docs/models/gpt-5.4>
- <https://developers.openai.com/api/docs/models/gpt-5.4-mini>
- <https://developers.openai.com/api/docs/models/gpt-5.3-codex>
- <https://developers.openai.com/api/docs/models/gpt-5.2-codex>
- <https://developers.openai.com/api/docs/models/gpt-5-codex>
- <https://developers.openai.com/api/docs/models/gpt-5.1>
- <https://developers.openai.com/api/docs/models/gpt-5.1-codex>
- <https://developers.openai.com/api/docs/models/gpt-5.1-codex-max>
- <https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini>
- <https://developers.openai.com/api/docs/models/gpt-4o>
- <https://developers.openai.com/api/docs/models/gpt-4o-mini>

## Web 环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | Web 服务端口，优先级高于 `CODEX_USAGE_PORT` |
| `CODEX_USAGE_PORT` | `8787` | Web 服务端口 |
| `HOST` | `127.0.0.1` | Web 服务监听地址 |
| `CODEX_USAGE_DB` | `.codex-usage/cache.sqlite` | SQLite 索引文件路径 |
| `CODEX_USAGE_SCAN_CHECK_TTL_MS` | `1000` | 文件变更检查 TTL，单位毫秒 |
| `CODEX_USAGE_SCAN_CONCURRENCY` | `8` | 重扫会话文件的并发数，范围会限制在 `1` 到 `32` |
| `CODEX_USAGE_GC` | 非 `0` | 设为 `0` 可关闭 Web 服务中的显式 GC |
| `CODEX_HOME` | `~/.codex` | Codex home 目录，影响默认 sessions 路径 |
| `CODEX_USAGE_SESSIONS` | 空 | 用 `:` 分隔的多个会话目录；设置后覆盖默认自动发现 |

示例：

```bash
CODEX_USAGE_PORT=8788 CODEX_USAGE_DB=/tmp/codex-usage.sqlite npm run web
```

显式指定多个数据源：

```bash
CODEX_USAGE_SESSIONS="$HOME/.codex/sessions:/mnt/c/Users/<WindowsUsername>/.codex/sessions" npm run web
```

## API

Web 服务提供一个 JSON 接口：

```text
GET /api/usage
```

常用查询参数：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| `range` | `all`、`today`、`24h`、`7d`、`30d`、`12w`、`custom` | 时间范围 |
| `sourceScope` | `all`、`local`、`windows` | 数据源范围 |
| `from` | `2026-04-01` | `range=custom` 时的开始日期 |
| `to` | `2026-04-30` | `range=custom` 时的结束日期 |
| `group` | `day` | 分组方式 |
| `sort` | `total` | 排序字段 |
| `asc` / `desc` | `1` | 排序方向 |
| `limit` | `60` | 输出行数 |
| `dedupeScope` | `global` | 去重范围 |

示例：

```text
http://127.0.0.1:8787/api/usage?range=30d&group=day&sort=key&desc=1&limit=60&dedupeScope=global
```

## 项目结构

```text
.
├── bin/
│   ├── codex-token-usage.mjs      # CLI 扫描与聚合逻辑
│   ├── codex-usage-server.mjs     # 本地 Web 服务与 SQLite 索引
│   └── openai-pricing.mjs         # OpenAI API token 价格快照和金额估算
├── public/
│   ├── index.html                 # 仪表盘页面
│   ├── app.js                     # 前端交互、图表和表格渲染
│   └── styles.css                 # 页面样式
├── package.json
└── README.md
```

## 常见问题

### 首次打开 Web 页面为什么比较慢？

首次启动需要完整扫描 `~/.codex/sessions` 下的历史 JSONL 文件，并写入 SQLite 索引。完成后，
后续刷新会复用索引，只重扫新增或修改过的文件。

### 会不会把会话内容上传出去？

不会。这个工具只在本机读取本地 JSONL 文件，Web 服务也只监听本地地址 `127.0.0.1`。
代码中没有外部网络上传逻辑。

### 为什么同一时间范围下 `global` 和 `file` 统计结果不同？

`global` 会跨文件去重，适合看长期真实消耗；`file` 只在单个文件内去重，适合排查某个
JSONL 文件的原始记录。旧版 Codex 可能把历史 rollout 内容复制进新文件，因此 `file`
口径通常会更接近“文件记录量”，但可能高估真实 token 消耗。

### 为什么 Web 和 CLI 的速度不同？

CLI 每次运行都会直接扫描 JSONL 文件。Web 服务会维护 SQLite 持久索引，首次扫描后主要通过
SQL 聚合，所以切换筛选条件和刷新通常更快。

## 开发验证

语法检查：

```bash
node --check bin/codex-token-usage.mjs
node --check bin/codex-usage-server.mjs
node --check bin/openai-pricing.mjs
node --check public/app.js
```

功能 smoke：

```bash
npm run smoke
node ./bin/codex-token-usage.mjs --group month --limit 1
node ./bin/codex-token-usage.mjs --group month --limit 1 --csv
```
