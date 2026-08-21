import { createHash } from "node:crypto";
import path from "node:path";

const MAX_CACHED_SCOPES = 8;

export const CANONICAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS dedupe_scopes (
    scope_id TEXT PRIMARY KEY,
    roots_json TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    last_used_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dedupe_scope_roots (
    scope_id TEXT NOT NULL,
    root TEXT NOT NULL,
    PRIMARY KEY (scope_id, root)
  );

  CREATE TABLE IF NOT EXISTS canonical_events (
    scope_id TEXT NOT NULL,
    total_usage_key TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    PRIMARY KEY (scope_id, total_usage_key)
  );

  CREATE INDEX IF NOT EXISTS idx_canonical_scope_event
    ON canonical_events(scope_id, event_id);

  CREATE TABLE IF NOT EXISTS canonical_dirty_keys (
    scope_id TEXT NOT NULL,
    total_usage_key TEXT NOT NULL,
    PRIMARY KEY (scope_id, total_usage_key)
  );

  CREATE TABLE IF NOT EXISTS canonical_dirty_scopes (
    scope_id TEXT PRIMARY KEY
  );
`;

function canonicalRoots(sessionsDirs) {
  return Array.from(new Set((sessionsDirs || []).map((dir) => path.resolve(dir)))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function canonicalScopeId(roots) {
  return createHash("sha256").update(JSON.stringify(roots)).digest("hex");
}

export function markCanonicalChange(db, filePath, totalUsageKeys) {
  const keys = Array.from(new Set(totalUsageKeys || []));

  const scopes = new Map();
  for (const row of db.prepare("SELECT scope_id, root FROM dedupe_scope_roots").all()) {
    const roots = scopes.get(row.scope_id) || [];
    roots.push(row.root);
    scopes.set(row.scope_id, roots);
  }

  const matchingScopes = Array.from(scopes.entries())
    .filter(([, roots]) => filePathInRoots(filePath, roots))
    .map(([scopeId]) => scopeId);
  if (matchingScopes.length === 0) return 0;

  const insert = db.prepare(
    "INSERT OR IGNORE INTO canonical_dirty_keys (scope_id, total_usage_key) VALUES (?, ?)",
  );
  const markScope = db.prepare("INSERT OR IGNORE INTO canonical_dirty_scopes (scope_id) VALUES (?)");
  let inserted = 0;
  for (const scopeId of matchingScopes) {
    markScope.run(scopeId);
    for (const key of keys) {
      inserted += Number(insert.run(scopeId, key).changes || 0);
    }
  }
  return inserted;
}

export function ensureCanonicalScope(db, sessionsDirs) {
  const startedAt = performance.now();
  const roots = canonicalRoots(sessionsDirs);
  const scopeId = canonicalScopeId(roots);
  const rootsJson = JSON.stringify(roots);
  const fingerprint = sourceFingerprint(db, roots);
  const existing = db.prepare("SELECT * FROM dedupe_scopes WHERE scope_id = ?").get(scopeId);
  const dirtyKeys = existing
    ? Number(
        db.prepare("SELECT COUNT(*) AS count FROM canonical_dirty_keys WHERE scope_id = ?").get(scopeId)
          .count || 0,
      )
    : 0;
  const trackedChange = existing
    ? Boolean(db.prepare("SELECT 1 FROM canonical_dirty_scopes WHERE scope_id = ?").get(scopeId))
    : false;

  let rebuilt = false;
  let updatedKeys = 0;
  if (!existing || existing.roots_json !== rootsJson) {
    updatedKeys = rebuildScope(db, scopeId, roots, rootsJson, fingerprint);
    rebuilt = true;
  } else if (existing.source_fingerprint !== fingerprint && !trackedChange) {
    updatedKeys = rebuildScope(db, scopeId, roots, rootsJson, fingerprint);
    rebuilt = true;
  } else if (dirtyKeys > 0) {
    updatedKeys = repairScope(db, scopeId, roots, fingerprint, dirtyKeys);
  } else if (trackedChange) {
    acknowledgeTrackedChange(db, scopeId, fingerprint);
  } else {
    db.prepare("UPDATE dedupe_scopes SET last_used_at_ms = ? WHERE scope_id = ?").run(Date.now(), scopeId);
  }

  evictOldScopes(db, scopeId);
  const canonicalEvents = Number(
    db.prepare("SELECT COUNT(*) AS count FROM canonical_events WHERE scope_id = ?").get(scopeId).count || 0,
  );
  return {
    scopeId,
    canonicalEvents,
    canonicalRebuilt: rebuilt,
    canonicalUpdatedKeys: updatedKeys,
    dedupeDurationMs: Math.round(performance.now() - startedAt),
  };
}

function rebuildScope(db, scopeId, roots, rootsJson, fingerprint) {
  const filter = filePathFilter("e.file_path", roots);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM canonical_events WHERE scope_id = ?").run(scopeId);
    db.prepare("DELETE FROM canonical_dirty_keys WHERE scope_id = ?").run(scopeId);
    db.prepare("DELETE FROM canonical_dirty_scopes WHERE scope_id = ?").run(scopeId);
    db.prepare("DELETE FROM dedupe_scope_roots WHERE scope_id = ?").run(scopeId);
    db.prepare("DELETE FROM dedupe_scopes WHERE scope_id = ?").run(scopeId);
    db.prepare(
      `INSERT INTO dedupe_scopes (scope_id, roots_json, source_fingerprint, last_used_at_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(scopeId, rootsJson, fingerprint, Date.now());
    const insertRoot = db.prepare("INSERT INTO dedupe_scope_roots (scope_id, root) VALUES (?, ?)");
    for (const root of roots) {
      insertRoot.run(scopeId, root);
    }

    const inserted = db
      .prepare(
        `INSERT INTO canonical_events (scope_id, total_usage_key, event_id)
         SELECT ?, total_usage_key, id
         FROM (
           SELECT
             e.id,
             e.total_usage_key,
             ROW_NUMBER() OVER (
               PARTITION BY e.total_usage_key
               ORDER BY e.file_path, e.event_index
             ) AS rn
           FROM events e
           WHERE ${filter.sql}
         ) ranked
         WHERE rn = 1`,
      )
      .run(scopeId, ...filter.params);
    db.exec("COMMIT");
    return Number(inserted.changes || 0);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function repairScope(db, scopeId, roots, fingerprint, dirtyKeys) {
  const filter = filePathFilter("e.file_path", roots);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `DELETE FROM canonical_events
       WHERE scope_id = ?
         AND total_usage_key IN (
           SELECT total_usage_key FROM canonical_dirty_keys WHERE scope_id = ?
         )`,
    ).run(scopeId, scopeId);
    db.prepare(
      `INSERT INTO canonical_events (scope_id, total_usage_key, event_id)
       SELECT ?, total_usage_key, id
       FROM (
         SELECT
           e.id,
           e.total_usage_key,
           ROW_NUMBER() OVER (
             PARTITION BY e.total_usage_key
             ORDER BY e.file_path, e.event_index
           ) AS rn
         FROM events e
         INNER JOIN canonical_dirty_keys dirty
           ON dirty.scope_id = ?
          AND dirty.total_usage_key = e.total_usage_key
         WHERE ${filter.sql}
       ) ranked
       WHERE rn = 1`,
    ).run(scopeId, scopeId, ...filter.params);
    db.prepare("DELETE FROM canonical_dirty_keys WHERE scope_id = ?").run(scopeId);
    db.prepare("DELETE FROM canonical_dirty_scopes WHERE scope_id = ?").run(scopeId);
    db.prepare(
      `UPDATE dedupe_scopes
       SET source_fingerprint = ?, last_used_at_ms = ?
       WHERE scope_id = ?`,
    ).run(fingerprint, Date.now(), scopeId);
    db.exec("COMMIT");
    return dirtyKeys;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function acknowledgeTrackedChange(db, scopeId, fingerprint) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM canonical_dirty_scopes WHERE scope_id = ?").run(scopeId);
    db.prepare(
      `UPDATE dedupe_scopes
       SET source_fingerprint = ?, last_used_at_ms = ?
       WHERE scope_id = ?`,
    ).run(fingerprint, Date.now(), scopeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function sourceFingerprint(db, roots) {
  const filter = filePathFilter("path", roots);
  const rows = db
    .prepare(
      `SELECT path, size, mtime_ms, events_count, scanned_at_ms
       FROM files
       WHERE ${filter.sql}
       ORDER BY path`,
    )
    .all(...filter.params);
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(
      `${row.path}\0${row.size}\0${row.mtime_ms}\0${row.events_count}\0${row.scanned_at_ms}\n`,
    );
  }
  return hash.digest("hex");
}

function evictOldScopes(db, currentScopeId) {
  const stale = db
    .prepare(
      `SELECT scope_id
       FROM dedupe_scopes
       WHERE scope_id <> ?
       ORDER BY last_used_at_ms DESC
       LIMIT -1 OFFSET ?`,
    )
    .all(currentScopeId, MAX_CACHED_SCOPES - 1);
  if (stale.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const deleteCanonical = db.prepare("DELETE FROM canonical_events WHERE scope_id = ?");
    const deleteDirty = db.prepare("DELETE FROM canonical_dirty_keys WHERE scope_id = ?");
    const deleteDirtyScope = db.prepare("DELETE FROM canonical_dirty_scopes WHERE scope_id = ?");
    const deleteRoots = db.prepare("DELETE FROM dedupe_scope_roots WHERE scope_id = ?");
    const deleteScope = db.prepare("DELETE FROM dedupe_scopes WHERE scope_id = ?");
    for (const { scope_id: scopeId } of stale) {
      deleteCanonical.run(scopeId);
      deleteDirty.run(scopeId);
      deleteDirtyScope.run(scopeId);
      deleteRoots.run(scopeId);
      deleteScope.run(scopeId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function filePathInRoots(filePath, roots) {
  const resolved = path.resolve(filePath);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function filePathFilter(column, roots) {
  const parts = [];
  const params = [];
  for (const root of roots) {
    parts.push(`(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`);
    params.push(root, `${escapeLike(root)}${path.sep}%`);
  }
  return {
    sql: parts.length ? `(${parts.join(" OR ")})` : "1 = 0",
    params,
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}
