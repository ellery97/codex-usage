# Codex Token Usage

[![CI](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文版](README.md)

A local CLI and web dashboard for analyzing Codex token usage and estimating API-equivalent costs.
It reads Codex session logs on the local machine and never uploads session content. At startup it
only contacts fixed official OpenAI model-documentation URLs to validate public prices.

## Data sources

By default, the tool discovers every accessible source for the current runtime. The `all` scope
merges the WSL/Linux and Windows sides:

```text
# WSL/Linux side (local paths in WSL, \\wsl.localhost or \\wsl$ UNC paths on native Windows)
~/.codex/sessions/**/*.jsonl
~/.codex/archived_sessions/**/*.jsonl

# Windows side (/mnt/c paths in WSL/Linux, C:\Users paths on native Windows)
/mnt/c/Users/*/.codex/sessions/**/*.jsonl
/mnt/c/Users/*/.codex/archived_sessions/**/*.jsonl
```

Missing or inaccessible directories are ignored. On native Windows the tool does not rewrite
`/mnt/c/...` into a fake path such as `E:\mnt\c\...`; it enumerates accessible WSL distributions
and their `/home/*` users through UNC paths. In WSL/Linux it checks accessible Windows user
directories under `/mnt/c/Users`.

Only `event_msg.token_count`, `event_msg.thread_settings_applied`, `turn_context`, and
`session_meta` records are used to recover token usage, model, working directory, and session
metadata. Session bodies are not printed or uploaded.

## Features

- Aggregate token usage by month, day, model, working directory, or session.
- Filter by all time, recent periods, today, or custom date ranges.
- Export text, JSON, or CSV from the CLI.
- View summary cards, usage trends, token composition, index-refresh status, and detail tables in a local web dashboard.
- Keep a persistent SQLite index; safe appends read only new bytes and rewritten files fall back to a full rescan.
- Persist global canonical events by source scope and reuse costed slices plus an in-process query cache.
- Select OpenAI API Standard prices at each event timestamp and distinguish official, assumed, and unpriced usage.
- Keep truly timestamp-less events in all-time totals as unpriced usage, while bounded ranges report how many were excluded.
- Discover and merge current and archived Codex sessions on both WSL/Linux and Windows when available.
- Use global deduplication by default to reduce double counting from copied historical rollout content.

## Requirements

- Node.js 22 or later, including the built-in `node:sqlite` module.
- No third-party runtime npm dependencies are required.
- At least one accessible Codex session directory. The default starts at `~/.codex` on WSL/Linux,
  scans `C:\Users\*\.codex` on native Windows, and discovers the other environment when available.

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

Refresh the runtime pricing catalog manually:

```bash
npm run update-pricing
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
No third-party npm dependencies or OpenAI API key are required. Startup only downloads fixed
official model Markdown pages for price validation and never uploads log content.

## Web dashboard

The equivalent direct command is:

```bash
node --no-warnings --expose-gc ./bin/codex-usage-server.mjs
```

The server synchronizes the default source before listening, discovers models from the updated
index, refreshes pricing, and prewarms common canonical scopes plus the default dashboard query.
The index lives at `.codex-usage/cache.sqlite` by default. A new index scans historical JSONL files;
later safe appends resume from a saved byte offset and parser context. Truncation, replacement,
same-size rewrites, inode or boundary-hash changes, and scanner-version changes trigger a full
rescan of that file. An incomplete trailing JSON line remains pending until the next append.

Initial UI loading and filter changes use the current SQLite snapshot without touching JSONL.
Source, range, grouping, sorting, direction, and deduplication apply automatically; row limits and
custom dates use a 200ms debounce. New logs written after startup appear only after the user clicks
**Refresh index**, which invalidates the cost and result caches.

The `24h`, `7d`, `30d`, and `12w` Web ranges roll in one-minute buckets: requests within a minute
reuse a stable boundary, while the next minute gets a new cache key. `today` starts at midnight in
the target IANA timezone and changes as soon as that timezone enters a new date.

Global canonical representatives are persisted per normalized source-root set. Only dirty event
keys are repaired after file changes, and at most eight recently used scopes are retained. Existing
indexes migrate in place. When the stored scanner version is stale, the first index refresh after an
upgrade fully rereads each existing JSONL file to recover cache-write values, event fingerprints,
cumulative-token key suffixes, and resumable parser state. Each converted file commits
independently; once conversion finishes, ordinary appends return to incremental reads.

The source selector supports all directories, WSL/Linux, and Windows (including archived sessions).
The API keeps `sourceScope=local` for compatibility; it means the current session directory of the
runtime environment.
`.codex-usage/` is ignored by Git and should never be committed.
The runtime price history is stored beside the database as `pricing-history.json`.

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

# Sort models by event-time Standard API reference cost
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
| `--today` | Start at midnight in `--timezone` |
| `--group VALUE` | `none`, `day`, `month`, `model`, `cwd`, or `session` |
| `--sort VALUE` | `key`, `total`, `input`, `output`, `cached`, `reasoning`, `requests`, `sessions`, or `cost` |
| `--asc`, `--desc` | Sort direction |
| `--limit N` | Maximum number of rows; `0` means unlimited |
| `--dedupe-scope VALUE` | `global` or `file`; defaults to `global` |
| `--timezone`, `--tz TZ` | Timezone for date grouping and `--today` |
| `--use-cache` | Reuse the Web dashboard's incremental SQLite index |
| `--cache-db PATH` | Select the SQLite index path and imply `--use-cache` |
| `--json` | Output JSON |
| `--csv` | Output CSV |
| `--no-refresh-pricing` | Skip network refresh and use the latest validated local catalog |
| `-h`, `--help` | Show help |

## Accounting semantics

Codex session files can contain duplicate cumulative `token_count` records in one file, and newer
rollout files can embed historical events. The tool first deduplicates cumulative-token vectors
within each file. The default `global` scope then deduplicates across files with an event fingerprint
built from the event timestamp, six-field cumulative usage, and request delta. When the event
timestamp is truly missing, the fingerprint also includes fallback session/cwd/model identity to
avoid unrelated-session collisions.

Direct Scan and SQLite use the same deterministic canonical representative rule: complete file path
in binary order, then event order within the file. Reversing the order of repeated `--sessions`
arguments therefore cannot change model, cwd, session, or cost attribution.

Use `--dedupe-scope file` when inspecting the raw records of one JSONL file. Use the default
`global` scope for long-term real-usage totals. Canonical selection happens before time filtering.

Truly timestamp-less events are not silently dropped from all-time results. With no `from`/`to`
bounds they remain in request and token totals, are treated as unpriced, and appear under
`(unknown time)` for day/month grouping. Bounded queries cannot safely determine whether such an
event is in range, so they exclude it and report `stats.excludedUnknownTimestampEvents` and
`stats.excludedUnknownTimestampTokens`.

## Fields

| Field | Meaning |
| --- | --- |
| `input_tokens` | Input tokens, including cached input |
| `cached_input_tokens` | Cached portion of input tokens |
| `cache_write_input_tokens` | Input tokens used to populate a cache |
| `uncached_input_tokens` | `input_tokens - cached_input_tokens - cache_write_input_tokens` |
| `output_tokens` | Output tokens, including reasoning output |
| `reasoning_output_tokens` | Reasoning portion of output tokens |
| `total_tokens` | Total reported by Codex, usually input plus output |
| `cache_hit_ratio` | `cached_input_tokens / input_tokens` |
| `estimated_cost_usd` | Event-time USD estimate for models with published prices only |
| `assumed_cost_usd` | Explicitly labelled assumption baseline |
| `assumed_upper_bound_cost_usd` | Assumption upper bound |
| `reference_total_cost_usd` | Official amount plus assumption baseline |
| `reference_total_upper_bound_cost_usd` | Official amount plus assumption upper bound |
| `priced_requests` | Requests matched to the price table |
| `assumed_requests` | Requests using an explicitly labelled route assumption |
| `assumed_total_tokens` | Tokens using an explicitly labelled route assumption |
| `unpriced_requests` | Requests with neither a published price nor an assumption route |
| `unpriced_total_tokens` | Tokens with neither a published price nor an assumption route |
| `provisional_priced_requests` | Requests priced with a provisional official-price baseline |
| `provisional_priced_total_tokens` | Tokens priced with a provisional official-price baseline |
| `provisional_estimated_cost_usd` | Portion of official cost coming from provisional versions |
| `requests` | Number of token events, approximately the recorded request count |
| `sessions` | Number of Codex sessions included |

Cached input, cache-write input, and reasoning output are subsets; do not add them again to `total_tokens`.

## Cost estimation

Costs come from a versioned catalog of OpenAI API Standard text-token prices. Each timestamped event
selects the newest version whose effective time is not later than the event's UTC timestamp; an
event exactly on a boundary uses the new version. A truly timestamp-less event cannot safely select
a historical price version, so it remains in token totals but is marked unpriced. Legacy prices
without an authoritative effective date remain visible as `provisional` historical baselines.

Built-in history lives at `pricing/openai-pricing.snapshot.json`. Runtime validation is stored as
`.codex-usage/pricing-history.json` beside the SQLite database. The web server refreshes before
listening, while the CLI refreshes before aggregation and output; `--help` stays offline. Refreshes
use at most six concurrent requests, an eight-second overall timeout, and conditional
`ETag`/`Last-Modified` requests. Partial or complete network failure falls back to the most recent
validated local versions.

```text
official cost =
  (ordinary input * input rate
   + cache reads * cached-input rate
   + cache writes * cache-write rate
   + output * output rate) / 1,000,000

reference baseline = official cost + assumed baseline
reference upper bound = official cost + assumed upper bound
```

These values are event-time Standard API-equivalent references, not ChatGPT subscription charges,
Codex credits, or actual billing. They exclude Batch, Flex, Fast, regional uplifts, taxes, and
account-specific discounts.

`codex-auto-review` has no independently published price and never contributes to
`estimated_cost_usd`. Its labelled reference route uses GPT-5.4 as the baseline from 2026-04-23,
then GPT-5.6 Luna from 2026-07-30 with lower evidence; GPT-5.6 Sol is the upper bound in both
periods. Cross-period results expose each route separately in `assumedModels[].routes`.

Refresh the runtime catalog or inspect changes without writing:

```bash
npm run update-pricing
npm run update-pricing -- --check
```

After verifying an authoritative effective date, seed a formal built-in version with
`--seed --model ... --effective-from YYYY-MM-DD --source-url ...`. The updater and startup refresh
share the same strict parser: it reads only `Pricing / Text tokens` and requires the page's
`Model ID` to match exactly.

Primary references:

- `https://developers.openai.com/api/docs/models/<model>.md`
- <https://openai.com/index/gpt-5-6/>
- <https://alignment.openai.com/auto-review/>

## Web environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Web port; takes precedence over `CODEX_USAGE_PORT` |
| `CODEX_USAGE_PORT` | `8787` | Web port |
| `HOST` | `127.0.0.1` | Listen address; the server has no authentication |
| `CODEX_USAGE_DB` | `.codex-usage/cache.sqlite` | SQLite index path |
| `CODEX_USAGE_PRICING_CACHE` | `pricing-history.json` beside the database | Runtime versioned pricing catalog |
| `CODEX_USAGE_PRICING_TIMEOUT_MS` | `8000` | Overall startup pricing-refresh timeout in milliseconds |
| `CODEX_USAGE_PRICING_REFRESH` | non-`0` | Set to `0` to disable startup pricing refresh |
| `CODEX_USAGE_SCAN_CHECK_TTL_MS` | `1000` | File-change check TTL in milliseconds |
| `CODEX_USAGE_SCAN_CONCURRENCY` | `8` | Rescan concurrency, clamped to 1–32 |
| `CODEX_USAGE_GC` | non-`0` | Set to `0` to disable explicit GC |
| `CODEX_HOME` | `~/.codex` | Codex home used for default session discovery |
| `CODEX_USAGE_SESSIONS` | empty | Platform-delimited session directories (`;` on Windows, `:` on WSL/Linux); overrides default discovery for `all` |
| `CODEX_USAGE_WINDOWS_ROOT` | auto-detected | Windows user root; inferred from `USERPROFILE` on native Windows and defaults to `/mnt/c/Users` on WSL/Linux |
| `CODEX_USAGE_WSL_DISTROS` | auto-detected | Semicolon-separated WSL distributions to inspect on native Windows; otherwise `wsl.exe -l -q` is used |

Example:

```bash
CODEX_USAGE_PORT=8788 CODEX_USAGE_DB=/tmp/codex-usage.sqlite npm run web
```

## API

The web server exposes:

```text
GET /api/usage
POST /api/index/refresh
```

`GET /api/usage` is snapshot-only by default and does not refresh the index. The compatibility
parameter `refreshIndex=1` can still explicitly refresh before returning the query. New callers
should use `POST /api/index/refresh` for the write operation and keep GETs read-only.

Common query parameters are `range`, `sourceScope` (`all`, `local`, `wsl`, or `windows`), `from`,
`to`, `group`, `sort`, `asc`, `desc`, `limit`, `dedupeScope`, and `refreshIndex`. The default
`refreshIndex` behavior is equivalent to `0`; `1` is the temporary compatibility alias described
above. Rolling ranges use one-minute time buckets, and `today` changes at midnight in the target
timezone.

Example:

```text
http://127.0.0.1:8787/api/usage?range=30d&group=day&sort=key&desc=1&limit=60&dedupeScope=global
```

The response keeps existing fields and adds `assumedModels`, `unpricedModels`, provisional-price
totals, and event-time catalog metadata such as `pricing.checkedAt`, `latestEffectiveFrom`,
`refreshStatus`, and `usedFallback`. Performance metadata includes `indexRefreshSkipped`,
`queryCacheHit`, `costCacheHit`, phase durations, incremental/full-rescan counts, scanned bytes,
`unknownTimestampEvents`, `unknownTimestampTokens`, `excludedUnknownTimestampEvents`, and
`excludedUnknownTimestampTokens`. On a result-cache hit, phase durations are zero and
`totalDurationMs` measures the current request.

## Project structure

```text
.
├── bin/                          # CLI, web server, aggregation, index views, catalog, and updater
├── pricing/                      # Built-in effective-dated price history
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

A first start with no index scans historical JSONL. Existing indexes migrate in place, but the first
refresh after a scanner-version upgrade must fully reread each log to recover source fields and the
correct deduplication key. A 23 GB history can therefore require about 23 GB of reads during that
upgrade. Converted files commit independently, so an interrupted migration retries only stale files.
Safe appends later read only new bytes; rewritten or invalidated files fall back to a full rescan.

### Does the tool upload session content?

No. It reads local JSONL files only and serves the dashboard on `127.0.0.1`. Startup sends price
validation requests to fixed `developers.openai.com` model Markdown URLs, but no session content.

### Why do global and file deduplication differ?

`global` deduplicates across all scanned files and is recommended for long-term totals. `file`
deduplicates only inside each JSONL file and is useful for inspecting raw file records.

### Why is the web dashboard faster after the first run?

The CLI scans JSONL by default and can reuse the index with `--use-cache`. Web filters send
`refreshIndex=0` and reuse SQLite, persisted canonical events, one costed slice, and up to 64 query
results. Only **Refresh index** checks session files.

## Development validation

```bash
npm ci
npm test
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
npm run benchmark:index
git diff --check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.
