const rankingMetrics = {
  total: { field: "total_tokens", label: "Token 总量" },
  input: { field: "input_tokens", label: "输入 Token" },
  cached: { field: "cached_input_tokens", label: "缓存输入" },
  output: { field: "output_tokens", label: "输出 Token" },
  reasoning: { field: "reasoning_output_tokens", label: "推理输出" },
  requests: { field: "requests", label: "请求数" },
  sessions: { field: "sessions", label: "会话数" },
  cost: { field: "reference_total_cost_usd", label: "参考金额" },
};

export function rankingMetricForSort(sort) {
  return rankingMetrics[sort] || rankingMetrics.total;
}

export function formatRange(range, timezone) {
  if (!range || (!range.from && !range.to)) return "全部";
  const from = range.from ? formatDateInTimezone(range.from, timezone) : "开始";
  const to = range.to ? formatDateInTimezone(range.to, timezone) : "当前";
  return `${from} .. ${to}`;
}

function formatDateInTimezone(value, timezone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);

  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timezone ? { timeZone: timezone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Preserve a useful scale for fractional-dollar series; only an all-zero series
// needs a fallback. Token and currency charts share the same finite bounds.
export function chartScaleMax(values) {
  const value = values.reduce((max, item) => Number.isFinite(Number(item)) ? Math.max(max, Number(item)) : max, 0);
  if (value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const fraction = value / base;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * base;
}

export function formatChartMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", n !== 0 && Math.abs(n) < 1
    ? { maximumSignificantDigits: 3 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function groupScopeLabel(shown, total) {
  return `展示 ${Number(shown).toLocaleString("zh-CN")} / 共 ${Number(total).toLocaleString("zh-CN")} 个分组`;
}
