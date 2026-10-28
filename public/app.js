import { formatRange, rankingMetricForSort, chartScaleMax, formatChartMoney, groupScopeLabel } from "./dashboard-formatters.js";

const state = {
  data: null,
  indexStatus: null,
  rows: [],
  blockingLoading: false,
  chartPoints: [],
  hoverIndex: null,
  trendMetric: "tokens",
};

const els = {
  rangePresets: document.getElementById("rangePresets"),
  moreRanges: document.getElementById("moreRanges"),
  dedupeWarning: document.getElementById("dedupeWarning"),
  loadError: document.getElementById("loadError"),
  loadErrorMessage: document.getElementById("loadErrorMessage"),
  loadRetry: document.getElementById("loadRetry"),
  chartMetric: document.getElementById("chartMetric"),
  tokenMetric: document.getElementById("tokenMetric"),
  costMetric: document.getElementById("costMetric"),
  chartNote: document.getElementById("chartNote"),
  mixList: document.getElementById("mixList"),
  fullColumns: document.getElementById("fullColumns"),
  tableWrap: document.getElementById("tableWrap"),

  indexStatus: document.getElementById("indexStatus"),
  indexMessage: document.getElementById("indexMessage"),
  indexProgress: document.getElementById("indexProgress"),
  indexFailures: document.getElementById("indexFailures"),
  indexFailureList: document.getElementById("indexFailureList"),
  indexRetry: document.getElementById("indexRetry"),
  sourceSelect: document.getElementById("sourceSelect"),
  rangeSelect: document.getElementById("rangeSelect"),
  groupSelect: document.getElementById("groupSelect"),
  sortSelect: document.getElementById("sortSelect"),
  directionSelect: document.getElementById("directionSelect"),
  limitInput: document.getElementById("limitInput"),
  dedupeSelect: document.getElementById("dedupeSelect"),
  fromInput: document.getElementById("fromInput"),
  toInput: document.getElementById("toInput"),
  refreshButton: document.getElementById("refreshButton"),
  tableSearch: document.getElementById("tableSearch"),
  controlGrid: document.querySelector(".control-grid"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingMessage: document.getElementById("loadingMessage"),
  filterStatus: document.getElementById("filterStatus"),
  errorToast: document.getElementById("errorToast"),
  usageChart: document.getElementById("usageChart"),
  mixChart: document.getElementById("mixChart"),
  chartTooltip: document.getElementById("chartTooltip"),
  mainLegend: document.querySelector(".legend"),
};

const text = {
  sourceLabel: document.getElementById("sourceLabel"),
  rangeLabel: document.getElementById("rangeLabel"),
  updatedLabel: document.getElementById("updatedLabel"),
  totalTokens: document.getElementById("totalTokens"),
  totalSub: document.getElementById("totalSub"),
  inputTokens: document.getElementById("inputTokens"),
  cachedInput: document.getElementById("cachedInput"),
  outputTokens: document.getElementById("outputTokens"),
  reasoningOutput: document.getElementById("reasoningOutput"),
  cacheRatio: document.getElementById("cacheRatio"),
  uncachedInput: document.getElementById("uncachedInput"),
  estimatedCost: document.getElementById("estimatedCost"),
  officialCost: document.getElementById("officialCost"),
  provisionalCostRow: document.getElementById("provisionalCostRow"),
  provisionalCost: document.getElementById("provisionalCost"),
  assumedCostRow: document.getElementById("assumedCostRow"),
  assumedCost: document.getElementById("assumedCost"),
  costDetails: document.getElementById("costDetails"),
  costEquation: document.getElementById("costEquation"),
  provisionalExplanation: document.getElementById("provisionalExplanation"),
  alternativeCost: document.getElementById("alternativeCost"),
  costSub: document.getElementById("costSub"),
  pricingWarning: document.getElementById("pricingWarning"),
  mainChartTitle: document.getElementById("mainChartTitle"),
  mainChartMeta: document.getElementById("mainChartMeta"),
  scanMeta: document.getElementById("scanMeta"),
  tableMeta: document.getElementById("tableMeta"),
  sessionCount: document.getElementById("sessionCount"),
  requestCount: document.getElementById("requestCount"),
  fileCount: document.getElementById("fileCount"),
  globalDedupe: document.getElementById("globalDedupe"),
  assumedBlock: document.getElementById("assumedBlock"),
  assumedModelList: document.getElementById("assumedModelList"),
  unpricedBlock: document.getElementById("unpricedBlock"),
  unpricedModelList: document.getElementById("unpricedModelList"),
};

const tableBody = document.getElementById("usageTable");
const dateGroups = new Set(["day", "month"]);
let sortUserSelected = false;
let requestController = null;
let requestSequence = 0;
let filterDebounce = null;
const chartSans = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const chartMono = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
// Match the CSS palette; read the shared custom properties in the browser.
const css = window.getComputedStyle?.(document.documentElement);
const chartColors = Object.fromEntries(Object.entries({
  ink: "#17212f", muted: "#5f6b7b", surface: "#ffffff", blue: "#315bd6",
  cyan: "#477f99", amber: "#b57b24", green: "#26846b", rose: "#9366b4",
}).map(([key, fallback]) => [key, css?.getPropertyValue(`--${key}`).trim() || fallback]));
chartColors.grid = css?.getPropertyValue("--line").trim() || "#e1e5eb";
chartColors.surface2 = css?.getPropertyValue("--soft").trim() || "#eef3ff";

function compactNumber(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

function fullNumber(value) {
  return Math.round(Number(value || 0)).toLocaleString("zh-CN");
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "$0.00";
  if (Math.abs(n) >= 1000) {
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (Math.abs(n) >= 1) {
    return `$${n.toFixed(2)}`;
  }
  return `$${n.toFixed(4)}`;
}

function durationMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function setBlockingLoading(value, message = "正在读取本地索引") {
  state.blockingLoading = value;
  els.loadingOverlay.hidden = !value;
  els.loadingMessage.textContent = message;
  for (const control of document.querySelectorAll(".control-grid select, .control-grid input, .control-grid button, .analysis-controls select, .analysis-controls input, #dedupeSelect")) {
    control.disabled = value || (control === els.refreshButton && Boolean(state.indexStatus?.running));
  }
}

function setFilterLoading(value) {
  els.filterStatus.hidden = !value;
}

function showError(message) {
  els.errorToast.textContent = message;
  els.errorToast.hidden = false;
  window.setTimeout(() => {
    els.errorToast.hidden = true;
  }, 6000);
}

function syncControls() {
  els.controlGrid.classList.toggle("show-custom", els.rangeSelect.value === "custom");
  for (const button of els.rangePresets.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.range === els.rangeSelect.value));
  }
  els.dedupeWarning.hidden = els.dedupeSelect.value !== "file";
  els.fromInput.setCustomValidity("");
  els.toInput.setCustomValidity("");
}

function defaultSortForGroup(group) {
  return dateGroups.has(group) ? "key" : "total";
}

function syncSortForGroup({ force = false } = {}) {
  if (force || !sortUserSelected) {
    els.sortSelect.value = defaultSortForGroup(els.groupSelect.value);
  }
}

function buildQuery() {
  const params = new URLSearchParams();
  const group = els.groupSelect.value;
  const sort = els.sortSelect.value;
  const direction = els.directionSelect.value;
  params.set("range", els.rangeSelect.value);
  params.set("sourceScope", els.sourceSelect.value);
  params.set("group", group);
  params.set("sort", sort);
  params.set("limit", els.limitInput.value || "0");
  params.set("dedupeScope", els.dedupeSelect.value);

  if (direction === "asc") params.set("asc", "1");
  if (direction === "desc" || shouldAutoPreferDesc(group, sort, direction)) params.set("desc", "1");
  if (els.rangeSelect.value === "custom") {
    if (els.fromInput.value) params.set("from", els.fromInput.value);
    if (els.toInput.value) params.set("to", els.toInput.value);
  }
  return params;
}

function shouldAutoPreferDesc(group, sort, direction) {
  if (direction !== "auto") return false;
  if (sort === "key") return dateGroups.has(group);
  return true;
}

async function loadData({ blocking = false } = {}) {
  syncControls();
  if (els.rangeSelect.value === "custom") {
    if (!els.fromInput.value && !els.toInput.value) return;
    if (els.fromInput.value && els.toInput.value && els.fromInput.value > els.toInput.value) {
      els.toInput.setCustomValidity("结束日期不能早于开始日期");
      els.toInput.reportValidity();
      return;
    }
  }
  els.loadError.hidden = true;
  cancelIndexPoll();
  window.clearTimeout(filterDebounce);
  filterDebounce = null;
  requestController?.abort();
  requestController = new AbortController();
  const requestId = ++requestSequence;
  if (blocking) {
    setFilterLoading(false);
    setBlockingLoading(
      true,
      "正在读取本地索引",
    );
  } else {
    if (state.blockingLoading) setBlockingLoading(false);
    setFilterLoading(true);
  }
  try {
    const query = buildQuery();
    query.set("refreshIndex", "0");
    const response = await fetch(`/api/usage?${query.toString()}`, {
      cache: "no-store",
      signal: requestController.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "用量 API 请求失败");
    }
    if (requestId !== requestSequence) return;
    state.data = payload;
    state.rows = payload.rows || [];
    render();
    updateIndexStatus(payload.index);
  } catch (error) {
    if (error.name === "AbortError" || requestId !== requestSequence) return;
    showError(error.message);
    if (!state.data) {
      els.loadError.hidden = false;
      els.loadErrorMessage.textContent = error.message;
    }
  } finally {
    if (requestId === requestSequence) {
      if (blocking) setBlockingLoading(false);
      else setFilterLoading(false);
      scheduleIndexPoll();
    }
  }
}

let indexPollTimer = null;
let indexPollController = null;

function cancelIndexPoll() {
  window.clearTimeout(indexPollTimer);
  indexPollTimer = null;
  indexPollController?.abort();
  indexPollController = null;
}

function scheduleIndexPoll() {
  window.clearTimeout(indexPollTimer);
  indexPollTimer = null;
  const status = state.indexStatus;
  if (!indexPollController && (status?.running || status?.pricingRefresh?.running)) {
    indexPollTimer = window.setTimeout(pollIndexStatus, 1000);
  }
}

function updateIndexStatus(status) {
  if (!status) return;
  state.indexStatus = status;
  els.indexStatus.hidden = !status.incomplete;
  els.refreshButton.disabled = status.running;
  els.indexRetry.hidden = status.running || !status.incomplete;
  els.indexRetry.textContent = status.failedFiles ? "重试失败文件" : "重新刷新索引";
  els.indexMessage.textContent = status.running
    ? (status.hasSnapshot ? "历史数据尚未补齐，当前展示上次已发布统计；仍可调整筛选。" : "正在建立索引，历史数据尚未补齐。")
    : status.state === "failed" ? `索引刷新失败，统计可能不完整：${status.error}`
    : status.failedFiles ? `统计不完整：${status.failedFiles} 个文件读取失败。` : "索引已更新";
  const bytes = (value) => `${(Number(value || 0) / 1024 / 1024).toFixed(1)} MiB`;
  const phases = { discover: "正在查找日志", check: "正在检查文件", scan: "正在补扫", publish: "正在发布统计" };
  els.indexProgress.hidden = !status.running;
  els.indexProgress.textContent = `${phases[status.phase] || "正在准备"} · 已处理 ${status.completedFiles || 0} / ${status.pendingFiles ?? "待确认"} 个文件 · 源文件读取 ${bytes(status.scannedBytes)} · 解压后处理 ${bytes(status.decodedBytes)}`;
  els.indexFailures.hidden = !status.failedFiles;
  els.indexFailureList.replaceChildren(...(status.failures || []).map((failure) => {
    const item = document.createElement("li");
    item.textContent = `${failure.path}：${failure.message}（${failure.usingPreviousIndex ? "使用上次索引" : "已跳过"}）`;
    return item;
  }));
  if (!status.hasSnapshot && state.data) {
    for (const key of ["totalTokens", "inputTokens", "outputTokens", "cacheRatio", "estimatedCost", "officialCost", "requestCount", "sessionCount"] ) text[key].textContent = "--";
    text.totalSub.textContent = "正在建立索引";
    text.provisionalCostRow.hidden = true;
    text.assumedCostRow.hidden = true;
    text.costDetails.hidden = true;
  }
  scheduleIndexPoll();
}

async function pollIndexStatus() {
  const controller = new AbortController();
  indexPollController = controller;
  const sourceScope = els.sourceSelect.value;
  const requestId = requestSequence;
  const isCurrent = () => indexPollController === controller && requestId === requestSequence && sourceScope === els.sourceSelect.value;
  let failed = false;
  try {
    const query = new URLSearchParams({ sourceScope });
    const response = await fetch(`/api/index/status?${query}`, { cache: "no-store", signal: controller.signal });
    const status = await response.json();
    if (!isCurrent()) return;
    if (!response.ok) throw new Error(status.error || "无法读取索引状态");
    updateIndexStatus(status);
    if (status.revision !== state.data?.index?.revision || (!status.running && state.data?.index?.running) ||
        status.pricingRefresh?.revision !== state.data?.index?.pricingRefresh?.revision) {
      await loadData();
    }
  } catch (error) {
    if (error.name === "AbortError" || !isCurrent()) return;
    failed = true;
    showError(error.message);
    // Keep the incomplete warning visible and offer an explicit retry.
    els.indexRetry.hidden = false;
    els.refreshButton.disabled = false;
  } finally {
    // A filter change may already own a different poll. Never clear its task or
    // schedule from this request's older response after loadData has completed.
    if (indexPollController === controller) {
      indexPollController = null;
      if (!failed) scheduleIndexPoll();
    }
  }
}

async function refreshIndex() {
  cancelIndexPoll();
  window.clearTimeout(filterDebounce);
  filterDebounce = null;
  requestController?.abort();
  requestController = new AbortController();
  const requestId = ++requestSequence;
  setBlockingLoading(false);
  setFilterLoading(false);
  els.refreshButton.disabled = true;
  try {
    const query = buildQuery();
    query.set("async", "1");
    const response = await fetch(`/api/index/refresh?${query}`, { method: "POST", signal: requestController.signal });
    const status = await response.json();
    if (requestId !== requestSequence) return;
    if (!response.ok) throw new Error(status.error || "无法刷新索引");
    updateIndexStatus(status);
    if (!status.running) await loadData();
  } catch (error) {
    if (error.name === "AbortError" || requestId !== requestSequence) return;
    els.refreshButton.disabled = false;
    showError(error.message);
  }
}

function applyFilters({ debounce = false } = {}) {
  window.clearTimeout(filterDebounce);
  if (debounce) {
    filterDebounce = window.setTimeout(() => loadData(), 200);
  } else {
    loadData();
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  state.hoverIndex = null;
  hideChartTooltip();
  const totals = data.totals || {};
  const stats = data.stats || {};

  text.sourceLabel.textContent = sourceTitle(data.source) || "未发现可访问目录";
  text.sourceLabel.title = sourceTitle(data.source);
  text.rangeLabel.textContent = `范围：${formatRange(data.range, data.timezone)}`;
  text.updatedLabel.textContent = `索引更新时间：${data.index?.publishedAt ? new Date(data.index.publishedAt).toLocaleString("zh-CN", { hour12: false }) : "--"}`;

  text.totalTokens.textContent = compactNumber(totals.total_tokens);
  text.totalSub.textContent = "当前筛选范围";
  text.inputTokens.textContent = compactNumber(totals.input_tokens);
  text.cachedInput.textContent = `${compactNumber(totals.cached_input_tokens)} 命中 · ${compactNumber(totals.cache_write_input_tokens)} 写入`;
  text.outputTokens.textContent = compactNumber(totals.output_tokens);
  text.reasoningOutput.textContent = `${compactNumber(totals.reasoning_output_tokens)} 推理输出`;
  text.cacheRatio.textContent = percent(totals.cache_hit_ratio);
  text.uncachedInput.textContent = `${compactNumber(totals.uncached_input_tokens)} 普通输入`;
  text.estimatedCost.textContent = money(totals.reference_total_cost_usd);
  text.officialCost.textContent = money(totals.estimated_cost_usd);
  const hasProvisional = Number(totals.provisional_priced_requests || 0) > 0;
  text.provisionalCostRow.hidden = !hasProvisional;
  text.provisionalCost.textContent = money(totals.provisional_estimated_cost_usd);
  text.assumedCostRow.hidden = Number(totals.assumed_requests || 0) === 0;
  text.assumedCost.textContent = `+${money(totals.assumed_cost_usd)}`;
  text.costDetails.hidden = false;
  text.costEquation.textContent = `${money(totals.reference_total_cost_usd)} ≈ ${money(totals.estimated_cost_usd)} + ${money(totals.assumed_cost_usd)}（显示值已四舍五入）`;
  text.provisionalExplanation.hidden = !hasProvisional;
  text.provisionalExplanation.textContent = hasProvisional
    ? `${fullNumber(totals.provisional_priced_requests)} 次请求使用了历史生效日期尚未确认的公开单价。对应 ${money(totals.provisional_estimated_cost_usd)} 已包含在“按公开单价估算”和基线总额中，无需再次相加；待生效日期核实后，这部分估算可能调整。`
    : "";
  text.alternativeCost.textContent = Number(totals.assumed_requests || 0) > 0
    ? `若采用另一方案：无独立定价部分为 ${money(totals.assumed_upper_bound_cost_usd)}，对应总额为 ${money(totals.reference_total_upper_bound_cost_usd)}（替换基线部分，不额外叠加）。`
    : "";
  text.costSub.textContent = costFootnote(totals, data.pricing);
  renderPricingWarning(data.pricing);

  text.sessionCount.textContent = fullNumber(totals.sessions);
  text.requestCount.textContent = fullNumber(totals.requests);
  text.fileCount.textContent = `${fullNumber(stats.filesWithUsage)} / ${fullNumber(stats.files)}`;
  text.globalDedupe.textContent = fullNumber(stats.globalDuplicateTokenEvents);
  text.scanMeta.textContent = scanSummary(stats);

  renderChartSection();
  renderMixChart(totals);
  renderAssumedModels(data.assumedModels || []);
  renderUnpricedModels(data.unpricedModels || []);
  renderTable();
}

function costFootnote(totals, pricing) {
  const status = {
    fresh: "实时",
    cached: "缓存",
    partial: "部分刷新",
  }[pricing?.refreshStatus] || "本地目录";
  const checkedAt = pricing?.checkedAt
    ? `${pricing.checkedAt.slice(5, 16).replace("T", " ")} UTC`
    : "未校验";
  const parts = [`按事件发生时 Standard API 价格估算`, `${status} ${checkedAt}`];
  if (Number(totals.unpriced_total_tokens || 0) > 0) {
    parts.push(`${compactNumber(totals.unpriced_total_tokens)} Token 未计价`);
  }
  return parts.join(" · ");
}

function renderPricingWarning(pricing) {
  if (!text.pricingWarning) return;
  text.pricingWarning.hidden = !pricing?.usedFallback;
  text.pricingWarning.textContent = pricing?.usedFallback
    ? "官方价格刷新未完整成功，当前使用最近一次已验证的本地目录。"
    : "";
  text.pricingWarning.title = pricing?.warning || "";
}

function renderChartSection() {
  const data = state.data;
  if (!data) return;
  const dateGroup = dateGroups.has(data.group);
  const monetary = dateGroup ? state.trendMetric === "cost" : data.sort === "cost";
  const rows = data.rows || [];
  const shown = dateGroup ? rows.length : Math.min(rows.length, 18);
  els.chartMetric.hidden = !dateGroup;
  els.tokenMetric.setAttribute("aria-pressed", String(state.trendMetric === "tokens"));
  els.costMetric.setAttribute("aria-pressed", String(state.trendMetric === "cost"));
  text.mainChartTitle.textContent = dateGroup ? monetary ? "参考金额趋势" : "Token 用量趋势" : `${groupName(data.group)}排行`;
  text.mainChartMeta.textContent = `${groupName(data.group)} · ${groupScopeLabel(shown, data.rowCount ?? rows.length)}`;
  els.usageChart.setAttribute("aria-label", `${text.mainChartTitle.textContent}，精确数据见下方明细表`);
  els.chartNote.textContent = monetary
    ? "按 Standard API 单价估算的基线金额，不代表实际扣费。"
    : "仅展示已加载分组；完整筛选范围的总量见上方汇总。";
  if (monetary && Number(data.totals?.unpriced_total_tokens || 0) > 0) {
    els.chartNote.textContent += ` ${compactNumber(data.totals.unpriced_total_tokens)} Token 未计价，金额不完整。`;
  }
  renderMainLegend(data.group, data.sort);
  renderMainChart(rows, data.group, data.sort);
}

function renderMainLegend(group, sort) {
  if (!els.mainLegend) return;
  const rankingMetric = rankingMetricForSort(sort);
  const items = dateGroups.has(group)
    ? state.trendMetric === "cost" ? [["legend-total", "参考金额（基线） · USD"]] : [
        ["legend-total", "总量"],
        ["legend-input", "输入"],
        ["legend-output", "输出"],
      ]
    : [["legend-total", rankingMetric.label]];
  els.mainLegend.innerHTML = items.map(([className, label]) => `<span><i class="${className}"></i>${label}</span>`).join("");
}

function sourceTitle(source) {
  if (Array.isArray(source)) {
    return source.join("\n");
  }
  return source || "";
}

function groupName(group) {
  return {
    day: "按天",
    month: "按月",
    model: "按模型",
    cwd: "按工作目录",
    session: "按会话",
    none: "总计",
  }[group] || group;
}

function scanSummary(stats) {
  const parts = [`${fullNumber(stats.rawTokenEvents)} 条 Token 事件`];
  if (stats.queryCacheHit) {
    parts.push("查询缓存命中");
  } else if (stats.costCacheHit) {
    parts.push("计价切片命中");
  } else if (stats.indexRefreshSkipped) {
    parts.push("读取 SQLite 缓存");
  }
  const phases = [];
  if (Number.isFinite(Number(stats.scanDurationMs))) {
    phases.push(`索引 ${durationMs(stats.scanDurationMs)}`);
  }
  if (Number.isFinite(Number(stats.dedupeDurationMs))) {
    phases.push(`去重 ${durationMs(stats.dedupeDurationMs)}`);
  }
  if (Number.isFinite(Number(stats.aggregationDurationMs))) {
    phases.push(`聚合 ${durationMs(stats.aggregationDurationMs)}`);
  }
  if (phases.length > 0) {
    parts.push(phases.join(" / "));
  }
  if (Number.isFinite(Number(stats.totalDurationMs))) {
    parts.push(`总计 ${durationMs(stats.totalDurationMs)}`);
  }
  if (
    !stats.indexRefreshSkipped &&
    Number.isFinite(Number(stats.changedFiles)) &&
    Number.isFinite(Number(stats.files))
  ) {
    parts.push(
      `更新 ${fullNumber(stats.changedFiles)}/${fullNumber(stats.files)} 个文件` +
        `（增量 ${fullNumber(stats.incrementalFiles)}，完整 ${fullNumber(stats.fullRescanFiles)}）`,
    );
  }
  return parts.join(" · ");
}

function renderUnpricedModels(models) {
  if (!text.unpricedBlock || !text.unpricedModelList) return;
  text.unpricedBlock.hidden = models.length === 0;
  if (!models.length) {
    text.unpricedModelList.innerHTML = "";
    return;
  }
  text.unpricedModelList.innerHTML = models
    .slice(0, 8)
    .map(
      (row) => `
        <div class="model-price-card" title="${escapeHtml(row.model)}">
          <div class="model-price-route">
            <b>${escapeHtml(row.model)}</b>
            <em>未计价</em>
          </div>
          <div class="model-price-estimate">
            <strong>${fullNumber(row.total_tokens)} Token</strong>
            <em>${fullNumber(row.requests)} 次请求</em>
          </div>
        </div>`,
    )
    .join("");
}

function renderAssumedModels(models) {
  if (!text.assumedBlock || !text.assumedModelList) return;
  text.assumedBlock.hidden = models.length === 0;
  if (!models.length) {
    text.assumedModelList.innerHTML = "";
    return;
  }
  const routes = models.flatMap((row) =>
    (row.routes?.length ? row.routes : [row]).map((route) => ({ ...route, model: row.model })),
  );
  text.assumedModelList.innerHTML = routes
    .map(
      (row) => `
        <div class="model-price-card" title="${escapeHtml(row.label || "参考估算")}">
          <div class="model-price-route">
            <b>${escapeHtml(row.model)}</b>
            <em>${escapeHtml(row.effectiveFrom ? `方案起始 ${row.effectiveFrom.slice(0, 10)} UTC` : "历史基线")}</em>
          </div>
          <div class="assumption-models">
            <span><i>基线方案（已计入）</i><b>${escapeHtml(row.assumedModel || "--")}</b><strong>${money(row.assumed_cost_usd)}</strong></span>
            <span><i>另一参考方案</i><b>${escapeHtml(row.upperBoundModel || "--")}</b><strong>${money(row.assumed_upper_bound_cost_usd)}</strong></span>
          </div>
          <div class="model-price-estimate">
            <em>${fullNumber(row.total_tokens)} Token · ${fullNumber(row.requests)} 次${row.evidenceLevel ? ` · ${escapeHtml(evidenceLabel(row.evidenceLevel))}` : ""}</em>
          </div>
        </div>`,
    )
    .join("");
}

function evidenceLabel(value) {
  return {
    "official-product-description": "官方说明",
    "openai-community-announcement": "社区公告",
  }[value] || value;
}

function renderTable() {
  const needle = els.tableSearch.value.trim().toLowerCase();
  const rows = state.rows.filter((row) => !needle || String(row.key).toLowerCase().includes(needle));
  const loaded = state.rows.length;
  text.tableMeta.textContent = `${groupScopeLabel(loaded, state.data?.rowCount ?? loaded)}${needle ? ` · 搜索匹配 ${fullNumber(rows.length)} 个（仅已加载分组）` : ""}`;
  els.tableWrap.classList.toggle("show-full", els.fullColumns.checked);
  if (!rows.length) {
    tableBody.innerHTML = `<tr><td colspan="${els.fullColumns.checked ? 12 : 8}" class="empty-cell">${needle ? "已加载分组中没有匹配结果" : state.data?.index?.hasSnapshot === false ? "正在建立索引，完成后自动展示数据" : "当前筛选范围暂无数据"}</td></tr>`;
    return;
  }
  tableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</td>
          <td>${fullNumber(row.total_tokens)}</td>
          <td>${fullNumber(row.input_tokens)}</td>
          <td>${fullNumber(row.output_tokens)}</td>
          <td title="${escapeHtml(costTitle(row))}">${money(row.reference_total_cost_usd)}</td>
          <td>${percent(row.cache_hit_ratio)}</td>
          <td>${fullNumber(row.requests)}</td>
          <td>${fullNumber(row.sessions)}</td>
          <td class="detail-column">${fullNumber(row.cached_input_tokens)}</td>
          <td class="detail-column">${fullNumber(row.cache_write_input_tokens)}</td>
          <td class="detail-column">${fullNumber(row.reasoning_output_tokens)}</td>
          <td class="detail-column" title="${escapeHtml(costTitle(row))}">${money(row.estimated_cost_usd)}</td>
        </tr>`,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function costTitle(row) {
  const parts = [`按公开单价估算 ${money(row.estimated_cost_usd)}`];
  if (Number(row.provisional_priced_requests || 0) > 0) {
    parts.push(`其中历史生效日期待确认 ${money(row.provisional_estimated_cost_usd)}（已包含）`);
  }
  if (Number(row.assumed_requests || 0) > 0) {
    parts.push(`无独立定价部分的参考估算 ${money(row.assumed_cost_usd)}（已计入基线总额）`);
  }
  parts.push(`参考金额（基线）${money(row.reference_total_cost_usd)}`);
  if (Number(row.unpriced_total_tokens || 0) > 0) {
    parts.push(`${fullNumber(row.unpriced_total_tokens)} Token 未计价`);
  }
  return parts.join(" · ");
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width || canvas.clientWidth || 600);
  const cssHeight = Number(canvas.dataset.chartHeight || 260);
  canvas.style.width = "100%";
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.floor(cssWidth * ratio);
  canvas.height = Math.floor(cssHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

function renderMainChart(rows, group, sort = "total") {
  els.usageChart.dataset.chartHeight = dateGroups.has(group) ? 280 : Math.max(280, Math.min(rows.length, 18) * 22 + 24);
  const { ctx, width, height } = setupCanvas(els.usageChart);
  ctx.clearRect(0, 0, width, height);
  if (!rows.length) {
    state.chartPoints = [];
    hideChartTooltip();
    drawEmpty(ctx, width, height);
    return;
  }
  if (dateGroups.has(group)) {
    drawTrend(ctx, width, height, [...rows].sort(compareDateRowsAsc));
  } else {
    state.hoverIndex = null;
    drawBars(ctx, width, height, rows.slice(0, 18), rankingMetricForSort(sort).field);
  }
}

function compareDateRowsAsc(a, b) {
  return String(a.key).localeCompare(String(b.key));
}

function drawTrend(ctx, width, height, rows) {
  const pad = { top: 18, right: 34, bottom: 48, left: 72 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const monetary = state.trendMetric === "cost";
  const field = monetary ? "reference_total_cost_usd" : "total_tokens";
  const format = monetary ? formatChartMoney : compactNumber;
  const max = chartScaleMax(rows.flatMap((row) => monetary ? [row[field]] : [row.total_tokens, row.input_tokens, row.output_tokens]));
  const baseline = pad.top + chartH;
  const totalPoints = makeSeriesPoints(rows, field, pad, chartW, chartH, max);
  const inputPoints = makeSeriesPoints(rows, "input_tokens", pad, chartW, chartH, max);
  state.chartPoints = totalPoints.map((point, index) => ({ ...point, index, row: rows[index] }));

  drawGrid(ctx, pad, chartW, chartH, max, format);
  drawTrendArea(ctx, totalPoints, baseline, height);
  if (!monetary) {
    drawOutputBars(ctx, rows, pad, chartW, chartH, max);
    drawSeriesLine(ctx, inputPoints, chartColors.cyan, { width: 2, alpha: 0.85, dash: [6, 6] });
  }
  drawSeriesLine(ctx, totalPoints, chartColors.blue, { width: 3.2, alpha: 1 });
  drawPeakMarker(ctx, totalPoints, pad, chartW, format);
  drawHoverGuide(ctx, pad, chartH, totalPoints);
  drawXAxis(ctx, rows, pad, chartW, height);
}

function drawBars(ctx, width, height, rows, metric = "total_tokens") {
  const pad = { top: 8, right: 14, bottom: 16, left: Math.min(150, width * .4) };
  const chartW = width - pad.left - pad.right;
  const rowH = Math.max(16, Math.min(28, (height - pad.top - pad.bottom) / Math.max(rows.length, 1)));
  const isCost = metric.endsWith("_cost_usd");
  const max = chartScaleMax(rows.map((row) => row[metric]));
  state.chartPoints = [];
  hideChartTooltip();
  ctx.font = `700 12px ${chartMono}`;
  rows.forEach((row, index) => {
    const value = Number(row[metric] || 0);
    const y = pad.top + index * rowH;
    const barW = (value / max) * chartW;
    const barX = pad.left;
    const barY = y + 4;
    const barH = Math.max(8, rowH - 9);
    const label = isCost ? formatChartMoney(value) : compactNumber(value);
    const labelW = ctx.measureText(label).width;
    const labelY = y + rowH * 0.68;
    const fitsInside = barW > labelW + 18;

    ctx.fillStyle = chartColors.ink;
    ctx.fillText(truncate(String(row.key), Math.max(6, Math.floor(pad.left / 8) - 1)), 0, y + rowH * 0.68);
    ctx.fillStyle = chartColors.surface2;
    ctx.fillRect(barX, barY, chartW, barH);
    ctx.fillStyle = chartColors.blue;
    ctx.fillRect(barX, barY, barW, barH);

    if (fitsInside) {
      ctx.save();
      ctx.textAlign = "right";
      ctx.fillStyle = chartColors.surface;
      ctx.fillText(label, barX + barW - 10, labelY);
      ctx.restore();
    } else {
      const labelX = clamp(barX + barW + 8, barX + 8, barX + chartW - labelW - 6);
      ctx.fillStyle = chartColors.ink;
      ctx.fillText(label, labelX, labelY);
    }
  });
}

function drawGrid(ctx, pad, chartW, chartH, max, format) {
  ctx.strokeStyle = chartColors.grid;
  ctx.fillStyle = chartColors.muted;
  ctx.font = `11px ${chartMono}`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(format(max * (1 - i / 4)), pad.left - 12, y + 4);
  }
  ctx.textAlign = "left";
}

function makeSeriesPoints(rows, field, pad, chartW, chartH, max) {
  return rows.map((row, index) => {
    const x = pad.left + (rows.length === 1 ? chartW / 2 : (index / (rows.length - 1)) * chartW);
    const y = pad.top + chartH - (Number(row[field] || 0) / max) * chartH;
    return { x, y, value: Number(row[field] || 0) };
  });
}

function drawTrendArea(ctx, points, baseline, height) {
  if (!points.length) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${chartColors.blue}18`);
  gradient.addColorStop(1, `${chartColors.blue}00`);
  ctx.beginPath();
  traceLinePath(ctx, points);
  ctx.lineTo(points.at(-1).x, baseline);
  ctx.lineTo(points[0].x, baseline);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

function drawSeriesLine(ctx, points, color, options = {}) {
  if (!points.length) return;
  ctx.save();
  ctx.beginPath();
  traceLinePath(ctx, points);
  ctx.lineWidth = options.width || 2;
  ctx.strokeStyle = color;
  ctx.globalAlpha = options.alpha ?? 1;
  if (options.dash) ctx.setLineDash(options.dash);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

function traceLinePath(ctx, points) {
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
}

function drawOutputBars(ctx, rows, pad, chartW, chartH, max) {
  const baseline = pad.top + chartH;
  const barWidth = Math.max(2, Math.min(10, chartW / Math.max(rows.length, 1) * 0.38));
  ctx.save();
  ctx.fillStyle = chartColors.amber;
  ctx.globalAlpha = .65;
  rows.forEach((row, index) => {
    const x = pad.left + (rows.length === 1 ? chartW / 2 : (index / (rows.length - 1)) * chartW);
    const h = (Number(row.output_tokens || 0) / max) * chartH;
    ctx.fillRect(x - barWidth / 2, baseline - h, barWidth, h);
  });
  ctx.restore();
}

function drawXAxis(ctx, rows, pad, chartW, height) {
  const tickIndexes = pickTickIndexes(rows.length, chartW);
  ctx.fillStyle = chartColors.muted;
  ctx.font = `11px ${chartMono}`;
  ctx.textBaseline = "alphabetic";
  tickIndexes.forEach((index) => {
    const x = pad.left + (rows.length === 1 ? chartW / 2 : (index / (rows.length - 1)) * chartW);
    ctx.textAlign = index === 0 ? "left" : index === rows.length - 1 ? "right" : "center";
    ctx.fillText(formatAxisLabel(rows[index].key), x, height - 16);
  });
  ctx.textAlign = "left";
}

function pickTickIndexes(length, chartW) {
  if (length <= 1) return [0];
  const maxTicks = chartW < 560 ? 4 : chartW < 900 ? 6 : 8;
  const count = Math.min(length, maxTicks);
  const indexes = new Set();
  for (let i = 0; i < count; i += 1) {
    indexes.add(Math.round((i / (count - 1)) * (length - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

function formatAxisLabel(value) {
  const label = String(value);
  const dayMatch = label.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dayMatch) return `${dayMatch[2]}/${dayMatch[3]}`;
  const monthMatch = label.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) return `${monthMatch[1]}.${monthMatch[2]}`;
  return truncate(label, 12);
}

function drawPeakMarker(ctx, points, pad, chartW, format) {
  if (!points.length) return;
  const peakIndex = points.reduce((best, point, index) => (point.value > points[best].value ? index : best), 0);
  const peak = points[peakIndex];
  const label = `峰值 ${format(peak.value)}`;
  ctx.save();
  ctx.fillStyle = chartColors.surface;
  ctx.strokeStyle = chartColors.blue;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(peak.x, peak.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = `700 12px ${chartSans}`;
  const labelW = Math.ceil(ctx.measureText(label).width) + 16;
  const boxX = clamp(peak.x + 10, pad.left, pad.left + chartW - labelW);
  const boxY = Math.max(pad.top + 2, peak.y - 32);
  roundedRect(ctx, boxX, boxY, labelW, 24, 8);
  ctx.fillStyle = "rgba(31, 41, 55, 0.92)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, boxX + 8, boxY + 16);
  ctx.restore();
}

function drawHoverGuide(ctx, pad, chartH, points) {
  if (state.hoverIndex == null || !points[state.hoverIndex]) return;
  const point = points[state.hoverIndex];
  ctx.save();
  ctx.strokeStyle = "rgba(31, 41, 55, 0.24)";
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(point.x, pad.top);
  ctx.lineTo(point.x, pad.top + chartH);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = chartColors.surface;
  ctx.strokeStyle = chartColors.blue;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = chartColors.blue;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function renderMixChart(totals) {
  const { ctx, width, height } = setupCanvas(els.mixChart);
  ctx.clearRect(0, 0, width, height);
  if (state.data?.index?.hasSnapshot === false) {
    els.mixList.innerHTML = "";
    drawEmpty(ctx, width, height);
    return;
  }
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.43;
  const regularOutput = Math.max(0, Number(totals.output_tokens || 0) - Number(totals.reasoning_output_tokens || 0));
  const values = [
    { label: "普通输入", className: "input", value: Number(totals.uncached_input_tokens || 0), color: chartColors.cyan },
    { label: "缓存命中", className: "cached", value: Number(totals.cached_input_tokens || 0), color: chartColors.green },
    { label: "缓存写入", className: "cache-write", value: Number(totals.cache_write_input_tokens || 0), color: chartColors.blue },
    { label: "普通输出", className: "output", value: regularOutput, color: chartColors.amber },
    { label: "推理输出", className: "reasoning", value: Number(totals.reasoning_output_tokens || 0), color: chartColors.rose },
  ];
  const sum = values.reduce((acc, item) => acc + item.value, 0) || 1;
  els.mixList.innerHTML = values.map((item) => `<div><span><i class="swatch ${item.className}"></i>${item.label}</span><b title="${fullNumber(item.value)} Token">${compactNumber(item.value)}</b><em>${percent(item.value / sum)}</em></div>`).join("");
  let angle = -Math.PI / 2;
  values.forEach((item) => {
    const next = angle + (item.value / sum) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, angle, next);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    angle = next;
  });
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.76, 0, Math.PI * 2);
  ctx.fillStyle = chartColors.surface;
  ctx.fill();
  ctx.textAlign = "center";
  ctx.fillStyle = chartColors.ink;
  ctx.font = `600 19px ${chartMono}`;
  ctx.fillText(compactNumber(totals.total_tokens), centerX, centerY - 2);
  ctx.fillStyle = chartColors.muted;
  ctx.font = `12px ${chartSans}`;
  ctx.fillText("总 Token", centerX, centerY + 18);
  ctx.textAlign = "left";
}

function drawEmpty(ctx, width, height, message = state.data?.index?.hasSnapshot === false ? "正在建立索引" : "暂无数据") {
  ctx.fillStyle = chartColors.muted;
  ctx.font = `14px ${chartSans}`;
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
  ctx.textAlign = "left";
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function handleChartMove(event) {
  if (!state.data || !dateGroups.has(state.data.group) || !state.chartPoints.length) {
    hideChartTooltip();
    return;
  }
  const rect = els.usageChart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  let nearest = state.chartPoints[0];
  let minDistance = Math.abs(x - nearest.x);
  for (const point of state.chartPoints) {
    const distance = Math.abs(x - point.x);
    if (distance < minDistance) {
      nearest = point;
      minDistance = distance;
    }
  }

  if (state.hoverIndex !== nearest.index) {
    state.hoverIndex = nearest.index;
    renderMainChart(state.data.rows || [], state.data.group, state.data.sort);
  }
  showChartTooltip(nearest, rect);
}

function showChartTooltip(point, rect) {
  const row = point.row;
  const monetary = state.trendMetric === "cost";
  const fields = monetary ? [
    ["参考金额（基线）", formatChartMoney(row.reference_total_cost_usd)],
    ["按公开单价估算", formatChartMoney(row.estimated_cost_usd)],
    ["假设估算（已计入）", formatChartMoney(row.assumed_cost_usd)],
  ] : [
    ["总量", fullNumber(row.total_tokens)], ["输入", fullNumber(row.input_tokens)],
    ["输出", fullNumber(row.output_tokens)], ["缓存率", percent(row.cache_hit_ratio)],
  ];
  els.chartTooltip.innerHTML = `<strong>${escapeHtml(row.key)}</strong>` +
    fields.map(([label, value]) => `<span>${label}<em>${value}</em></span>`).join("") +
    (monetary && Number(row.unpriced_total_tokens || 0) > 0 ? `<p>${fullNumber(row.unpriced_total_tokens)} Token 未计价</p>` : "");
  const halfWidth = Math.min(120, rect.width / 2);
  els.chartTooltip.style.left = `${clamp(point.x, halfWidth, rect.width - halfWidth)}px`;
  els.chartTooltip.style.top = "12px";
  els.chartTooltip.hidden = false;
}

function hideChartTooltip() {
  if (els.chartTooltip) els.chartTooltip.hidden = true;
}

els.sourceSelect.addEventListener("change", () => applyFilters());
els.rangeSelect.addEventListener("change", () => {
  syncControls();
  applyFilters();
});
els.groupSelect.addEventListener("change", () => {
  syncSortForGroup();
  applyFilters();
});

els.sortSelect.addEventListener("change", () => {
  sortUserSelected = true;
  applyFilters();
});
els.directionSelect.addEventListener("change", () => applyFilters());
els.dedupeSelect.addEventListener("change", () => applyFilters());
els.limitInput.addEventListener("input", () => applyFilters({ debounce: true }));
els.fromInput.addEventListener("input", () => applyFilters({ debounce: true }));
els.toInput.addEventListener("input", () => applyFilters({ debounce: true }));
els.refreshButton.addEventListener("click", refreshIndex);
els.indexRetry.addEventListener("click", refreshIndex);
els.tableSearch.addEventListener("input", renderTable);
els.usageChart.addEventListener("pointermove", handleChartMove);
els.usageChart.addEventListener("pointerdown", handleChartMove);
els.usageChart.addEventListener("pointerleave", (event) => {
  // Touch pointers leave on release. Keep the selected day's data readable.
  if (event.pointerType === "touch") return;
  state.hoverIndex = null;
  hideChartTooltip();
  if (state.data) renderMainChart(state.data.rows || [], state.data.group, state.data.sort);
});
let resizeFrame = null;
window.addEventListener("resize", () => {
  if (resizeFrame != null) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    if (!state.data) return;
    state.hoverIndex = null;
    hideChartTooltip();
    renderChartSection();
    renderMixChart(state.data.totals || {});
  });
});
for (const button of els.rangePresets.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    els.rangeSelect.value = button.dataset.range;
    els.moreRanges.open = false;
    applyFilters();
  });
}
for (const [button, metric] of [[els.tokenMetric, "tokens"], [els.costMetric, "cost"]]) {
  button.addEventListener("click", () => {
    state.trendMetric = metric;
    state.hoverIndex = null;
    hideChartTooltip();
    renderChartSection();
  });
}
els.fullColumns.addEventListener("change", renderTable);
els.loadRetry.addEventListener("click", () => loadData({ blocking: true }));

syncControls();
syncSortForGroup({ force: true });
loadData({ blocking: true });
