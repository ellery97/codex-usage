# Codex Token 用量统计

[![CI](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English version](README.en.md)

一个本地 Codex token 用量统计工具。它读取本机 Codex 会话目录中的 JSONL 日志，
统计输入、缓存读写、输出、推理输出、总 token、请求数、会话数、缓存命中率和参考金额，并提供
命令行输出和本地 Web 仪表盘两种使用方式。

默认会按运行环境发现可访问的数据源；“全部目录”会合并 WSL/Linux 与 Windows 两侧：

```text
# WSL/Linux 侧（在 WSL 中使用本地路径，在 Windows 中使用 \\wsl.localhost 或 \\wsl$ UNC 路径）
~/.codex/sessions/**/*.jsonl
~/.codex/archived_sessions/**/*.jsonl

# Windows 侧（在 WSL/Linux 中使用 /mnt/c，在 Windows 中使用 C:\Users）
/mnt/c/Users/*/.codex/sessions/**/*.jsonl
/mnt/c/Users/*/.codex/archived_sessions/**/*.jsonl
```

不存在或无法访问的目录会被忽略，不会把 `/mnt/c/...` 在原生 Windows 中错误转换为
`E:\mnt\c\...`。原生 Windows 会枚举已安装且可访问的 WSL 发行版及其 `/home/*` 用户目录；
WSL/Linux 会检查可访问的 Windows 用户目录。

工具只读取 `event_msg.token_count`、`event_msg.thread_settings_applied`、`turn_context` 和
`session_meta` 相关记录，用于还原 token 用量、模型、工作目录和会话信息，不输出会话正文。
启动时仅会访问固定的 OpenAI 官方模型文档地址校验公开价格，不会上传会话内容。

## 功能

- 按月、按天、按模型、按工作目录、按会话聚合 token 用量。
- 支持全部时间、最近一段时间、今天、自定义起止日期统计。
- 支持文本、JSON、CSV 三种命令行输出。
- 提供本地 Web 页面，展示汇总卡片、Token 用量趋势、Token 构成、索引刷新状态和明细表。
- Web 服务使用 SQLite 持久索引；普通追加只读取新增字节，文件被替换或改写时才回退为完整重扫。
- 全局去重代表事件按数据源范围持久化，筛选变化复用已计价切片和进程内查询缓存。
- 按事件发生时间选择 OpenAI API Standard 价格版本，并区分官方金额、假设金额和未计价模型。
- 真正缺失时间戳的事件在全量统计中仍会保留并计为未计价；带时间边界的查询会显式报告被排除数量。
- 默认自动发现并合并 WSL/Linux 与 Windows 两侧的当前会话和归档会话目录。
- 默认启用全局去重，减少旧会话内容被复制进后续 rollout 文件后造成的重复计数。

## 环境要求

- Node.js，需要支持内置 `node:sqlite` 的版本。当前项目已在 `v22.22.0` 下验证。
- 不需要安装第三方 npm 依赖，项目只使用 Node.js 标准库。
- 本机需要存在至少一个可访问的 Codex 会话日志目录。WSL/Linux 默认从 `~/.codex` 开始，
  原生 Windows 默认扫描 `C:\Users\*\.codex`，并在可用时互相发现另一侧环境。

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

也可以在启动时指定端口：

```bash
npm run web -- --port 8899
# 或
npm run web -- -p 8899
```

启动后请打开服务启动日志打印的实际 URL。默认端口可用时为：

```text
http://127.0.0.1:8787
```

运行 smoke 检查：

```bash
npm run smoke
```

手动刷新运行时价格目录：

```bash
npm run update-pricing
```

## macOS 使用

本项目支持在 macOS 上直接运行。在项目根目录执行：

```bash
npm run usage
npm run web
```

然后打开：

```text
http://127.0.0.1:8787
```

使用说明：

- 需要安装 Node.js 22 或更高版本；项目已在 `v22.22.0` 下验证。
- 项目没有第三方 npm 依赖，正常情况下不需要执行 `npm install`。
- macOS 默认读取 `~/.codex/sessions`。如果日志位于其他目录，可以使用
  `CODEX_HOME=/path/to/.codex npm run usage`，或通过 `--sessions` 显式指定目录。
- 工具不需要 OpenAI API Key，也不会上传会话数据；启动时只下载固定的官方模型 Markdown 页面校验价格。

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

Web 服务会在监听端口前同步一次默认数据源、读取日志中实际出现的模型、刷新价格目录，并预热
常用去重范围和默认 Dashboard 查询。没有索引时会完整扫描历史 JSONL；之后每个文件会保存读取偏移、
解析上下文、inode 和边界哈希。安全追加只读取新增字节；截断、替换、同尺寸改写、边界哈希或扫描器
版本不匹配时才完整重扫该文件。不完整的末尾 JSON 行会留到下次追加后处理。

页面首次加载和筛选变化只查询当前 SQLite 快照，不访问 JSONL 文件。数据源、范围、分组、排序、方向
和去重条件会自动应用，行数与自定义日期使用 200ms 防抖。服务启动后产生的新日志不会自动进入统计；
点击“刷新索引”后才会检查文件、读取新增字节并清空查询缓存。

Web 的 `24h`、`7d`、`30d` 和 `12w` 范围按当前时间的分钟桶滚动：同一分钟内可复用查询缓存，跨分钟
会生成新的实际边界。`today` 按目标 IANA 时区的日期计算当天 0 点，并在该时区跨日时立即切换。

全局去重结果按规范化的数据源目录组合持久化，文件变化后只修复受影响的事件 key，最多保留
8 个最近使用的范围。旧索引会原地迁移；如果索引中的扫描器版本已过期，升级后的首次索引刷新会逐文件
完整重读现有 JSONL，以恢复 cache-write、事件指纹、累计 Token key 后缀和可恢复解析状态。每个文件转换成功后
立即提交，后续启动不会重复处理；全部转换完成后，普通追加恢复为增量读取。
页面上的“数据源”筛选可以在全部目录、WSL/Linux、Windows 三种口径间切换；WSL/Linux 和 Windows
口径都包含对应环境可访问的当前会话与归档会话。API 仍兼容 `sourceScope=local`，它表示运行时本地
的当前会话目录。

`.codex-usage/` 已写入 `.gitignore`，不会提交到 Git。
运行时价格目录默认保存在同一目录的 `pricing-history.json`。

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

# 按事件时点 Standard API 参考金额排序模型
node ./bin/codex-token-usage.mjs --group model --sort cost --desc --limit 20

# 只统计 Windows 侧 Codex 当前会话
node ./bin/codex-token-usage.mjs --sessions /mnt/c/Users/<Windows用户名>/.codex/sessions

# 显式统计 Windows 侧当前会话和归档会话
node ./bin/codex-token-usage.mjs --sessions /mnt/c/Users/<Windows用户名>/.codex/sessions --sessions /mnt/c/Users/<Windows用户名>/.codex/archived_sessions

# 显式合并多个会话目录
node ./bin/codex-token-usage.mjs --sessions ~/.codex/sessions --sessions /mnt/c/Users/<Windows用户名>/.codex/sessions --sessions /mnt/c/Users/<Windows用户名>/.codex/archived_sessions

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
| `--today` | 从 `--timezone` 指定时区的当天 0 点开始统计 |
| `--group VALUE` | 分组方式：`none`、`day`、`month`、`model`、`cwd`、`session` |
| `--sort VALUE` | 排序字段：`key`、`total`、`input`、`output`、`cached`、`reasoning`、`requests`、`sessions`、`cost` |
| `--asc`, `--desc` | 排序方向；日期分组默认升序，其它分组默认降序 |
| `--limit N` | 限制输出行数；`0` 表示不限制 |
| `--dedupe-scope VALUE` | 去重范围：`global` 或 `file`，默认 `global` |
| `--timezone`, `--tz TZ` | 日期分组和 `--today` 使用的时区，默认本机时区 |
| `--use-cache` | 使用与 Web 共用的 SQLite 增量索引；默认 CLI 仍为无状态完整扫描 |
| `--cache-db PATH` | 指定 SQLite 索引路径，并隐含启用 `--use-cache` |
| `--json` | 输出 JSON |
| `--csv` | 输出 CSV |
| `--no-refresh-pricing` | 不联网刷新价格，使用最近一次已验证的本地目录 |
| `-h`, `--help` | 查看帮助 |

## 统计口径

Codex 会话文件里可能存在两类容易导致重复计数的情况：

1. 同一个 JSONL 文件里重复写入相同累计值的 `token_count`。
2. 较新的 rollout 文件中嵌入较早历史 rollout 的 token 事件。

工具会先在单个文件内按累计 token 向量去重。默认 `--dedupe-scope global` 会进一步使用
“事件时间戳 + 六字段累计 Token + 本次增量 Token”的事件指纹跨文件去重；当事件时间戳确实缺失时，
指纹会额外包含会话/目录/模型回退身份，避免无关会话错误碰撞。

Direct Scan 与 SQLite 使用同一套确定性 canonical 规则：按完整文件路径的二进制顺序，其次按文件内事件顺序
选择代表事件。因此同一批数据无论 `--sessions` 参数的传入顺序如何，模型、cwd、session 和金额归属都保持一致。

如果你希望查看每个 JSONL 文件自己的原始记录口径，可以使用：

```bash
node ./bin/codex-token-usage.mjs --dedupe-scope file
```

全局去重会先确定 canonical 代表事件，再做时间范围过滤。这个口径更适合看长期真实总量；如果你正在排查
某个文件内部的原始日志，应改用 `file` 去重。

真正无法恢复时间戳的事件不会在全量统计中静默丢失：`range=all` / 无 `from`、`to` 时仍计入请求与 Token，
金额按未计价处理；按天/月分组时进入 `(unknown time)`。一旦查询带有时间边界，因为无法判断这些事件是否位于
区间内，它们会被排除，并通过 `stats.excludedUnknownTimestampEvents` 和
`stats.excludedUnknownTimestampTokens` 明确报告。

## 字段说明

| 字段 | 含义 |
| --- | --- |
| `input_tokens` | 输入 token，包含缓存命中的输入 token |
| `cached_input_tokens` | 输入 token 中命中缓存的部分 |
| `cache_write_input_tokens` | 输入 token 中用于写入缓存的部分 |
| `uncached_input_tokens` | 普通输入，等于 `input_tokens - cached_input_tokens - cache_write_input_tokens` |
| `output_tokens` | 输出 token，包含推理输出 token |
| `reasoning_output_tokens` | 输出 token 中用于推理的部分 |
| `total_tokens` | Codex 记录的总 token，通常等于 `input_tokens + output_tokens` |
| `cache_hit_ratio` | 缓存命中率，等于 `cached_input_tokens / input_tokens` |
| `estimated_cost_usd` | 仅包含有公开价格模型的事件时点美元估算 |
| `assumed_cost_usd` | 明确标注的假设计价基线 |
| `assumed_upper_bound_cost_usd` | 假设计价上界 |
| `reference_total_cost_usd` | 官方金额加假设基线 |
| `reference_total_upper_bound_cost_usd` | 官方金额加假设上界 |
| `priced_requests` | 已匹配到价格表的请求数 |
| `assumed_requests` | 使用明确假设路由的请求数 |
| `assumed_total_tokens` | 使用明确假设路由的 token 数 |
| `unpriced_requests` | 既无官方价格也无假设路由的请求数 |
| `unpriced_total_tokens` | 既无官方价格也无假设路由的 token 数 |
| `provisional_priced_requests` | 使用 provisional 官方价格的请求数 |
| `provisional_priced_total_tokens` | 使用 provisional 官方价格的 token 数 |
| `provisional_estimated_cost_usd` | 官方金额中来自 provisional 版本的部分 |
| `requests` | token 事件数量，可近似理解为记录到 token 用量的请求数 |
| `sessions` | 参与统计的 Codex 会话数 |

`cached_input_tokens`、`cache_write_input_tokens` 和 `reasoning_output_tokens` 是子集字段，不要再叠加到 `total_tokens` 上。

## 金额估算口径

金额来自版本化价格目录，口径是 OpenAI API Standard 文本 Token 价格。每条有时间戳的事件按自身 UTC 时间选择不晚于它的最新有效版本；恰好位于价格边界时使用新版本。真正没有时间戳的事件无法安全选择历史价格版本，因此会保留在 Token 统计中但标记为未计价。没有权威生效日的旧价格作为 `provisional` 历史基线，不会冒充正式变价日期。

内置历史位于 `pricing/openai-pricing.snapshot.json`，运行时校验结果写入数据库旁的 `.codex-usage/pricing-history.json`。Web 在监听端口前刷新；CLI 在聚合和输出前刷新，`--help` 不联网。刷新最多并发 6 个请求且受 8 秒总超时限制，并复用 `ETag` / `Last-Modified`。部分页面失败时，成功模型仍会更新，失败模型继续使用最近一次已验证版本；完全离线时也会回退本地目录。

缓存更新使用锁文件、同目录临时文件和原子 rename。损坏的运行时缓存会先改名保留为 `.corrupt-<timestamp>`，再回退内置目录；内置目录自身无效时会明确拒绝启动。

```text
官方金额 =
  (普通输入 × input 单价
   + 缓存命中 × cached input 单价
   + 缓存写入 × cache write 单价
   + 输出 × output 单价) / 1,000,000

参考金额基线 = 官方金额 + 假设金额基线
参考金额上界 = 官方金额 + 假设金额上界
```

这些数字只是事件发生时的 Standard API 等价参考，不是 ChatGPT 订阅账单、Codex credits 或实际扣费；也不包含 Batch、Flex、Fast、区域加价、税费和账户折扣。

`codex-auto-review` 没有独立公开价格，因此始终不进入 `estimated_cost_usd`。参考路由按时期展示：2026-04-23 起使用 GPT-5.4 Thinking（low reasoning）基线，2026-07-30 起使用较低证据等级的 GPT-5.6 Luna 基线；两段都以 GPT-5.6 Sol 为上界。跨时期查询会在 `assumedModels[].routes` 中分别列出请求、Token 和金额。

刷新运行时目录，或只检查差异：

```bash
npm run update-pricing
npm run update-pricing -- --check
```

人工核验出明确生效日后，可将正式版本写入内置历史：

```bash
npm run update-pricing -- \
  --seed \
  --model gpt-5.6-terra \
  --effective-from 2026-07-30 \
  --source-url https://openai.com/index/gpt-5-6/
```

更新器与启动刷新共享同一个解析器：只读取模型页中的 `Pricing / Text tokens`，并要求页面 `Model ID` 与请求模型完全一致。正式版本会保留被替代的 first-observed provisional 记录用于审计，但选择器会忽略已 superseded 的版本。

价格依据：

- `https://developers.openai.com/api/docs/models/<model>.md`
- <https://openai.com/index/gpt-5-6/>
- <https://alignment.openai.com/auto-review/>

## Web 环境变量

端口优先级为命令行 `--port`/`-p`、`PORT`、`CODEX_USAGE_PORT`，最后是默认端口 `8787`。
显式指定的端口不可用时会直接报错，避免脚本或反向代理静默连接到其他端口。未显式指定端口时，
如果 `8787` 因占用或系统保留而无法监听，服务会依次尝试 `9787`、`3000`、`5000`，最后请求
操作系统分配一个临时端口，并在控制台打印实际访问地址。端口值必须是 `0` 到 `65535` 的整数；
`0` 表示请求操作系统分配临时端口。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | Web 服务端口，优先级高于 `CODEX_USAGE_PORT` |
| `CODEX_USAGE_PORT` | `8787` | Web 服务端口 |
| `HOST` | `127.0.0.1` | Web 服务监听地址；服务没有认证，不建议绑定到 `0.0.0.0` 或暴露到不受信任的网络 |
| `CODEX_USAGE_DB` | `.codex-usage/cache.sqlite` | SQLite 索引文件路径 |
| `CODEX_USAGE_PRICING_CACHE` | 数据库旁的 `pricing-history.json` | 运行时版本化价格目录 |
| `CODEX_USAGE_PRICING_TIMEOUT_MS` | `8000` | 启动价格刷新总超时，单位毫秒 |
| `CODEX_USAGE_PRICING_REFRESH` | 非 `0` | 设为 `0` 可关闭启动价格刷新 |
| `CODEX_USAGE_SCAN_CHECK_TTL_MS` | `1000` | 文件变更检查 TTL，单位毫秒 |
| `CODEX_USAGE_SCAN_CONCURRENCY` | `8` | 重扫会话文件的并发数，范围会限制在 `1` 到 `32` |
| `CODEX_USAGE_GC` | 非 `0` | 设为 `0` 可关闭 Web 服务中的显式 GC |
| `CODEX_HOME` | `~/.codex` | Codex home 目录，影响默认 sessions 路径 |
| `CODEX_USAGE_SESSIONS` | 空 | 用平台路径分隔符分隔的多个会话目录（Windows 为 `;`，WSL/Linux 为 `:`）；设置后覆盖 `all` 的默认自动发现 |
| `CODEX_USAGE_WINDOWS_ROOT` | 自动推断 | Windows 用户根目录；原生 Windows 默认从 `USERPROFILE` 推断，WSL/Linux 默认 `/mnt/c/Users` |
| `CODEX_USAGE_WSL_DISTROS` | 自动枚举 | 原生 Windows 上要检查的 WSL 发行版，使用 `;` 分隔；未设置时调用 `wsl.exe -l -q` |

示例：

```bash
CODEX_USAGE_PORT=8788 CODEX_USAGE_DB=/tmp/codex-usage.sqlite npm run web
```

显式指定多个数据源：

```bash
CODEX_USAGE_SESSIONS="$HOME/.codex/sessions:/mnt/c/Users/<Windows用户名>/.codex/sessions:/mnt/c/Users/<Windows用户名>/.codex/archived_sessions" npm run web
```

## API

Web 服务提供：

```text
GET /api/usage
POST /api/index/refresh
```

`GET /api/usage` 缺省为只读 SQLite 快照，不触发索引刷新；兼容参数 `refreshIndex=1` 仍可显式请求刷新。
新调用方应使用 `POST /api/index/refresh` 执行刷新，然后继续使用 GET 做查询。

常用查询参数：

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| `range` | `all`、`today`、`24h`、`7d`、`30d`、`12w`、`custom` | 时间范围；滚动范围按分钟更新 |
| `sourceScope` | `all`、`local`、`wsl`、`windows` | 数据源范围；`local` 保留兼容，`wsl` 和 `windows` 为两个明确环境 |
| `from` | `2026-04-01` | `range=custom` 时的开始日期 |
| `to` | `2026-04-30` | `range=custom` 时的结束日期 |
| `group` | `day` | 分组方式 |
| `sort` | `total` | 排序字段 |
| `asc` / `desc` | `1` | 排序方向 |
| `limit` | `60` | 输出行数 |
| `dedupeScope` | `global` | 去重范围 |
| `refreshIndex` | `0`、`1` | 兼容参数；缺省为 `0`（只读快照），`1` 显式刷新后查询 |

示例：

```text
http://127.0.0.1:8787/api/usage?range=30d&group=day&sort=key&desc=1&limit=60&dedupeScope=global
```

响应保留原有字段，并额外提供 `assumedModels`、`unpricedModels`、provisional 计价汇总，以及
`pricing.mode = "event-time"`、`checkedAt`、`latestEffectiveFrom`、`refreshStatus` 和 `usedFallback`。
`stats` 还包含 `indexRefreshSkipped`、`queryCacheHit`、`costCacheHit`、`scanDurationMs`、
`dedupeDurationMs`、`aggregationDurationMs`、`totalDurationMs`、`incrementalFiles`、
`fullRescanFiles`、`scannedBytes`、`unknownTimestampEvents`、`unknownTimestampTokens`、
`excludedUnknownTimestampEvents` 和 `excludedUnknownTimestampTokens`。查询缓存命中时各阶段耗时为 `0`，
`totalDurationMs` 始终是当前请求耗时。

## 项目结构

```text
.
├── bin/
│   ├── codex-token-usage.mjs      # CLI 公共入口
│   ├── codex-token-usage-core.mjs # 参数、数据源与基础工具
│   ├── codex-usage-server.mjs     # 本地 Web 服务与启动预热
│   ├── session-scanner.mjs        # 可恢复的增量 JSONL 扫描器
│   ├── usage-aggregation.mjs      # Direct/Cache 一致的聚合与 CLI 输出
│   ├── usage-index.mjs            # SQLite 索引、迁移与计价切片
│   ├── usage-index-view.mjs       # 索引查询的 unknown-time 正确性层
│   ├── usage-canonical.mjs        # 持久化全局去重范围
│   ├── usage-query.mjs            # 查询结果 LRU 与缓存只读链路
│   ├── openai-pricing.mjs         # 价格目录服务入口
│   ├── pricing-catalog.mjs        # 版本选择和事件时点计价
│   ├── pricing-refresh.mjs        # 官方模型 Markdown 校验与运行时缓存
│   └── update-pricing.mjs         # 手动价格更新器
├── pricing/
│   └── openai-pricing.snapshot.json # 内置版本化价格历史
├── public/
│   ├── index.html                 # 仪表盘页面
│   ├── app.js                     # 前端交互、图表和表格渲染
│   └── styles.css                 # 页面样式
├── test/                           # 计价、刷新和聚合边界测试
├── .github/                       # CI、Dependabot、Issue/PR 模板
├── LICENSE
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── package.json
├── package-lock.json
├── README.en.md
└── README.md
```

## 开源协作

- 贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要直接创建公开 Issue。
- 行为规范见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 本项目只处理本机 Codex 日志；请勿提交会话 JSONL、SQLite 数据库、提示词或其他个人数据。

## 常见问题

### 首次打开 Web 页面为什么比较慢？

首次启动且没有旧索引时需要完整扫描历史 JSONL。已有旧索引会原地迁移，但扫描器版本升级后的第一次
索引刷新也必须逐文件完整重读日志，才能恢复旧索引没有保存的原始字段和正确去重键；例如历史日志约为
23 GB 时，本次升级可能读取约 23 GB。已成功转换的文件会立即提交，中断后只重试仍为旧版本的文件。
完成后，普通追加只读取新增字节；只有文件被改写、替换或恢复状态失效时才完整重扫该文件。

### 会不会把会话内容上传出去？

不会。这个工具只在本机读取本地 JSONL 文件，Web 服务也只监听本地地址 `127.0.0.1`。
启动时会向固定的 `developers.openai.com` 模型 Markdown 地址发送价格校验请求，但不会发送会话内容。

### 为什么同一时间范围下 `global` 和 `file` 统计结果不同？

`global` 会跨文件去重，适合看长期真实消耗；`file` 只在单个文件内去重，适合排查某个
JSONL 文件的原始记录。旧版 Codex 可能把历史 rollout 内容复制进新文件，因此 `file`
口径通常会更接近“文件记录量”，但可能高估真实 token 消耗。

### 为什么 Web 和 CLI 的速度不同？

CLI 默认每次直接扫描 JSONL，也可通过 `--use-cache` 复用索引。Web 的筛选请求使用
`refreshIndex=0`，只读取 SQLite、持久化全局去重结果、计价切片和最多 64 项查询结果缓存；只有
“刷新索引”会访问日志文件，因此加载完成后的筛选不会再次走扫描流程。

## 开发验证

语法检查：

```bash
node --check bin/codex-token-usage.mjs
node --check bin/codex-token-usage-core.mjs
node --check bin/codex-usage-server.mjs
node --check bin/openai-pricing.mjs
node --check bin/pricing-catalog.mjs
node --check bin/pricing-refresh.mjs
node --check bin/session-scanner.mjs
node --check bin/usage-aggregation.mjs
node --check bin/usage-index.mjs
node --check bin/usage-index-view.mjs
node --check bin/usage-query.mjs
node --check public/app.js
```

功能 smoke：

```bash
npm run smoke
npm run benchmark:index
node ./bin/codex-token-usage.mjs --group month --limit 1
node ./bin/codex-token-usage.mjs --group month --limit 1 --csv
```
