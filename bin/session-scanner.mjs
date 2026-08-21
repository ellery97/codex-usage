import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  diffUsage,
  hasUsage,
  normalizeUsage,
  usageKey,
  usageZero,
} from "./usage-values.mjs";

export const SESSION_SCANNER_VERSION = 1;

function sessionIdFromPath(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return match ? match[1] : base;
}

export async function scanSessionFile(filePath) {
  return scanSessionFileRange(filePath);
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
    lastTotalUsage: usageZero(),
    sawPrimarySessionMeta: false,
  };
}

function normalizeSessionScanState(filePath, value) {
  const initial = initialSessionScanState(filePath);
  if (!value || Number(value.scannerVersion) !== SESSION_SCANNER_VERSION) {
    return initial;
  }
  const session = value.session && typeof value.session === "object" ? value.session : {};
  const context = value.context && typeof value.context === "object" ? value.context : {};
  return {
    scannerVersion: SESSION_SCANNER_VERSION,
    session: {
      id: String(session.id || initial.session.id),
      cwd: String(session.cwd || ""),
      model: String(session.model || ""),
      createdAtMs: Number.isFinite(Number(session.createdAtMs)) ? Number(session.createdAtMs) : null,
    },
    context: {
      cwd: String(context.cwd || ""),
      model: String(context.model || ""),
    },
    lastTotalUsage: normalizeUsage(value.lastTotalUsage),
    sawPrimarySessionMeta: Boolean(value.sawPrimarySessionMeta),
  };
}

function serializedSessionScanState(state) {
  return {
    scannerVersion: SESSION_SCANNER_VERSION,
    session: { ...state.session },
    context: { ...state.context },
    lastTotalUsage: { ...state.lastTotalUsage },
    sawPrimarySessionMeta: state.sawPrimarySessionMeta,
  };
}

function processSessionLine(filePath, line, state, seenTotals, events, stats, { trailing = false } = {}) {
  if (
    !trailing &&
    !line.includes('"token_count"') &&
    !line.includes('"turn_context"') &&
    !line.includes('"session_meta"')
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
      session.id = obj.payload.id || session.id;
      session.cwd = obj.payload.cwd || session.cwd;
      const created = Date.parse(obj.payload.timestamp || obj.timestamp || "");
      if (!Number.isNaN(created)) {
        session.createdAtMs = created;
      }
      state.sawPrimarySessionMeta = true;
    }
    return true;
  }

  if (obj.type === "turn_context" && obj.payload) {
    state.context = {
      cwd: obj.payload.cwd || context.cwd || session.cwd,
      model: obj.payload.model || context.model || session.model,
    };
    session.cwd = state.context.cwd || session.cwd;
    session.model = state.context.model || session.model;
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

  const timestampMs = Date.parse(obj.timestamp || "");
  events.push({
    timestampMs: Number.isNaN(timestampMs) ? session.createdAtMs : timestampMs,
    sessionCreatedAtMs: session.createdAtMs,
    sessionId: session.id,
    totalUsageKey: totalKey,
    file: filePath,
    cwd: state.context.cwd || session.cwd || "(unknown cwd)",
    model: state.context.model || session.model || "(unknown model)",
    usage,
  });
  return true;
}

export async function scanSessionFileRange(
  filePath,
  { startOffset = 0, endOffset = null, state: savedState = null, seenTotals: savedTotals = null } = {},
) {
  const events = [];
  const seenTotals = savedTotals instanceof Set ? savedTotals : new Set(savedTotals || []);
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
        processSessionLine(filePath, lineBuffer.toString("utf8"), state, seenTotals, events, stats);
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

  return {
    session: { ...state.session, file: filePath },
    events,
    stats,
    state: serializedSessionScanState(state),
    processedOffset,
    scannedBytes: fileSize - start,
  };
}
