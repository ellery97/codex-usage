const state = {
  data: null,
  rows: [],
  blockingLoading: false,
  chartPoints: [],
  hoverIndex: null,
};

const els = {
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
  assumedCostRow: document.getElementById("assumedCostRow"),
  assumedCost: document.getElementById("assumedCost"),
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
const chartSans =
  '"Noto Sans SC", "Fira Sans", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "WenQuanYi Micro Hei", sans-serif';
const chartMono =
  '"Fira Code", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "WenQuanYi Micro Hei", "SFMono-Regular", Consolas, "Liberation Mono", monospace';
const chartColors = {
  ink: "#1F2937",
  muted: "#64748B",
  surface: "#FFFFFF",
  surface2: "#EDF6F3",
  blue: "#4F67C8",
  cyan: "#2F8792",
  amber: "#D88A24",
  green: "#268466",
  rose: "#C04D67",
  grid: "#D8E5E1",
};

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
  for (const control of els.controlGrid.querySelectorAll("select, input, button")) {
    control.disabled = value;
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

async function loadData({ refreshIndex = false, blocking = false } = {}) {
  syncControls();
  window.clearTimeout(filterDebounce);
  filterDebounce = null;
  requestController?.abort();
  requestController = new AbortController();
  const requestId = ++requestSequence;
  if (blocking) {
    setFilterLoading(false);
    setBlockingLoading(
      true,
      refreshIndex ? "正在刷新本地索引并统计" : "正在读取本地索引",
    );
  } else {
    if (state.blockingLoading) setBlockingLoading(false);
    setFilterLoading(true);
  }
  try {
    const query = buildQuery();
    query.set("refreshIndex", refreshIndex ? "1" : "0");
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
  } catch (error) {
    if (error.name === "AbortError") return;
    showError(error.message);
  } finally {
    if (requestId === requestSequence) {
      if (blocking) setBlockingLoading(false);
      else setFilterLoading(false);
    }
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

  text.sourceLabel.textContent = formatSource(data.source);
  text.sourceLabel.title = sourceTitle(data.source);
  text.rangeLabel.textContent = `范围：${formatRange(data.range)}`;
  text.updatedLabel.textContent = `更新时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`;

  text.totalTokens.textContent = compactNumber(totals.total_tokens);
  text.totalSub.textContent = `${fullNumber(totals.requests)} 次请求`;
  text.inputTokens.textContent = compactNumber(totals.input_tokens);
  text.cachedInput.textContent = `${compactNumber(totals.cached_input_tokens)} 命中 · ${compactNumber(totals.cache_write_input_tokens)} 写入`;
  text.outputTokens.textContent = compactNumber(totals.output_tokens);
  text.reasoningOutput.textContent = `${compactNumber(totals.reasoning_output_tokens)} 推理输出`;
  text.cacheRatio.textContent = percent(totals.cache_hit_ratio);
  text.uncachedInput.textContent = `${compactNumber(totals.uncached_input_tokens)} 普通输入`;
  text.estimatedCost.textContent = money(totals.reference_total_cost_usd);
  text.estimatedCost.title = `参考区间 ${moneyRange(
    totals.reference_total_cost_usd,
    totals.reference_total_upper_bound_cost_usd,
  )}`;
  text.officialCost.textContent = money(totals.estimated_cost_usd);
  text.assumedCostRow.hidden = Number(totals.assumed_requests || 0) === 0;
  text.assumedCost.textContent = moneyRange(
    totals.assumed_cost_usd,
    totals.assumed_upper_bound_cost_usd,
  );
  text.costSub.textContent = costFootnote(totals, data.pricing);
  renderPricingWarning(data.pricing);

  text.sessionCount.textContent = fullNumber(totals.sessions);
  text.requestCount.textContent = fullNumber(totals.requests);
  text.fileCount.textContent = `${fullNumber(stats.filesWithUsage)} / ${fullNumber(stats.files)}`;
  text.globalDedupe.textContent = fullNumber(stats.globalDuplicateTokenEvents);
  text.scanMeta.textContent = scanSummary(stats);

  const groupLabel = groupName(data.group);
  const rowScope = dateGroups.has(data.group) && data.sort === "key" && data.desc ? `最新 ${fullNumber(data.rows.length)} 行` : `${fullNumber(data.rows.length)} 行`;
  text.mainChartTitle.textContent = dateGroups.has(data.group) ? "Token 用量趋势" : `${groupLabel}排行`;
  text.mainChartMeta.textContent = `${rowScope} · ${dedupeName(data.dedupeScope)}去重`;
  text.tableMeta.textContent = `${groupLabel} · ${fullNumber(data.rowCount || data.rows.length)} 个分组`;

  renderMainLegend(data.group, data.sort);
  renderMainChart(data.rows || [], data.group, data.sort);
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
  if (Number(totals.provisional_priced_requests || 0) > 0) {
    parts.push(
      `${fullNumber(totals.provisional_priced_requests)} 次 provisional · ${money(totals.provisional_estimated_cost_usd)}`,
    );
  }
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

function moneyRange(lower, upper) {
  const lowerValue = Number(lower || 0);
  const upperValue = Number(upper || 0);
  return Math.abs(lowerValue - upperValue) < 1e-9
    ? money(lowerValue)
    : `${money(lowerValue)}–${money(upperValue)}`;
}

function renderMainLegend(group, sort) {
  if (!els.mainLegend) return;
  const items = dateGroups.has(group)
    ? [
        ["legend-total", "总量"],
        ["legend-input", "输入"],
        ["legend-output", "输出"],
      ]
    : [[sort === "cost" ? "swatch reasoning" : "legend-total", sort === "cost" ? "参考金额" : "总量"]];
  els.mainLegend.innerHTML = items.map(([className, label]) => `<span><i class="${className}"></i>${label}</span>`).join("");
}

function formatRange(range) {
  if (!range || (!range.from && !range.to)) return "全部";
  const from = range.from ? range.from.slice(0, 10) : "开始";
  const to = range.to ? range.to.slice(0, 10) : "当前";
  return `${from} .. ${to}`;
}

function formatSource(source) {
  if (Array.isArray(source)) {
    if (source.length === 0) return "未发现可访问目录";
    if (source.length === 1) return source[0];
    return `${source.length} 个会话目录`;
  }
  return source || "未发现可访问目录";
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

function dedupeName(scope) {
  return scope === "file" ? "按文件" : "全局";
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
  const routes = models
    .flatMap((row) =>
      (row.routes?.length ? row.routes : [row]).map((route) => ({ ...route, model: row.model })),
    )
    .slice(0, 12);
  text.assumedModelList.innerHTML = routes
    .map(
      (row) => `
        <div class="model-price-card" title="${escapeHtml(row.label || "参考估算")}">
          <div class="model-price-route">
            <b>${escapeHtml(row.model)}</b>
            <em>${escapeHtml(row.effectiveFrom ? `自 ${row.effectiveFrom.slice(0, 10)}` : "历史基线")}</em>
          </div>
          <div class="assumption-models">
            <span><i>基线</i><b>${escapeHtml(row.assumedModel || "--")}</b></span>
            <span><i>上界</i><b>${escapeHtml(row.upperBoundModel || "--")}</b></span>
          </div>
          <div class="model-price-estimate">
            <strong>${moneyRange(row.assumed_cost_usd, row.assumed_upper_bound_cost_usd)}</strong>
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
  if (!rows.length) {
    tableBody.innerHTML = '<tr><td colspan="12" class="empty-cell">暂无数据</td></tr>';
    return;
  }
  tableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</td>
          <td>${fullNumber(row.sessions)}</td>
          <td>${fullNumber(row.requests)}</td>
          <td>${fullNumber(row.total_tokens)}</td>
          <td>${fullNumber(row.input_tokens)}</td>
          <td>${fullNumber(row.cached_input_tokens)}</td>
          <td>${fullNumber(row.cache_write_input_tokens)}</td>
          <td>${fullNumber(row.output_tokens)}</td>
          <td>${fullNumber(row.reasoning_output_tokens)}</td>
          <td title="${escapeHtml(costTitle(row))}">${money(row.estimated_cost_usd)}</td>
          <td title="${escapeHtml(costTitle(row))}">${money(row.reference_total_cost_usd)}</td>
          <td>${percent(row.cache_hit_ratio)}</td>
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
  const parts = [`官方金额 ${money(row.estimated_cost_usd)}`];
  if (Number(row.assumed_requests || 0) > 0) {
    parts.push(`假设金额 ${money(row.assumed_cost_usd)}–${money(row.assumed_upper_bound_cost_usd)}`);
  }
  parts.push(
    `参考合计 ${money(row.reference_total_cost_usd)}–${money(row.reference_total_upper_bound_cost_usd)}`,
  );
  if (Number(row.unpriced_total_tokens || 0) > 0) {
    parts.push(`${fullNumber(row.unpriced_total_tokens)} Token 未计价`);
  }
  return parts.join(" · ");
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(280, rect.width || canvas.clientWidth || 600);
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
    drawBars(ctx, width, height, rows.slice(0, 18), sort === "cost" ? "reference_total_cost_usd" : "total_tokens");
  }
}

function compareDateRowsAsc(a, b) {
  return String(a.key).localeCompare(String(b.key));
}

function drawTrend(ctx, width, height, rows) {
  const pad = { top: 18, right: 34, bottom: 48, left: 72 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...rows.flatMap((row) => [row.total_tokens, row.input_tokens]), 1));
  const baseline = pad.top + chartH;
  const totalPoints = makeSeriesPoints(rows, "total_tokens", pad, chartW, chartH, max);
  const inputPoints = makeSeriesPoints(rows, "input_tokens", pad, chartW, chartH, max);
  state.chartPoints = totalPoints.map((point, index) => ({ ...point, index, row: rows[index] }));

  drawGrid(ctx, pad, chartW, chartH, max);
  drawTrendArea(ctx, totalPoints, baseline, height);
  drawOutputBars(ctx, rows, pad, chartW, chartH);
  drawSmoothLine(ctx, inputPoints, chartColors.cyan, { width: 2, alpha: 0.74, dash: [6, 6] });
  drawSmoothLine(ctx, totalPoints, chartColors.blue, { width: 3.2, alpha: 1 });
  drawPeakMarker(ctx, totalPoints, rows, pad, chartW);
  drawHoverGuide(ctx, pad, chartH, totalPoints, rows);
  drawXAxis(ctx, rows, pad, chartW, height);
}

function drawBars(ctx, width, height, rows, metric = "total_tokens") {
  const pad = { top: 8, right: 22, bottom: 16, left: 150 };
  const chartW = width - pad.left - pad.right;
  const rowH = Math.max(16, Math.min(28, (height - pad.top - pad.bottom) / Math.max(rows.length, 1)));
  const isCost = metric.endsWith("_cost_usd");
  const max = Math.max(...rows.map((row) => Number(row[metric] || 0)), 1);
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
    const label = isCost ? money(value) : compactNumber(value);
    const labelW = ctx.measureText(label).width;
    const labelY = y + rowH * 0.68;
    const fitsInside = barW > labelW + 18;

    ctx.fillStyle = chartColors.ink;
    ctx.fillText(truncate(String(row.key), 20), 0, y + rowH * 0.68);
    ctx.fillStyle = chartColors.surface2;
    ctx.fillRect(barX, barY, chartW, barH);
    ctx.fillStyle = isCost ? chartColors.rose : chartColors.blue;
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

function drawGrid(ctx, pad, chartW, chartH, max) {
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
    ctx.fillText(compactNumber(max * (1 - i / 4)), pad.left - 12, y + 4);
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

function niceMax(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * base;
}

function drawTrendArea(ctx, points, baseline, height) {
  if (!points.length) return;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(79, 103, 200, 0.20)");
  gradient.addColorStop(0.55, "rgba(47, 135, 146, 0.08)");
  gradient.addColorStop(1, "rgba(79, 103, 200, 0)");
  ctx.beginPath();
  traceSmoothPath(ctx, points);
  ctx.lineTo(points.at(-1).x, baseline);
  ctx.lineTo(points[0].x, baseline);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

function drawSmoothLine(ctx, points, color, options = {}) {
  if (!points.length) return;
  ctx.save();
  ctx.beginPath();
  traceSmoothPath(ctx, points);
  ctx.lineWidth = options.width || 2;
  ctx.strokeStyle = color;
  ctx.globalAlpha = options.alpha ?? 1;
  if (options.dash) ctx.setLineDash(options.dash);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

function traceSmoothPath(ctx, points) {
  if (points.length === 1) {
    ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const midX = (points[index].x + points[index + 1].x) / 2;
    const midY = (points[index].y + points[index + 1].y) / 2;
    ctx.quadraticCurveTo(points[index].x, points[index].y, midX, midY);
  }
  const last = points.at(-1);
  ctx.lineTo(last.x, last.y);
}

function drawOutputBars(ctx, rows, pad, chartW, chartH) {
  const maxOutput = Math.max(...rows.map((row) => Number(row.output_tokens || 0)), 1);
  const baseline = pad.top + chartH;
  const bandHeight = Math.min(58, chartH * 0.18);
  const barWidth = Math.max(2, Math.min(10, chartW / Math.max(rows.length, 1) * 0.38));
  ctx.save();
  ctx.strokeStyle = "rgba(216, 138, 36, 0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, baseline - bandHeight);
  ctx.lineTo(pad.left + chartW, baseline - bandHeight);
  ctx.stroke();
  rows.forEach((row, index) => {
    const x = pad.left + (rows.length === 1 ? chartW / 2 : (index / (rows.length - 1)) * chartW);
    const h = (Number(row.output_tokens || 0) / maxOutput) * bandHeight;
    ctx.fillStyle = "rgba(216, 138, 36, 0.56)";
    ctx.fillRect(x - barWidth / 2, baseline - h, barWidth, h);
  });
  ctx.fillStyle = "rgba(100, 116, 139, 0.76)";
  ctx.font = `11px ${chartSans}`;
  ctx.textAlign = "right";
  ctx.fillText("输出", pad.left - 12, baseline - bandHeight + 4);
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

function drawPeakMarker(ctx, points, rows, pad, chartW) {
  if (!points.length) return;
  const peakIndex = points.reduce((best, point, index) => (point.value > points[best].value ? index : best), 0);
  const peak = points[peakIndex];
  const label = `峰值 ${compactNumber(rows[peakIndex].total_tokens)}`;
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

function drawHoverGuide(ctx, pad, chartH, points, rows) {
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
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.35;
  const regularOutput = Math.max(0, Number(totals.output_tokens || 0) - Number(totals.reasoning_output_tokens || 0));
  const values = [
    { value: totals.uncached_input_tokens || 0, color: chartColors.cyan },
    { value: totals.cached_input_tokens || 0, color: chartColors.green },
    { value: totals.cache_write_input_tokens || 0, color: chartColors.blue },
    { value: regularOutput, color: chartColors.amber },
    { value: totals.reasoning_output_tokens || 0, color: chartColors.rose },
  ];
  const sum = values.reduce((acc, item) => acc + item.value, 0) || 1;
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
  ctx.arc(centerX, centerY, radius * 0.58, 0, Math.PI * 2);
  ctx.fillStyle = chartColors.surface;
  ctx.fill();
  ctx.textAlign = "center";
  ctx.fillStyle = chartColors.ink;
  ctx.font = `700 22px ${chartMono}`;
  ctx.fillText(percent(totals.cache_hit_ratio), centerX, centerY - 2);
  ctx.fillStyle = chartColors.muted;
  ctx.font = `12px ${chartSans}`;
  ctx.fillText("缓存命中", centerX, centerY + 18);
  ctx.textAlign = "left";
}

function drawEmpty(ctx, width, height) {
  ctx.fillStyle = chartColors.muted;
  ctx.font = `14px ${chartSans}`;
  ctx.textAlign = "center";
  ctx.fillText("暂无数据", width / 2, height / 2);
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
  if (minDistance > 42) {
    hideChartTooltip();
    return;
  }

  if (state.hoverIndex !== nearest.index) {
    state.hoverIndex = nearest.index;
    renderMainChart(state.data.rows || [], state.data.group, state.data.sort);
  }
  showChartTooltip(nearest, rect);
}

function showChartTooltip(point, rect) {
  const row = point.row;
  els.chartTooltip.innerHTML = `
    <strong>${escapeHtml(row.key)}</strong>
    <span>总量 <em>${fullNumber(row.total_tokens)}</em></span>
    <span>输入 <em>${fullNumber(row.input_tokens)}</em></span>
    <span>缓存写入 <em>${fullNumber(row.cache_write_input_tokens)}</em></span>
    <span>输出 <em>${fullNumber(row.output_tokens)}</em></span>
    <span>推理 <em>${fullNumber(row.reasoning_output_tokens)}</em></span>
    <span>参考金额 <em>${money(row.reference_total_cost_usd)}</em></span>
    <span>官方金额 <em>${money(row.estimated_cost_usd)}</em></span>
    <span>缓存率 <em>${percent(row.cache_hit_ratio)}</em></span>
  `;
  els.chartTooltip.style.left = `${clamp(point.x, 104, rect.width - 104)}px`;
  els.chartTooltip.style.top = `${clamp(point.y, 64, rect.height - 12)}px`;
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
els.refreshButton.addEventListener("click", () => loadData({ refreshIndex: true, blocking: true }));
els.tableSearch.addEventListener("input", renderTable);
els.usageChart.addEventListener("mousemove", handleChartMove);
els.usageChart.addEventListener("mouseleave", () => {
  state.hoverIndex = null;
  hideChartTooltip();
  if (state.data) renderMainChart(state.data.rows || [], state.data.group, state.data.sort);
});
window.addEventListener("resize", () => {
  if (state.data) render();
});

syncControls();
syncSortForGroup({ force: true });
loadData({ blocking: true });

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    if (state.data) render();
  });
}
