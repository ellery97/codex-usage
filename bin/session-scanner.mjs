import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  diffUsage,
  hasUsage,
  normalizeUsage,
  usageEventFingerprint,
  usageKey,
  usageZero,
} from "./usage-values.mjs";

export const SESSION_SCANNER_VERSION = 4;
const EVENT_KEY_SEPARATOR = "|";
const UNKNOWN_CWD = "(unknown cwd)";
const UNKNOWN_MODEL = "(unknown model)";
const CONTEXT_FIELDS = ["sessionId", "sessionCreatedAtMs", "cwd", "model"];

function sessionIdFromPath(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return match ? match[1] : base;
}

export async function scanSessionFile(filePath) {
  return scanSessionFileRange(filePath);
}

function emptyContextFlags() {
  return {
    sessionId: false,
    sessionCreatedAtMs: false,
    cwd: false,
    model: false,
  };
}

function initialSessionScanState(filePath) {
  return {
    scannerVersion: SESSION_SCANNER_VERSION,
    session: {
      id: sessionIdFromPath(filePath),
      cwd: "",
      model: "",
      createdAtMs: null,
    },
    context: { cwd: "", model: "" },
    knownContext: emptyContextFlags(),
    unresolvedContext: emptyContextFlags(),
    lastTotalUsage: usageZero(),
    sawPrimarySessionMeta: false,
  };
}

function stateVersionIsCompatible(value) {
  const version = Number(value?.scannerVersion);
  return (
    version === SESSION_SCANNER_VERSION ||
    (version === 0 && Number(value?.requiredScannerVersion) === SESSION_SCANNER_VERSION)
  );
}

function normalizeSessionScanState(filePath, value) {
  const initial = initialSessionScanState(filePath);
  if (!value || !stateVersionIsCompatible(value)) {
    return initial;
  }
  const session = value.session && typeof value.session === "object" ? value.session : {};
  const context = value.context && typeof value.context === "object" ? value.context : {};
  const knownContext =
    value.knownContext && typeof value.knownContext === "object" ? value.knownContext : {};
  const unresolvedContext =
    value.unresolvedContext && typeof value.unresolvedContext === "object"
      ? value.unresolvedContext
      : {};
  return {
    scannerVersion: SESSION_SCANNER_VERSION,
    session: {
      id: String(session.id || initial.session.id),
      cwd: String(session.cwd || ""),
      model: String(session.model || ""),
      createdAtMs:
        session.createdAtMs != null && Number.isFinite(Number(session.createdAtMs))
          ? Number(session.createdAtMs)
          : null,
    },
    context: {
      cwd: String(context.cwd || ""),
      model: String(context.model || ""),
    },
    knownContext: Object.fromEntries(
      CONTEXT_FIELDS.map((field) => [field, Boolean(knownContext[field])]),
    ),
    unresolvedContext: Object.fromEntries(
      CONTEXT_FIELDS.map((field) => [field, Boolean(unresolvedContext[field])]),
    ),
    lastTotalUsage: normalizeUsage(value.lastTotalUsage),
    sawPrimarySessionMeta: Boolean(value.sawPrimarySessionMeta),
  };
}

function hasUnresolvedContext(unresolvedContext) {
  return CONTEXT_FIELDS.some((field) => Boolean(unresolvedContext[field]));
}

function serializedSessionScanState(state) {
  const incrementalSafe = !hasUnresolvedContext(state.unresolvedContext);
  return {
    // usage-index only resumes parser states whose scannerVersion matches the
    // current scanner. Mark unresolved states as non-resumable so the next
    // append is fully rescanned and can retroactively apply late context.
    scannerVersion: incrementalSafe ? SESSION_SCANNER_VERSION : 0,
    requiredScannerVersion: SESSION_SCANNER_VERSION,
    incrementalSafe,
    session: { ...state.session },
    context: { ...state.context },
    knownContext: { ...state.knownContext },
    unresolvedContext: { ...state.unresolvedContext },
    lastTotalUsage: { ...state.lastTotalUsage },
    sawPrimarySessionMeta: state.sawPrimarySessionMeta,
  };
}

function cumulativeKeyFromStoredEventKey(value) {
  const key = String(value || "");
  const separator = key.lastIndexOf(EVENT_KEY_SEPARATOR);
  return separator === -1 ? key : key.slice(separator + 1);
}

