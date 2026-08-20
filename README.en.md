# Codex Token Usage

[![CI](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文版](README.md)

A local CLI and web dashboard for analyzing Codex token usage and estimating API costs.
It reads Codex session logs on the local machine and does not upload session content.

## Data sources

By default, the tool discovers these sources when they exist:

```text
~/.codex/sessions/**/*.jsonl
/mnt/c/Users/*/.codex/sessions/**/*.jsonl
/mnt/c/Users/*/.codex/archived_sessions/**/*.jsonl
```

Only `event_msg.token_count`, `turn_context`, and `session_meta` records are used to
recover token usage, model, working directory, and session metadata. Session bodies are
not printed or uploaded.

## Features

- Aggregate token usage by month, day, model, working directory, or session.
- Filter by all time, recent periods, today, or custom date ranges.
- Export text, JSON, or CSV from the CLI.
- View summary cards, usage trends, token composition, scan status, and detail tables in a local web dashboard.
- Keep a persistent SQLite index and incrementally rescan only new or changed JSONL files.
- Estimate USD cost using the OpenAI API standard token-price snapshot and sort by cost.
- Discover Windows current and archived Codex session directories under WSL.
- Use global deduplication by default to reduce double counting from copied historical rollout content.

## Requirements

- Node.js 22 or later, including the built-in `node:sqlite` module.
- No third-party runtime npm dependencies are required.
- A local Codex session directory, normally `~/.codex/sessions`.

If the web server reports `No such built-in module: node:sqlite`, upgrade Node.js.

## Quick start

Show CLI statistics:

```bash
npm run usage
```

Start the local web dashboard:

```bash
npm run web
```

Open <http://127.0.0.1:8787> in a browser.

Run the smoke check:

```bash
npm run smoke
```

## Using on macOS

This project runs directly on macOS. From the project root, run:

```bash
npm run usage
npm run web
```

The default macOS source is `~/.codex/sessions`. If the logs are elsewhere, use
`CODEX_HOME=/path/to/.codex npm run usage` or pass `--sessions` explicitly.
Node.js 22 or later is required; the project was verified with `v22.22.0`.
No third-party npm dependencies are required, and the tool reads local logs only without
an OpenAI API key or any upload path.

## Web dashboard

The equivalent direct command is:

```bash
node --no-warnings --expose-gc ./bin/codex-usage-server.mjs
```

The server serves the dashboard and aggregates data through a SQLite index at
`.codex-usage/cache.sqlite` by default. The first scan processes historical JSONL files;
later refreshes use file size and modification time to rescan only changed files.

The source selector supports all directories, WSL/Linux, and Windows (including archived sessions).
`.codex-usage/` is ignored by Git and should never be committed.

The server has no authentication and listens on `127.0.0.1` by default. Do not bind it to
`0.0.0.0` or expose it to an untrusted network without adding an authenticated, protected proxy.

## CLI usage

Run:

```bash
node ./bin/codex-token-usage.mjs [options]
```

Examples:

```bash
# Group all-time usage by month
node ./bin/codex-token-usage.mjs

# Group a date range by day
node ./bin/codex-token-usage.mjs --from 2026-04-01 --to 2026-04-30 --group day

# Show the last seven days as JSON
node ./bin/codex-token-usage.mjs --last 7d --group day --json

# Find the 20 highest-token working directories
node ./bin/codex-token-usage.mjs --group cwd --sort total --desc --limit 20

# Sort models by estimated cost
node ./bin/codex-token-usage.mjs --group model --sort cost --desc --limit 20

# Count only the Windows current-session directory
node ./bin/codex-token-usage.mjs --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions

# Count Windows current and archived sessions explicitly
node ./bin/codex-token-usage.mjs --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/archived_sessions

# Combine local and Windows sources explicitly
node ./bin/codex-token-usage.mjs --sessions ~/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/archived_sessions

# Export CSV
node ./bin/codex-token-usage.mjs --group month --csv > codex_usage.csv

# Inspect per-file records without cross-file deduplication
node ./bin/codex-token-usage.mjs --dedupe-scope file
```

Available options:

| Option | Description |
| --- | --- |
| `--codex-home PATH` | Codex home directory; defaults to `$CODEX_HOME` or `~/.codex` |
| `--sessions PATH` | Session directory; may be repeated and overrides automatic discovery |
| `--from`, `--since DATE` | Include token events after this time |
| `--to`, `--until DATE` | Include token events before this time; a date includes the full day |
| `--last DURATION` | Recent period such as `24h`, `7d`, or `4w` |
| `--today` | Start at local midnight |
| `--group VALUE` | `none`, `day`, `month`, `model`, `cwd`, or `session` |
| `--sort VALUE` | `key`, `total`, `input`, `output`, `cached`, `reasoning`, `requests`, `sessions`, or `cost` |
| `--asc`, `--desc` | Sort direction |
| `--limit N` | Maximum number of rows; `0` means unlimited |
| `--dedupe-scope VALUE` | `global` or `file`; defaults to `global` |
| `--timezone`, `--tz TZ` | Timezone for date grouping |
| `--json` | Output JSON |
| `--csv` | Output CSV |
| `-h`, `--help` | Show help |

## Accounting semantics

Codex session files can contain duplicate cumulative `token_count` records in one file,
and newer rollout files can embed historical events. The tool first deduplicates within each
file, then uses global cumulative-vector deduplication by default across all files.

Use `--dedupe-scope file` when inspecting the raw records of one JSONL file. Use the default
`global` scope for long-term real-usage totals.

## Fields

| Field | Meaning |
| --- | --- |
| `input_tokens` | Input tokens, including cached input |
| `cached_input_tokens` | Cached portion of input tokens |
| `uncached_input_tokens` | `input_tokens - cached_input_tokens` |
| `output_tokens` | Output tokens, including reasoning output |
| `reasoning_output_tokens` | Reasoning portion of output tokens |
| `total_tokens` | Total reported by Codex, usually input plus output |
| `cache_hit_ratio` | `cached_input_tokens / input_tokens` |
| `estimated_cost_usd` | Estimated USD amount from the local price snapshot |
| `priced_requests` | Requests matched to the price table |
| `unpriced_requests` | Requests not matched to the price table |
| `unpriced_total_tokens` | Tokens excluded from the cost estimate |
| `requests` | Number of token events, approximately the recorded request count |
| `sessions` | Number of Codex sessions included |

Cached input and reasoning output are subsets; do not add them again to `total_tokens`.

## Cost estimation

The local snapshot was refreshed on 2026-08-20 and uses OpenAI API standard text-token prices
per 1M tokens. It excludes Batch discounts, Flex/Priority differences, regional uplifts,
subscriptions, taxes, and account-specific discounts.

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| `gpt-5.6` / `gpt-5.6-sol` | $5.00 | $0.50 | $30.00 |
| `gpt-5.6-terra` | $2.00 | $0.20 | $12.00 |
| `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 |

`gpt-5.6` is an alias for `gpt-5.6-sol`. For GPT-5.6 requests with more than 272,000 input
tokens, the full request uses 2x input and cached-input rates and 1.5x output rates.

```text
estimated_cost_usd =
  (uncached input tokens * input rate
   + cached input tokens * cached-input rate
   + output tokens * output rate) / 1,000,000
```

OpenAI documents GPT-5.6 cache writes at 1.25x the uncached input rate. Current Codex logs do
not expose a separate `cache_write_tokens` field, so this tool cannot add that surcharge separately.

Price references:

- <https://developers.openai.com/api/docs/pricing>
- <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- <https://developers.openai.com/api/docs/models/gpt-5.6-terra>
- <https://developers.openai.com/api/docs/models/gpt-5.6-luna>

Unknown models are counted in token totals and `unpriced_total_tokens`, but contribute zero to
`estimated_cost_usd`.

## Web environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Web port; takes precedence over `CODEX_USAGE_PORT` |
| `CODEX_USAGE_PORT` | `8787` | Web port |
| `HOST` | `127.0.0.1` | Listen address; the server has no authentication |
| `CODEX_USAGE_DB` | `.codex-usage/cache.sqlite` | SQLite index path |
| `CODEX_USAGE_SCAN_CHECK_TTL_MS` | `1000` | File-change check TTL in milliseconds |
| `CODEX_USAGE_SCAN_CONCURRENCY` | `8` | Rescan concurrency, clamped to 1–32 |
| `CODEX_USAGE_GC` | non-`0` | Set to `0` to disable explicit GC |
| `CODEX_HOME` | `~/.codex` | Codex home used for default session discovery |
| `CODEX_USAGE_SESSIONS` | empty | Colon-separated session directories; overrides auto-discovery |

Example:

```bash
CODEX_USAGE_PORT=8788 CODEX_USAGE_DB=/tmp/codex-usage.sqlite npm run web
```

## API

The web server exposes:

```text
GET /api/usage
```

Common query parameters are `range`, `sourceScope`, `from`, `to`, `group`, `sort`, `asc`,
`desc`, `limit`, and `dedupeScope`.

Example:

```text
http://127.0.0.1:8787/api/usage?range=30d&group=day&sort=key&desc=1&limit=60&dedupeScope=global
```

## Project structure

```text
.
├── bin/                          # CLI, web server, and pricing logic
├── public/                       # Dashboard HTML, JavaScript, and CSS
├── test/                         # Node.js tests
├── .github/                      # CI, Dependabot, and contribution templates
├── LICENSE
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── package.json
├── package-lock.json
├── README.md
└── README.en.md
```

## Open-source collaboration

- Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md).
- Private vulnerability reports: [SECURITY.md](SECURITY.md).
- Community standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Never commit session JSONL files, SQLite databases, prompts, credentials, or personal data.

## FAQ

### Why is the first web page load slow?

The first start scans historical JSONL files and writes the SQLite index. Later refreshes reuse
the index and rescan only new or modified files.

### Does the tool upload session content?

No. It reads local JSONL files only, serves the dashboard on `127.0.0.1`, and contains no external
upload path.

### Why do global and file deduplication differ?

`global` deduplicates across all scanned files and is recommended for long-term totals. `file`
deduplicates only inside each JSONL file and is useful for inspecting raw file records.

### Why is the web dashboard faster after the first run?

The CLI scans JSONL files on every run. The web server maintains a persistent SQLite index and
uses SQL aggregation for later filters and refreshes.

## Development validation

```bash
npm ci
npm test
node --check bin/codex-token-usage.mjs
node --check bin/codex-usage-server.mjs
node --check bin/openai-pricing.mjs
node --check public/app.js
git diff --check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.
