import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { findJsonlFiles } from "./codex-token-usage-core.mjs";
import { isCompressedSessionFile, SESSION_SCANNER_VERSION } from "./session-scanner.mjs";
import { sqlPathFilter } from "./path-utils.mjs";

const FILE_COLUMNS = "path,size,mtime_ms,events_count,duplicate_token_events,parse_errors,raw_token_events,scanned_at_ms,scan_offset,parser_state_json,scanner_version,file_dev,file_ino,boundary_hash";
const EVENT_COLUMNS = "file_path,event_index,timestamp_ms,has_event_timestamp,session_created_at_ms,session_id,total_usage_key,cwd,model,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens";
const STAGING_TABLES = ["refresh_files", "refresh_events", "refresh_changes", "refresh_failures", "refresh_scope_paths"];

export function pathInRoots(file, roots) {
  const resolved = path.resolve(file);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function identity(file) {
  const plainPath = path.resolve(file).replace(/\.zst$/, "");
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(plainPath);
  // Rollouts can move into the archive directory. Generic custom filenames
  // have no stable identity across directories, so only match their exact path.
  return uuid ? `session:${uuid[1].toLowerCase()}` : plainPath;
}

function signature(info) {
  return info ? JSON.stringify([info.size, info.mtimeMs, info.dev, info.ino]) : null;
}

function unchanged(cached, info) {
  return cached && Number(cached.scanner_version) === SESSION_SCANNER_VERSION &&
    Number(cached.size) === info.size && Math.abs(Number(cached.mtime_ms) - info.mtimeMs) < 0.001 &&
    String(cached.file_dev) === info.dev && String(cached.file_ino) === info.ino;
}

async function fileInfo(filePath) {
  const value = await stat(filePath);
  return { filePath, size: value.size, mtimeMs: value.mtimeMs, dev: String(value.dev), ino: String(value.ino) };
}

export async function refreshUsageIndex(index, roots, { retryFailures, signal, onProgress }) {
  const startedAt = Date.now();
  const baseRevision = index.db.prepare("SELECT revision FROM index_publication WHERE id = 1").get().revision;
  const progress = { phase: "discover", completedFiles: 0, scannedBytes: 0, decodedBytes: 0, failedFiles: 0 };
  let lastProgressAt = 0;
  function report(force = false) {
    Object.assign(index.activity, progress);
    if (onProgress && (force || Date.now() - lastProgressAt >= 250)) {
      lastProgressAt = Date.now();
      onProgress({ ...progress });
    }
  }
  report(true);
  const paths = new Set();
  for (const root of roots) {
    signal.throwIfAborted();
    for (const file of await findJsonlFiles(root)) paths.add(file);
  }
  const known = new Map(index.statements.allFiles.all().filter((row) => pathInRoots(row.path, roots)).map((row) => [row.path, row]));
  const priorFailures = new Map(index.db.prepare("SELECT * FROM scan_failures").all()
    .filter((row) => pathInRoots(row.path, roots)).map((row) => [row.path, row]));
  Object.assign(progress, { phase: "check", files: paths.size });
  report(true);

  try {
    for (const table of STAGING_TABLES) index.db.exec(`DROP TABLE IF EXISTS temp.${table}`);
    index.db.exec(`
      CREATE TEMP TABLE refresh_files AS SELECT ${FILE_COLUMNS} FROM files WHERE 0;
      CREATE TEMP TABLE refresh_events AS SELECT ${EVENT_COLUMNS} FROM events WHERE 0;
      CREATE TEMP TABLE refresh_failures AS SELECT * FROM scan_failures WHERE 0;
      CREATE TEMP TABLE refresh_changes (path TEXT PRIMARY KEY, mode TEXT NOT NULL);
      CREATE TEMP TABLE refresh_scope_paths (path TEXT PRIMARY KEY);
    `);
    const stageScopePath = index.db.prepare("INSERT OR IGNORE INTO refresh_scope_paths VALUES (?)");
    for (const file of new Set([...paths, ...known.keys(), ...priorFailures.keys()])) stageScopePath.run(file);
    const stageChange = index.db.prepare("INSERT INTO refresh_changes VALUES (?, ?)");
    const stageFile = index.db.prepare("INSERT INTO refresh_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const stageEvent = index.db.prepare(`INSERT INTO refresh_events (${EVENT_COLUMNS}) VALUES (${Array(15).fill("?").join(",")})`);
    const stageFailure = index.db.prepare("INSERT INTO refresh_failures VALUES (?, ?, ?, ?, ?, ?)");
    const failures = [];
    function fail(file, info, error, previous = null) {
      const retainedPaths = [...known.keys()].filter((old) => old === file || (!paths.has(old) && identity(old) === identity(file)));
      const row = {
        path: file, signature: signature(info), code: error.code || "LOG_READ_FAILED",
        message: String(error.message || error), attemptedAt: previous?.attempted_at_ms ?? Date.now(),
        retainedPaths,
      };
      stageFailure.run(file, row.signature, row.code, row.message, row.attemptedAt, JSON.stringify(retainedPaths));
      failures.push(row);
      index.pendingFailures = failures;
      progress.failedFiles = failures.length;
    }

    let changedFiles = 0, incrementalFiles = 0, fullRescanFiles = 0;
    const infos = [];
    await runLimited([...paths], 32, async (file) => {
      try { infos.push(await fileInfo(file)); }
      catch (error) { fail(file, null, error); }
    }, signal);
    const pending = [];
    let skippedFailures = 0;
    for (const info of infos) {
      const failure = priorFailures.get(info.filePath);
      if (!retryFailures && failure?.signature === signature(info)) {
        fail(info.filePath, info, { code: failure.error_code, message: failure.message }, failure);
        skippedFailures += 1;
      } else if (!unchanged(known.get(info.filePath), info) || failure) {
        pending.push(info);
      }
    }
    Object.assign(progress, {
      phase: "scan", pendingFiles: pending.length, cacheFiles: infos.length - pending.length - skippedFailures,
      newFiles: pending.filter((info) => !known.has(info.filePath)).length,
      upgradeFiles: pending.filter((info) => known.has(info.filePath) && Number(known.get(info.filePath).scanner_version) !== SESSION_SCANNER_VERSION).length,
      incrementalFiles: 0, fullRescanFiles: 0,
    });
    progress.modifiedFiles = pending.length - progress.newFiles - progress.upgradeFiles;
    report(true);
    await runLimited(pending, index.scanConcurrency, async (info) => {
      const cached = known.get(info.filePath);
      let readBytes = 0, decodedBytes = 0, result;
      try {
        result = await scanChangedFile(index, info, cached, signal, (bytes, detail = {}) => {
          progress.scannedBytes += bytes - readBytes;
          progress.decodedBytes += Number(detail.decodedBytes ?? bytes) - decodedBytes;
          readBytes = bytes;
          decodedBytes = Number(detail.decodedBytes ?? bytes);
          report();
        });
        const after = await fileInfo(info.filePath);
        const compressed = isCompressedSessionFile(info.filePath);
        if (after.dev !== info.dev || after.ino !== info.ino || after.size < info.size ||
            ((compressed || after.size === info.size) && after.mtimeMs !== info.mtimeMs)) {
          throw Object.assign(new Error("Log changed while it was being scanned; retry the refresh."), { code: "LOG_CHANGED" });
        }
      } catch (error) {
        signal.throwIfAborted();
        fail(info.filePath, info, error);
        progress.completedFiles += 1;
        report();
        return;
      }
      // Database failures deliberately escape the per-file read-error handler.
      const { scanned, mode, boundaryHash } = result;
      const append = mode === "append";
      stageChange.run(info.filePath, mode);
      stageFile.run(info.filePath, info.size, info.mtimeMs,
        (append ? cached.events_count : 0) + scanned.events.length,
        (append ? cached.duplicate_token_events : 0) + scanned.stats.duplicateTokenEvents,
        (append ? cached.parse_errors : 0) + scanned.stats.parseErrors,
        (append ? cached.raw_token_events : 0) + scanned.stats.tokenEvents,
        Date.now(), scanned.processedOffset,
        isCompressedSessionFile(info.filePath) ? null : JSON.stringify(scanned.state),
        SESSION_SCANNER_VERSION, info.dev, info.ino, boundaryHash);
      for (let n = 0; n < scanned.events.length; n += 1) {
        const event = scanned.events[n], usage = event.usage;
        stageEvent.run(info.filePath, (append ? cached.events_count : 0) + n,
          event.timestampMs ?? null, event.hasEventTimestamp ? 1 : 0, event.sessionCreatedAtMs ?? null, event.sessionId,
          event.totalUsageKey, event.cwd, event.model, usage.input_tokens, usage.cached_input_tokens,
          usage.cache_write_input_tokens, usage.output_tokens, usage.reasoning_output_tokens, usage.total_tokens);
        if ((n + 1) % 500 === 0) { await yieldToLoop(); signal.throwIfAborted(); }
      }
      changedFiles += 1;
      if (append) incrementalFiles += 1; else fullRescanFiles += 1;
      Object.assign(progress, { completedFiles: progress.completedFiles + 1, incrementalFiles, fullRescanFiles });
      report();
      await yieldToLoop();
    }, signal, true, (error) => index.controller.abort(error));
    const retained = new Set(failures.flatMap((failure) => failure.retainedPaths));
    let deletedFiles = 0;
    for (const file of known.keys()) {
      if (!paths.has(file) && !retained.has(file)) { stageChange.run(file, "delete"); deletedFiles += 1; }
    }
    progress.done = true;
    report(true);
    progress.phase = "publish";
    report(true);
    signal.throwIfAborted();
    publish(index, baseRevision);
    return {
      changedFiles, deletedFiles, incrementalFiles, fullRescanFiles,
      cacheFiles: progress.cacheFiles,
      scannedBytes: progress.scannedBytes, decodedBytes: progress.decodedBytes,
      scanDurationMs: Date.now() - startedAt, failedFiles: failures.length,
    };
  } finally {
    for (const table of STAGING_TABLES) index.db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}

function publish(index, baseRevision) {
  const db = index.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT revision FROM index_publication WHERE id = 1").get().revision !== baseRevision) {
      throw Object.assign(new Error("Another process published an index during this refresh; retry."), { code: "INDEX_PUBLICATION_CONFLICT" });
    }
    for (const scope of db.prepare("SELECT scope_id, roots_json FROM dedupe_scopes").all()) {
      const filter = sqlPathFilter("c.path", JSON.parse(scope.roots_json));
      const changed = db.prepare(`SELECT 1 FROM refresh_changes c WHERE ${filter.sql} LIMIT 1`).get(...filter.params);
      if (!changed) continue;
      db.prepare(`INSERT OR IGNORE INTO canonical_dirty_keys
        SELECT ?, e.total_usage_key FROM events e JOIN refresh_changes c ON c.path = e.file_path
        WHERE c.mode IN ('full', 'delete') AND ${filter.sql}
        UNION SELECT ?, e.total_usage_key FROM refresh_events e JOIN refresh_changes c ON c.path = e.file_path
        WHERE ${filter.sql}`).run(scope.scope_id, ...filter.params, scope.scope_id, ...filter.params);
      db.prepare("INSERT OR IGNORE INTO canonical_dirty_scopes VALUES (?)").run(scope.scope_id);
    }
    db.exec(`
      DELETE FROM events WHERE file_path IN (SELECT path FROM refresh_changes WHERE mode IN ('full', 'delete'));
      INSERT INTO events (${EVENT_COLUMNS}) SELECT ${EVENT_COLUMNS} FROM refresh_events;
      DELETE FROM files WHERE path IN (SELECT path FROM refresh_changes);
      INSERT INTO files (${FILE_COLUMNS}) SELECT ${FILE_COLUMNS} FROM refresh_files;
      DELETE FROM scan_failures WHERE path IN (SELECT path FROM refresh_scope_paths);
      INSERT INTO scan_failures SELECT * FROM refresh_failures;
    `);
    db.prepare("UPDATE index_publication SET revision = revision + 1, published_at_ms = ?, has_snapshot = 1 WHERE id = 1").run(Date.now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function scanChangedFile(index, info, cached, signal, onProgress) {
  const compressed = isCompressedSessionFile(info.filePath);
  let savedState;
  try { savedState = JSON.parse(cached?.parser_state_json || "null"); } catch { savedState = null; }
  const canAppend = !compressed && cached && info.size > cached.size &&
    cached.scanner_version === SESSION_SCANNER_VERSION && savedState?.scannerVersion === SESSION_SCANNER_VERSION &&
    String(cached.file_dev) === info.dev && String(cached.file_ino) === info.ino &&
    Number.isSafeInteger(cached.scan_offset) && cached.scan_offset >= 0 && cached.scan_offset <= cached.size &&
    await boundaryHash(info.filePath, cached.scan_offset) === cached.boundary_hash;
  const scanned = await index.scanFileImpl(info.filePath, {
    endOffset: info.size, onProgress, signal,
    ...(canAppend ? {
      startOffset: cached.scan_offset, state: savedState,
      seenTotals: new Set(index.statements.fileKeys.all(info.filePath).map((row) => row.total_usage_key)),
    } : {}),
  });
  return { scanned, mode: canAppend ? "append" : "full",
    boundaryHash: compressed ? null : await boundaryHash(info.filePath, scanned.processedOffset) };
}

async function boundaryHash(file, offset) {
  const length = Math.min(64 * 1024, offset), hash = createHash("sha256");
  if (length === 0) return hash.digest("hex");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    return hash.update(buffer.subarray(0, bytesRead)).digest("hex");
  } finally { await handle.close(); }
}

// Pick eligible jobs instead of occupying general workers while waiting for a
// compression slot. A fatal staging error drains all workers before cleanup.
async function runLimited(items, limit, mapper, signal, limitCompressed = false, onFatal = () => {}) {
  const pending = [...items];
  const active = new Set();
  let compressedActive = 0, fatal = null;
  while (pending.length || active.size) {
    if (signal.aborted && !fatal) fatal = signal.reason;
    while (!fatal && active.size < limit && pending.length) {
      const i = pending.findIndex((item) => !limitCompressed || !isCompressedSessionFile(item.filePath) || compressedActive < 2);
      if (i < 0) break;
      const item = pending.splice(i, 1)[0];
      const compressed = limitCompressed && isCompressedSessionFile(item.filePath);
      if (compressed) compressedActive += 1;
      const job = Promise.resolve().then(() => mapper(item)).catch((error) => { fatal ||= error; onFatal(error); }).finally(() => {
        active.delete(job);
        if (compressed) compressedActive -= 1;
      });
      active.add(job);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  if (fatal) throw fatal;
}