function createScanRuntime(state) {
  return {
    priorUnresolved: { ...state.unresolvedContext },
    pending: Object.fromEntries(CONTEXT_FIELDS.map((field) => [field, new Set()])),
    requiresFullRescan: false,
  };
}

function normalizedText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function refreshEventKey(record) {
  const { event } = record;
  const fingerprint = usageEventFingerprint({
    timestampMs: record.hasEventTimestamp ? record.parsedTimestampMs : null,
    totalUsage: record.totalUsage,
    lastUsage: event.usage,
    fallbackIdentity: `${event.sessionId}\0${event.cwd}\0${event.model}`,
  });
  event.totalUsageKey = `${fingerprint}${EVENT_KEY_SEPARATOR}${record.totalKey}`;
}

function applyContextToPending(runtime, field, value) {
  if (value == null || value === "") return;
  if (runtime.priorUnresolved[field]) {
    runtime.requiresFullRescan = true;
  }

  const pending = runtime.pending[field];
  for (const record of pending) {
    const { event } = record;
    if (field === "sessionCreatedAtMs") {
      event.sessionCreatedAtMs = value;
      if (!record.hasEventTimestamp && event.timestampMs == null) {
        event.timestampMs = value;
      }
    } else {
      event[field] = value;
    }
    refreshEventKey(record);
  }
  pending.clear();
}

function registerUnresolved(runtime, field, record) {
  runtime.pending[field].add(record);
}

function updateUnresolvedState(state, runtime) {
  for (const field of CONTEXT_FIELDS) {
    state.unresolvedContext[field] =
      Boolean(runtime.priorUnresolved[field]) || runtime.pending[field].size > 0;
  }
}

function processSessionLine(
  filePath,
  line,
  state,
  runtime,
  seenTotals,
  events,
  stats,
  { trailing = false } = {},
) {
  if (
    !trailing &&
    !line.includes('"token_count"') &&
    !line.includes('"turn_context"') &&
    !line.includes('"session_meta"') &&
    !line.includes('"thread_settings_applied"')
  ) {
    return true;
  }

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    if (trailing) {
      return false;
    }
    stats.parseErrors += 1;
    return true;
  }

  const { session, context } = state;
  if (obj.type === "session_meta" && obj.payload) {
    if (!state.sawPrimarySessionMeta) {
      const sessionId = normalizedText(obj.payload.id);
      const cwd = normalizedText(obj.payload.cwd);
      const created = Date.parse(obj.payload.timestamp || obj.timestamp || "");

      if (sessionId) {
        session.id = sessionId;
        state.knownContext.sessionId = true;
        applyContextToPending(runtime, "sessionId", sessionId);
      }
      if (cwd) {
        session.cwd = cwd;
        state.knownContext.cwd = true;
        applyContextToPending(runtime, "cwd", cwd);
      }
      if (!Number.isNaN(created)) {
        session.createdAtMs = created;
        state.knownContext.sessionCreatedAtMs = true;
        applyContextToPending(runtime, "sessionCreatedAtMs", created);
      }
      state.sawPrimarySessionMeta = true;
    }
    return true;
  }

  if (obj.type === "turn_context" && obj.payload) {
    const cwd = normalizedText(obj.payload.cwd);
    const model = normalizedText(obj.payload.model);
    state.context = {
      cwd: cwd || context.cwd || session.cwd,
      model: model || context.model || session.model,
    };
    if (cwd) {
      session.cwd = cwd;
      state.knownContext.cwd = true;
      applyContextToPending(runtime, "cwd", cwd);
    }
    if (model) {
      session.model = model;
      state.knownContext.model = true;
      applyContextToPending(runtime, "model", model);
    }
    return true;
  }

  if (obj.type === "event_msg" && obj.payload?.type === "thread_settings_applied") {
    const model = normalizedText(obj.payload.thread_settings?.model);
    if (model) {
      state.context = {
        cwd: context.cwd || session.cwd,
        model,
      };
      session.model = model;
      state.knownContext.model = true;
      applyContextToPending(runtime, "model", model);
    }
    return true;
  }

  if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") {
    return true;
  }

  stats.tokenEvents += 1;
  const info = obj.payload.info || {};
  const totalUsage = normalizeUsage(info.total_token_usage);
  const totalKey = usageKey(totalUsage);
  if (seenTotals.has(totalKey)) {
    stats.duplicateTokenEvents += 1;
    return true;
  }
  seenTotals.add(totalKey);

  let usage = normalizeUsage(info.last_token_usage);
  if (!hasUsage(usage)) {
    usage = diffUsage(totalUsage, state.lastTotalUsage);
  }
  state.lastTotalUsage = totalUsage;

  const parsedTimestampMs = Date.parse(obj.timestamp || "");
  const hasEventTimestamp = !Number.isNaN(parsedTimestampMs);
  const timestampMs = hasEventTimestamp ? parsedTimestampMs : session.createdAtMs;
  const cwd = state.knownContext.cwd ? state.context.cwd || session.cwd : UNKNOWN_CWD;
  const model = state.knownContext.model ? state.context.model || session.model : UNKNOWN_MODEL;
  const event = {
    timestampMs,
    sessionCreatedAtMs: state.knownContext.sessionCreatedAtMs ? session.createdAtMs : null,
    sessionId: session.id,
    totalUsageKey: "",
    file: filePath,
    cwd,
    model,
    usage,
  };
  const record = {
    event,
    totalUsage,
    totalKey,
    parsedTimestampMs,
    hasEventTimestamp,
  };
  refreshEventKey(record);
  events.push(event);

  if (!state.knownContext.sessionId) registerUnresolved(runtime, "sessionId", record);
  if (!state.knownContext.sessionCreatedAtMs) {
    registerUnresolved(runtime, "sessionCreatedAtMs", record);
  }
  if (!state.knownContext.cwd) registerUnresolved(runtime, "cwd", record);
  if (!state.knownContext.model) registerUnresolved(runtime, "model", record);
  return true;
}

