import { createHash } from "node:crypto";

export const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

export function usageZero() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

export function normalizeUsage(value) {
  const usage = usageZero();
  if (!value || typeof value !== "object") {
    return usage;
  }
  for (const field of USAGE_FIELDS) {
    const number = Number(value[field] ?? 0);
    usage[field] = Number.isFinite(number) ? number : 0;
  }
  return usage;
}

export function addUsage(target, source) {
  for (const field of USAGE_FIELDS) {
    target[field] += source[field] || 0;
  }
  return target;
}

export function diffUsage(next, previous) {
  const usage = usageZero();
  for (const field of USAGE_FIELDS) {
    usage[field] = Math.max(0, (next[field] || 0) - (previous[field] || 0));
  }
  return usage;
}

export function usageKey(usage) {
  return USAGE_FIELDS.map((field) => usage[field] || 0).join(":");
}

export function usageEventFingerprint({
  timestampMs,
  totalUsage,
  lastUsage = null,
  fallbackIdentity = null,
} = {}) {
  const validTimestamp = Number.isFinite(Number(timestampMs));
  const identity = {
    timestamp_ms: validTimestamp ? Number(timestampMs) : null,
    total_usage: usageKey(totalUsage),
    last_usage: lastUsage ? usageKey(lastUsage) : null,
  };
  if (!validTimestamp) {
    identity.fallback_identity = String(fallbackIdentity || "unknown");
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function hasUsage(usage) {
  return USAGE_FIELDS.some((field) => (usage[field] || 0) > 0);
}
