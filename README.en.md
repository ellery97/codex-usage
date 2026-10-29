# Codex Token Usage

[![CI](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ellery97/codex-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文版](README.md)

A local CLI and web dashboard for analyzing Codex token usage and estimating API-equivalent costs.
It reads Codex session logs on the local machine and never uploads session content. The Web dashboard
uses local prices by default; the CLI validates prices online by default, and Web startup can opt in.
Price validation only contacts fixed official OpenAI model-documentation URLs.

## Dashboard preview

![Codex Token Usage Dashboard preview](docs/dashboard-preview.png)

The image uses sample session data and is provided only to show the current Web dashboard rendering.

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

- Node.js `^22.15.0 || >=23.8.0`, including built-in SQLite and Zstd streams. Use a maintained Node.js 22 or 24 release.
- No third-party runtime npm dependencies are required.
- At least one accessible Codex session directory. The default starts at `~/.codex` on WSL/Linux,
  scans `C:\Users\*\.codex` on native Windows, and discovers the other environment when available.

If the web server reports `No such built-in module: node:sqlite`, upgrade Node.js.

## Quick start

Show CLI statistics:

```bash
npm run usage
```

This command reuses the Web dashboard's incremental SQLite index by default. The first run or a
scanner upgrade still reads historical logs; subsequent runs read changed files or appended bytes.
Scan progress, new/upgrade/modified file counts, pricing, and aggregation stages go to stderr, keeping
JSON/CSV results clean. When redirecting npm output, use
`npm run --silent usage -- --json > usage.json` to suppress npm's own startup banner.

The CLI still validates prices online by default. To use local prices and skip the network wait, run:

```bash
npm run usage -- --no-refresh-pricing
```

Start the local web dashboard:

```bash
npm run web
```

The Web dashboard uses local prices by default, skipping both online validation and the historical-model
query used to prepare it.

You can also choose the port at startup:

```bash
npm run web -- --port 8899
# or
npm run web -- -p 8899
```

Open the actual URL printed by the server startup log. When the default port is available, it is
the following:

```text
http://127.0.0.1:8787
```

Run the smoke check:

```bash
npm run smoke
```

Refresh the runtime pricing catalog manually:

```bash
npm run update-pricing
```

If the Web server is already running, restart it after updating prices to load the new catalog.
The dashboard's **Refresh index** button only updates the usage-log index.

## Using on macOS

This project runs directly on macOS. From the project root, run:

```bash
npm run usage
npm run web
```

Then open:

```text
http://127.0.0.1:8787
```

Notes:

- Node.js must satisfy `^22.15.0 || >=23.8.0`.
- No third-party npm dependencies are required, so `npm install` is normally unnecessary.
- The default macOS source is `~/.codex/sessions`. If the logs are elsewhere, use
  `CODEX_HOME=/path/to/.codex npm run usage` or pass `--sessions` explicitly.
- No OpenAI API key is required, and session data is never uploaded. The Web dashboard uses local
  prices by default; the CLI downloads fixed official model Markdown pages for price validation by default.

## Web dashboard

The equivalent direct command is:

```bash
node --no-warnings --expose-gc ./bin/codex-usage-server.mjs
```

The dashboard puts the baseline API reference amount, total tokens, requests, and cache-hit ratio
first, with the last 7 days selected by default. Quick ranges cover today, 7 days, 30 days, and all
time; **More ranges** retains 24 hours, 12 weeks, and custom dates. Custom dates require at least one
bound, and the end cannot precede the start.

- Day/month charts switch between **Token / Reference amount**, updating currency axes, peaks, and tooltips. Amounts use the existing baseline reference total. Token totals, input, and output share one vertical scale. Model, directory, and session rankings still follow the selected sort metric.
- Summary cards and composition cover the full filtered range. Charts and the table display returned groups with an explicit shown/total count. Set the group limit to `0` for all returned groups; rankings show at most the first 18. Table search only searches loaded groups.
- The full-width table shows core columns by default. **Full columns** adds cache reads/writes, reasoning output, and published-rate estimates. On narrow screens, scrolling stays inside the table, with sticky headers and group labels.
- **Estimate details** explains included amounts and assumptions. **Sources and index details** contains source paths, scan diagnostics, and deduplication settings. File-level deduplication, failed reads, and missing prices remain visibly flagged.
- Chart metrics, table search, column visibility, and disclosure panels only change local presentation; they do not query, scan, or validate prices. Trends support mouse pointing and touch selection. Initial load errors provide a retry action. System fonts avoid external font requests.

The server listens after loading the existing index and local prices, then scans logs in the background.
It displays the published snapshot immediately, or a building-index empty state if none exists.
A persistent incomplete-history notice stays visible during scanning; filters remain usable.
By default it skips both online price validation and the historical-model query used for that validation.
To enable online validation for a particular startup, run:

```bash
CODEX_USAGE_PRICING_REFRESH=1 npm run web
```

You can also run `npm run update-pricing` to update the local price catalog manually, then restart
any running Web server to load it.

The index lives at `.codex-usage/cache.sqlite`. Discovery includes `.jsonl` and `.jsonl.zst` in
session, archive, and custom source directories. Date filters use event timestamps, never filenames.
Zstd files stream through native Node.js decoders one frame at a time; no decompressed log is written
to disk. At most two compressed files decode concurrently, within the overall scan concurrency limit.

Ordinary logs retain their byte offsets, parser context, file identity, and boundary hashes for
incremental appends. Compressed files are fully read when first discovered or when size, mtime, or
identity changes; unchanged files are not opened, decompressed, or hashed. Global deduplication counts
a shared event only once across both formats; `--dedupe-scope file` counts each file separately.
The additive schema migration preserves existing events and keeps ordinary scanner version 6.

Results are staged in SQLite TEMP tables in batches and published together after scanning. Queries
continue reading the previous published snapshot. Failed files are listed separately; their previous
index is retained, including a missing plain file whose compressed replacement failed. Startup skips
unchanged known failures; file changes or manual refresh retry them. Database errors, publication
conflicts, or interruption discard this run's staging without publishing it.

Initial UI loading and filters read the published snapshot without waiting for background work.
Source, range, grouping, sorting, direction, and deduplication apply automatically; row limits and
custom dates use a 200ms debounce. Startup runs one background check; use **Refresh index** for later
log changes. The UI polls status once a second during scanning or optional background price validation,
reloads the current filters on completion, and stops polling once both finish. Source changes discard
old status requests. Partial failures keep a warning, file details, and retry action visible. Progress
separates source bytes read from decoded bytes processed; reading compressed bytes is not completion.

The `24h`, `7d`, `30d`, and `12w` Web ranges roll in one-minute buckets: requests within a minute
reuse a stable boundary, while the next minute gets a new cache key. `today` starts at midnight in
the target IANA timezone and changes as soon as that timezone enters a new date.

Global canonical representatives are persisted per normalized source-root set. Only dirty event
keys are repaired after file changes, and at most eight recently used scopes are retained. Existing
indexes migrate in place. When the stored scanner version is stale, the first index refresh after an
upgrade fully rereads each existing JSONL file to recover cache-write values, event fingerprints,
cumulative-token key suffixes, and resumable parser state. Successful results publish together
after scanning; ordinary appends continue using incremental reads.

The source selector supports all directories, WSL/Linux, and Windows. The WSL/Linux and Windows
scopes each include the accessible current and archived session directories for that environment.
The API keeps `sourceScope=local` for compatibility; it means the current session directory of the
runtime environment.
`.codex-usage/` is ignored by Git and should never be committed.
The runtime price history is stored beside the database as `pricing-history.json`.

The server has no authentication and listens on `127.0.0.1` by default. Do not bind it to
`0.0.0.0` or expose it to an untrusted network without adding an authenticated, protected proxy.

## CLI usage

For everyday use with caching enabled:

```bash
npm run usage -- [options]
```

For a stateless full scan when investigating index differences, run the original CLI directly:

```bash
node ./bin/codex-token-usage.mjs [options]
```

Examples:

```bash
# Group all-time usage by month
npm run usage

# Group a date range by day
npm run usage -- --from 2026-04-01 --to 2026-04-30 --group day

# Show the last seven days as JSON
npm run --silent usage -- --last 7d --group day --json

# Find the 20 highest-token working directories
npm run usage -- --group cwd --sort total --desc --limit 20

# Sort models by event-time Standard API reference cost
npm run usage -- --group model --sort cost --desc --limit 20

# Count only the Windows current-session directory
npm run usage -- --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions

# Count Windows current and archived sessions explicitly
npm run usage -- --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/archived_sessions

# Combine local and Windows sources explicitly
npm run usage -- --sessions ~/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/sessions --sessions /mnt/c/Users/<WindowsUsername>/.codex/archived_sessions

# Export CSV
npm run --silent usage -- --group month --csv > codex_usage.csv

# Inspect per-file records without cross-file deduplication
npm run usage -- --dedupe-scope file
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
| `--asc`, `--desc` | Sort direction; date groups default to ascending and other groups to descending |
| `--limit N` | Maximum number of rows; `0` means unlimited |
| `--dedupe-scope VALUE` | `global` or `file`; defaults to `global` |
| `--timezone`, `--tz TZ` | Timezone for date grouping and `--today` |
| `--use-cache` | Reuse the Web dashboard's incremental SQLite index; included by `npm run usage`, while the direct CLI defaults to a full scan |
| `--cache-db PATH` | Select the SQLite index path and imply `--use-cache` |
| `--json` | Output JSON |
| `--csv` | Output CSV |
| `--no-refresh-pricing` | Skip network refresh and use the latest validated local catalog |
| `-h`, `--help` | Show help |

## Accounting semantics

Codex session files can contain duplicate cumulative `token_count` records in one file, and newer
rollout files can embed historical events. The tool first deduplicates cumulative-token vectors
within each file. The default `global` scope then deduplicates across files with an event fingerprint
built from the turn ID, six-field cumulative usage, and request delta. Subagent rollouts can copy
parent history while rewriting event timestamps but retaining the original turn IDs. Those copies
are counted once, while independent turns with identical usage remain distinct. Legacy records
without a reliable turn ID fall back to the event timestamp, and additionally use session/cwd/model
identity if the timestamp is also missing.

Direct Scan and SQLite prefer valid `token_count` event timestamps and choose the earliest among
them. Session creation times are used only when every copy lacks a valid event timestamp; completely
unknown times come last. Ties in time source and timestamp use the complete file path in binary order,
then event order within the file. Selection happens before date filtering, preventing a copy's write
time or session creation fallback from displacing the original and changing its month or price version.
Reversing `--sessions` arguments cannot change model, cwd, session, or cost attribution.

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
| `assumed_upper_bound_cost_usd` | Alternative assumed amount; field name retained, not a guaranteed billing cap |
| `reference_total_cost_usd` | Published-rate estimate plus assumption baseline |
| `reference_total_upper_bound_cost_usd` | Published-rate estimate plus alternative assumed amount |
| `priced_requests` | Requests matched to the price table |
| `assumed_requests` | Requests using an explicitly labelled route assumption |
| `assumed_total_tokens` | Tokens using an explicitly labelled route assumption |
| `unpriced_requests` | Requests with neither a published price nor an assumption route |
| `unpriced_total_tokens` | Tokens with neither a published price nor an assumption route |
| `provisional_priced_requests` | Requests priced with a provisional official-price baseline |
| `provisional_priced_total_tokens` | Tokens priced with a provisional official-price baseline |
| `provisional_estimated_cost_usd` | Portion of the published-rate estimate from provisional versions, already included in the total |
| `requests` | Number of token events, approximately the recorded request count |
| `sessions` | Number of Codex sessions included |

Cached input, cache-write input, and reasoning output are subsets; do not add them again to `total_tokens`.

## Cost estimation

Costs come from a versioned catalog of OpenAI API Standard text-token prices. Each timestamped event
selects the newest version whose effective time is not later than the event's UTC timestamp; an
event exactly on a boundary uses the new version. A truly timestamp-less event cannot safely select
a historical price version, so it remains in token totals but is marked unpriced. Legacy prices
without an authoritative effective date remain visible as `provisional` historical baselines.

The Web cost card shows the baseline API reference total: the published-rate estimate plus the
reference estimate for models without independent pricing. The latter appears as `+amount`, explicitly
marked as included in the baseline total. The indented amount with an unconfirmed historical effective
date is a subset of the published-rate estimate, already included in the total; do not add it again.
That subset may change when authoritative effective dates become available.

Expand “查看估算依据” (Estimate details) below the cost cards to see the calculation, historical-date
explanation, and each period's reference models and scenario amounts. The alternative total replaces
the assumed baseline component; the two scenarios are not additive and do not establish actual billing
bounds. These display changes preserve existing API fields and calculations, with no index rebuild.

The built-in catalog includes the following GPT-6 / 6.1 history. Effective dates follow the release
dates in the [official changelog](https://developers.openai.com/api/docs/changelog), recorded at UTC
midnight under the existing date convention. Rates come from the
[official pricing page](https://developers.openai.com/api/docs/pricing), in USD per million tokens;
each cell shows short-context → long-context pricing:

| Model | Effective date | Input | Cache reads | Cache writes (30 minutes) | Output |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-sol` | 2026-09-22 | 2 → 4 | 0.20 → 0.40 | 2.50 → 5 | 10 → 15 |
| `gpt-6-luna` | 2026-09-22 | 0.10 → 0.20 | 0.01 → 0.02 | 0.125 → 0.25 | 0.50 → 0.75 |
| `gpt-6.1-sol` | 2026-09-29 | 2 → 4 | 0.10 → 0.20 | 2.50 → 5 | 10 → 15 |
| `gpt-6.1-terra` | 2026-10-26 | 1 → 2 | 0.05 → 0.10 | 1.25 → 2.50 | 5 → 7.50 |

When a request exceeds 272,000 input tokens (including cached tokens), long-context rates apply to
all input, cache reads, cache writes, and output for that request. Exactly 272,000 input tokens still
uses short-context rates. Cache-write estimates use 30-minute rates; 12-hour writes are not modeled.
The parser accepts cache-write rows such as `Cache write` and `Cache writes`, using 30-minute rates. A provisional cache entry missing only cache-write rates is superseded by an earlier or equally effective formal version only when the page hash, other rates, and long-context threshold match. The old entry remains for audit; different prices or source content are preserved.
This pricing update reuses the existing SQLite log index and recalculates costs without rebuilding
the index. Restart any running Web server to load the new prices.

Built-in history lives at `pricing/openai-pricing.snapshot.json`. Runtime validation is stored as
`.codex-usage/pricing-history.json` beside the SQLite database. Web startup merges built-in and cached
prices without online validation by default. Set `CODEX_USAGE_PRICING_REFRESH=1` to validate prices
in the background after the startup index is published. Validation does not delay listening; the UI
updates prices and validation status on completion and shows fallback warnings on failure. Changes
to validation status alone reuse aggregation and cost caches.
The CLI still validates online before aggregation and output by default;
use `CODEX_USAGE_PRICING_REFRESH=0` or `--no-refresh-pricing` to disable it. `--help` stays offline. Refreshes
use at most six concurrent requests, an eight-second overall timeout, and conditional
`ETag`/`Last-Modified` requests. Successful models are still updated when only some pages fail;
failed models keep their most recently validated versions. A fully offline refresh falls back to the
local catalog.

Runtime cache updates use a lock file, a same-directory temporary file, and an atomic rename. A
corrupt runtime cache is first preserved as `.corrupt-<timestamp>` before falling back to the built-in
catalog; an invalid built-in catalog fails startup explicitly.

```text
published-rate estimate =
  (ordinary input * input rate
   + cache reads * cached-input rate
   + cache writes * cache-write rate
   + output * output rate) / 1,000,000

reference baseline = published-rate estimate + assumed baseline
alternative total = published-rate estimate + alternative assumed amount
```

These values are event-time Standard API-equivalent references, not ChatGPT subscription charges,
Codex credits, or actual billing. They exclude Batch, Flex, Fast, Ultrafast, regional uplifts, taxes, and
account-specific discounts.

`codex-auto-review` has no independently published price and never contributes to
`estimated_cost_usd`. Its labelled reference route uses GPT-5.4 Thinking with low reasoning as the
baseline from 2026-04-23, then GPT-5.6 Luna from 2026-07-30 with lower evidence; GPT-5.6 Sol is the
alternative reference in both periods (retaining the `upperBoundModel` field name). Cross-period
results expose each route separately in `assumedModels[].routes`.

Refresh the runtime catalog or inspect changes without writing:

```bash
npm run update-pricing
npm run update-pricing -- --check
```

`--check` reports differences without writing the pricing cache. A normal update writes the local
price catalog; restart any running Web server to use the updated prices.

After verifying an authoritative effective date, seed a formal built-in version:

```bash
npm run update-pricing -- \
  --seed \
  --model gpt-5.6-terra \
  --effective-from 2026-07-30 \
  --source-url https://openai.com/index/gpt-5-6/
```

The updater and startup refresh share the same strict parser: it reads only `Pricing / Text tokens`
and requires the page's `Model ID` to match exactly. A formal version retains the replaced
first-observed provisional record for audit, while selectors ignore superseded versions.
On upgrade, a formal version also replaces an incomplete provisional parse when its page hash and
short-context rates match, only the long-context information is missing, and the formal effective
date is no later than the observation's effective date. This correction does not supersede history
with different page content or short-context rates.

Primary references:

- `https://developers.openai.com/api/docs/models/<model>.md`
- <https://openai.com/index/gpt-5-6/>
- <https://alignment.openai.com/auto-review/>

## Web environment variables

Port precedence is command-line `--port`/`-p`, then `PORT`, then `CODEX_USAGE_PORT`, and finally
the default `8787`. An explicitly selected port fails fast if it cannot be bound, so scripts and
reverse proxies do not silently switch ports. Without an explicit port, an unavailable or reserved
`8787` falls back to `9787`, `3000`, and `5000`, then asks the operating system for a temporary port;
the actual URL is printed to the console. Port values must be integers from `0` through `65535`;
`0` requests an operating-system-assigned temporary port.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Web port; takes precedence over `CODEX_USAGE_PORT` |
| `CODEX_USAGE_PORT` | `8787` | Web port |
| `HOST` | `127.0.0.1` | Listen address; the server has no authentication, so do not bind `0.0.0.0` or expose it to an untrusted network |
| `CODEX_USAGE_DB` | `.codex-usage/cache.sqlite` | SQLite index path |
| `CODEX_USAGE_PRICING_CACHE` | `pricing-history.json` beside the database | Runtime versioned pricing catalog |
| `CODEX_USAGE_PRICING_TIMEOUT_MS` | `8000` | Overall startup pricing-refresh timeout in milliseconds |
| `CODEX_USAGE_PRICING_REFRESH` | Web: `0`; CLI: `1` | Set to `1` to enable online validation at Web startup, or `0` to disable it for the CLI |
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

Explicitly select multiple source directories:

```bash
CODEX_USAGE_SESSIONS="$HOME/.codex/sessions:/mnt/c/Users/<WindowsUsername>/.codex/sessions:/mnt/c/Users/<WindowsUsername>/.codex/archived_sessions" npm run web
```

## API

The web server exposes:

```text
GET /api/usage
GET /api/index/status
POST /api/index/refresh?async=1
POST /api/index/refresh
```

`GET /api/usage` is snapshot-only by default and does not refresh the index. The compatibility
parameter `refreshIndex=1` can still explicitly refresh before returning the query. New callers
can use `POST /api/index/refresh?async=1`, which returns `202` with current status immediately.
Repeated requests for the same roots share the running job; different scopes serialize. Omitting
`async=1` preserves synchronous refresh and existing query parameter semantics.

`GET /api/index/status` accepts `sourceScope` and returns `state`, `phase`, `running`, `hasSnapshot`,
`incomplete`, `revision`, `publishedAt`, `pendingFiles`, `completedFiles`, `scannedBytes`, `decodedBytes`,
`failedFiles`, and `failures`. Pending counts are unknown during discovery and count changed files.
Failures contain paths, signatures, error details, attempt times, `retainedPaths`, and
`usingPreviousIndex`. The `index` field in `/api/usage` carries the same status without removing
existing statistics. Published revisions invalidate query/cost caches, including changes published
by another process.
Status also includes `pricingRefresh: { running, revision }`. `running` covers the startup price check
both while waiting for indexing and while validating. `revision` increments when that phase settles,
is local to the server process, and resets on restart. It is independent of index and rate versions,
so the UI updates even when rates stay unchanged or validation fails. Query cache hits always carry
current `pricing` metadata.

Common query parameters:

| Parameter | Example | Description |
| --- | --- | --- |
| `range` | `all`, `today`, `24h`, `7d`, `30d`, `12w`, `custom` | Time range; rolling ranges update by minute |
| `sourceScope` | `all`, `local`, `wsl`, `windows` | Source scope; `local` is retained for compatibility, while `wsl` and `windows` select explicit environments |
| `from` | `2026-04-01` | Start date for `range=custom` |
| `to` | `2026-04-30` | End date for `range=custom` |
| `group` | `day` | Grouping mode |
| `sort` | `total` | Sort field |
| `asc` / `desc` | `1` | Sort direction |
| `limit` | `60` | Number of output rows |
| `dedupeScope` | `global` | Deduplication scope |
| `refreshIndex` | `0`, `1` | Compatibility parameter; omitted/`0` reads the snapshot, while `1` refreshes before querying |

The default `refreshIndex` behavior is equivalent to `0`; `1` is the temporary compatibility alias
described above. Rolling ranges use one-minute time buckets, and `today` changes at midnight in the
target timezone.

Example:

```text
http://127.0.0.1:8787/api/usage?range=30d&group=day&sort=key&desc=1&limit=60&dedupeScope=global
```

The response keeps existing fields and adds `assumedModels`, `unpricedModels`, provisional-price
totals, and event-time catalog metadata such as `pricing.mode = "event-time"`, `checkedAt`,
`latestEffectiveFrom`, `refreshStatus`, and `usedFallback`. Performance metadata includes
`indexRefreshSkipped`, `queryCacheHit`, `costCacheHit`, `scanDurationMs`, `dedupeDurationMs`,
`aggregationDurationMs`, `totalDurationMs`, `incrementalFiles`, `fullRescanFiles`, `scannedBytes`, `decodedBytes`, `failedFiles`,
`unknownTimestampEvents`, `unknownTimestampTokens`, `excludedUnknownTimestampEvents`, and
`excludedUnknownTimestampTokens`. On a result-cache hit, phase durations are zero and
`totalDurationMs` measures the current request.

## Project structure

```text
.
├── bin/
│   ├── codex-token-usage.mjs      # Public CLI entry point
│   ├── codex-token-usage-core.mjs # Options, sources, and shared utilities
│   ├── codex-usage-server.mjs     # Local Web server and background scanning
│   ├── session-scanner.mjs        # Resumable incremental JSONL scanner
│   ├── usage-aggregation.mjs      # Direct/cache-consistent aggregation and CLI output
│   ├── usage-index.mjs            # SQLite index, migrations, and costed slices
│   ├── usage-index-view.mjs       # Unknown-time correctness layer for index queries
│   ├── usage-canonical.mjs        # Persistent global deduplication scopes
│   ├── usage-query.mjs            # Read-only query LRU and cache path
│   ├── openai-pricing.mjs         # Pricing catalog service entry point
│   ├── pricing-catalog.mjs        # Version selection and event-time pricing
│   ├── pricing-refresh.mjs        # Official model Markdown validation and runtime cache
│   └── update-pricing.mjs         # Manual pricing updater
├── pricing/
│   └── openai-pricing.snapshot.json # Built-in versioned price history
├── public/
│   ├── index.html                 # Dashboard page
│   ├── app.js                     # Front-end interaction, charts, and table rendering
│   └── styles.css                 # Page styles
├── test/                           # Pricing, refresh, and aggregation boundary tests
├── .github/                        # CI, Dependabot, and issue/PR templates
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

## Open-source collaboration

- Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md).
- Private vulnerability reports: [SECURITY.md](SECURITY.md).
- Community standards: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- This project only processes local Codex logs; never commit session JSONL files, SQLite databases,
  prompts, credentials, or other personal data.

## FAQ

### Why do historical totals increase after opening the dashboard?

Web displays the published snapshot first, then fills in compressed history in the background.
The first scan must decompress historical files; an incomplete-history notice remains visible until
publication. Unchanged compressed files subsequently reuse the cache. Ordinary scanner version 6
is preserved; only older parser caches need an upgrade scan.

### What happens when a file cannot be read?

CLI prints available statistics, lists failures on stderr, and exits with code `2` for incomplete
results (`1` means the command failed). JSON/CSV stdout remains parseable. Rerun the same command to
retry. Cached mode retains prior data for failed files; a stateless scan includes only files read
successfully in that run. Web exposes failure details and a retry button, also available through the
asynchronous refresh API.

### Does the tool upload session content?

No. It reads local JSONL files only and serves the dashboard on `127.0.0.1`. Web startup skips online
price validation by default. Default CLI validation, explicitly enabled Web startup validation, and
manual price updates request fixed `developers.openai.com` model Markdown URLs without sending session content.

### Why do global and file deduplication differ?

`global` deduplicates across all scanned files and is recommended for long-term totals. `file`
deduplicates only inside each JSONL file and is useful for inspecting raw file records.

### Why is the web dashboard faster after the first run?

`npm run usage` reuses the incremental index by default. The direct CLI scans JSONL by default and
can reuse the index with `--use-cache`. Web filters send
`refreshIndex=0` and reuse SQLite, persisted canonical events, one costed slice, and up to 64 query
results. Only the startup background check and **Refresh index** inspect session files.

## Development validation

The scan benchmark uses synthetic logs and at least five fresh-process runs. It reports median
duration, peak RSS, source/decoded bytes, and API latency during scanning:

```bash
npm run benchmark:scan
node bin/benchmark-session-scan.mjs --runs=5 --sizes=8,32,128
```

See the [validation record](docs/compressed-scan-validation.md) for measured results.

It covers cold indexing, unchanged reruns, a plain-file append, and changing one compressed file.
The size sweep keeps the usage-event count fixed while increasing irrelevant MiB per compressed
file. Assertions require zero warm read/decode bytes, no compressed rescans for plain appends, and
HTTP responses before cold scanning completes. See CI for runtime and platform coverage.

Install dependencies and run the complete check:

```bash
npm ci
npm run check
```

The syntax check covers the CLI, core, server, options, source discovery, scanner, index, pricing,
query, and front-end modules:

```bash
npm run check:syntax
```

Functional smoke and benchmark checks:

```bash
npm run smoke
npm run benchmark:index
node ./bin/codex-token-usage.mjs --group month --limit 1
node ./bin/codex-token-usage.mjs --group month --limit 1 --csv
```

The explicit syntax commands are useful when diagnosing one module:

```bash
node --check bin/codex-token-usage.mjs
node --check bin/codex-token-usage-core.mjs
node --check bin/codex-usage-server.mjs
node --check bin/date-bound-argv.mjs
node --check bin/openai-pricing.mjs
node --check bin/path-utils.mjs
node --check bin/pricing-catalog.mjs
node --check bin/pricing-refresh.mjs
node --check bin/server-port.mjs
node --check bin/session-sources.mjs
node --check bin/session-scanner.mjs
node --check bin/update-pricing.mjs
node --check bin/usage-aggregation.mjs
node --check bin/usage-canonical.mjs
node --check bin/usage-costs.mjs
node --check bin/usage-index.mjs
node --check bin/usage-index-view.mjs
node --check bin/usage-options.mjs
node --check bin/usage-query.mjs
node --check bin/usage-values.mjs
node --check public/app.js
git diff --check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.