export async function scanSessionFileRange(
  filePath,
  { startOffset = 0, endOffset = null, state: savedState = null, seenTotals: savedTotals = null } = {},
) {
  const events = [];
  const seenTotals = new Set(Array.from(savedTotals || [], cumulativeKeyFromStoredEventKey));
  const stats = {
    duplicateTokenEvents: 0,
    parseErrors: 0,
    tokenEvents: 0,
  };
  const fileSize = endOffset == null ? (await stat(filePath)).size : Number(endOffset);
  const start = Number(startOffset);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(fileSize) || fileSize < start) {
    throw new Error(`Invalid scan range for ${filePath}: ${start}..${fileSize}`);
  }

  const state = normalizeSessionScanState(filePath, savedState);
  const runtime = createScanRuntime(state);
  let processedOffset = start;
  let trailingParts = [];

  if (fileSize > start) {
    const input = createReadStream(filePath, { start, end: fileSize - 1 });
    let chunkStart = start;
    for await (const chunk of input) {
      let cursor = 0;
      let newlineIndex = chunk.indexOf(0x0a, cursor);
      while (newlineIndex !== -1) {
        trailingParts.push(chunk.subarray(cursor, newlineIndex));
        let lineBuffer = trailingParts.length === 1 ? trailingParts[0] : Buffer.concat(trailingParts);
        if (lineBuffer.at(-1) === 0x0d) {
          lineBuffer = lineBuffer.subarray(0, -1);
        }
        processSessionLine(
          filePath,
          lineBuffer.toString("utf8"),
          state,
          runtime,
          seenTotals,
          events,
          stats,
        );
        processedOffset = chunkStart + newlineIndex + 1;
        trailingParts = [];
        cursor = newlineIndex + 1;
        newlineIndex = chunk.indexOf(0x0a, cursor);
      }
      if (cursor < chunk.length) {
        trailingParts.push(chunk.subarray(cursor));
      }
      chunkStart += chunk.length;
    }
  }

  if (trailingParts.length > 0) {
    let lineBuffer = trailingParts.length === 1 ? trailingParts[0] : Buffer.concat(trailingParts);
    if (lineBuffer.at(-1) === 0x0d) {
      lineBuffer = lineBuffer.subarray(0, -1);
    }
    const complete = processSessionLine(
      filePath,
      lineBuffer.toString("utf8"),
      state,
      runtime,
      seenTotals,
      events,
      stats,
      { trailing: true },
    );
    if (complete) {
      processedOffset = fileSize;
    }
  } else if (fileSize === start || processedOffset < fileSize) {
    processedOffset = fileSize;
  }

  updateUnresolvedState(state, runtime);
  const serializedState = serializedSessionScanState(state);
  return {
    session: { ...state.session, file: filePath },
    events,
    stats,
    state: serializedState,
    incrementalSafe: serializedState.incrementalSafe,
    requiresFullRescan: runtime.requiresFullRescan,
    processedOffset,
    scannedBytes: fileSize - start,
  };
}
