import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { formatRange, rankingMetricForSort, chartScaleMax, formatChartMoney, groupScopeLabel } from "../public/dashboard-formatters.js";

const appSource = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/^import[^\n]*\n/, "");
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Execute the actual application with controlled network ordering and timers.
// Canvas/DOM stubs cover state rendering, not browser layout or interaction QA.
function dashboard() {
  const elements = new Map(), requests = [], timers = new Map();
  let nextTimer = 0;
  const canvasLabels = [];
  const canvas = new Proxy({
    fillText: (label) => canvasLabels.push(label),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (value) => ({ width: String(value).length * 7 }),
  }, {
    get: (target, key) => target[key] || (() => {}),
    set: (target, key, value) => { target[key] = value; return true; },
  });
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: "", hidden: true, disabled: false, textContent: "", style: {}, dataset: {}, listeners: {},
      classList: { values: new Map(), toggle(key, value) { this.values.set(key, value); } },
      querySelectorAll: () => [], attributes: {}, checked: false,
      setAttribute(key, value) { this.attributes[key] = value; },
      setCustomValidity(value) { this.validationMessage = value; }, reportValidity() {},
      addEventListener(event, handler) { this.listeners[event] = handler; },
      replaceChildren(...children) { this.children = children; },
      getBoundingClientRect: () => ({ width: 600, height: 260, left: 0, top: 0 }), getContext: () => canvas,
    });
    return elements.get(id);
  }
  for (const [id, value] of Object.entries({
    sourceSelect: "windows", rangeSelect: "all", groupSelect: "day", sortSelect: "key",
    directionSelect: "desc", dedupeSelect: "global", limitInput: "0",
  })) element(id).value = value;
  element("rangePresets").querySelectorAll = () => ["today", "7d", "30d", "all"].map((range) => {
    const button = element(`preset-${range}`);
    button.dataset.range = range;
    return button;
  });
  const context = vm.createContext({
    URLSearchParams, AbortController, formatRange, rankingMetricForSort, chartScaleMax, formatChartMoney, groupScopeLabel,
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: () => ({ textContent: "" }) },
    window: {
      devicePixelRatio: 1, addEventListener() {},
      setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    // Deliberately allow an aborted request to settle late, exercising response
    // ownership even if cancellation races with response decoding.
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({
      url, signal: options.signal, reject,
      respond: (payload) => resolve({ ok: true, json: async () => payload }),
    })),
  });
  vm.runInContext(appSource, context);
  const polls = () => [...timers].filter(([, timer]) => timer.delay === 1000);
  return {
    element, polls, canvasLabels, requests,
    evaluate: (source) => vm.runInContext(source, context),
    request(endpoint) {
      const i = requests.findIndex((request) => request.url.startsWith(endpoint));
      assert.ok(i >= 0, `Missing request: ${endpoint}`);
      return requests.splice(i, 1)[0];
    },
    firePoll() {
      assert.equal(polls().length, 1, "Exactly one status poll should be scheduled");
      const [id, timer] = polls()[0];
      timers.delete(id);
      return timer.fn();
    },
    changeSource(source) {
      element("sourceSelect").value = source;
      element("sourceSelect").listeners.change();
    },
    refresh: () => element("refreshButton").listeners.click(),
  };
}

function status(revision, running, { failedFiles = 0, pricingRefresh } = {}) {
  return {
    revision, running, failedFiles, pricingRefresh, hasSnapshot: true,
    incomplete: running || failedFiles > 0, state: running ? "running" : "complete",
    failures: failedFiles ? [{ path: "synthetic.jsonl.zst", message: "corrupt frame", usingPreviousIndex: false }] : [],
  };
}
function usage(index, pricing = {}) {
  return { index, pricing, rows: [], totals: {}, stats: {}, group: "day", sort: "key", timezone: "UTC", dedupeScope: "global" };
}
async function boot(initialStatus) {
  const app = dashboard();
  app.request("/api/usage?").respond(usage(initialStatus));
  await flush();
  assert.equal(app.element("errorToast").textContent, "");
  return app;
}

for (const lateResult of ["response", "error"]) {
  test(`a late old-source status ${lateResult} cannot hide current failures`, async () => {
    const app = await boot(status(1, true));
    const polling = app.firePoll();
    const oldRequest = app.request("/api/index/status?");
    app.changeSource("wsl");
    app.request("/api/usage?").respond(usage(status(2, false, { failedFiles: 1 })));
    await flush();
    if (lateResult === "response") oldRequest.respond(status(2, false));
    else oldRequest.reject(new Error("old source disconnected"));
    await polling;
    assert.equal(app.element("sourceSelect").value, "wsl");
    assert.equal(app.element("indexStatus").hidden, false);
    assert.match(app.element("indexMessage").textContent, /1 个文件读取失败/);
    assert.equal(app.element("indexRetry").hidden, false);
    assert.equal(app.element("indexFailures").hidden, false);
    assert.equal(app.element("errorToast").textContent, "");
    assert.equal(app.polls().length, 0);
    assert.equal(oldRequest.signal.aborted, true);
  });
}

test("switching away and back discards old polls without disrupting the new source's poll", async () => {
  const app = await boot(status(1, true));
  const oldPoll = app.firePoll();
  const oldRequest = app.request("/api/index/status?");
  app.changeSource("wsl");
  const abandonedUsage = app.request("/api/usage?");
  app.changeSource("windows");
  app.request("/api/usage?").respond(usage(status(2, true)));
  await flush();
  const currentPoll = app.firePoll();
  const currentRequest = app.request("/api/index/status?");
  oldRequest.respond(status(2, false));
  abandonedUsage.respond(usage(status(1, false)));
  await oldPoll;
  assert.equal(app.element("refreshButton").disabled, true);
  assert.equal(app.polls().length, 0, "The current request still owns polling");
  currentRequest.respond(status(2, true));
  await currentPoll;
  assert.equal(app.polls().length, 1);
  assert.equal(app.element("errorToast").textContent, "");
});

test("polling continues when a usage reload observes the next refresh already running", async () => {
  const app = await boot(status(1, true));
  const polling = app.firePoll();
  app.request("/api/index/status?").respond(status(2, false));
  await flush();
  app.request("/api/usage?").respond(usage(status(2, true)));
  await polling;
  assert.equal(app.element("refreshButton").disabled, true);
  assert.equal(app.polls().length, 1);

  const next = app.firePoll();
  app.request("/api/index/status?").respond(status(3, false));
  await flush();
  app.request("/api/usage?").respond(usage(status(3, false)));
  await next;
  assert.equal(app.element("refreshButton").disabled, false);
  assert.equal(app.element("indexStatus").hidden, true);
  assert.equal(app.polls().length, 0);
});

test("a late manual refresh response cannot overwrite a new source's failure status", async () => {
  const app = await boot(status(1, false));
  const refreshing = app.refresh();
  const oldRequest = app.request("/api/index/refresh?");
  app.changeSource("wsl");
  app.request("/api/usage?").respond(usage(status(2, false, { failedFiles: 1 })));
  await flush();
  oldRequest.respond(status(2, true));
  await refreshing;
  assert.match(app.element("indexMessage").textContent, /1 个文件读取失败/);
  assert.equal(app.element("indexRetry").hidden, false);
  assert.equal(app.element("refreshButton").disabled, false);
  assert.equal(app.polls().length, 0);
});

test("manual refresh supersedes an in-flight usage response", async () => {
  const app = await boot(status(1, false));
  app.changeSource("wsl");
  const oldUsage = app.request("/api/usage?");
  const refreshing = app.refresh();
  app.request("/api/index/refresh?").respond(status(2, true));
  await refreshing;
  oldUsage.respond(usage(status(1, false)));
  await flush();
  assert.equal(oldUsage.signal.aborted, true);
  assert.equal(app.element("indexStatus").hidden, false);
  assert.equal(app.element("refreshButton").disabled, true);
  assert.equal(app.polls().length, 1);
  assert.equal(app.element("filterStatus").hidden, true);
});

for (const usedFallback of [false, true]) {
  test(`pricing completion reloads the page without an index revision change (fallback=${usedFallback})`, async () => {
    const pending = status(1, false, { pricingRefresh: { running: true, revision: 0 } });
    const done = status(1, false, { pricingRefresh: { running: false, revision: 1 } });
    const app = await boot(pending);
    const polling = app.firePoll();
    app.request("/api/index/status?").respond(done);
    await flush();
    app.request("/api/usage?").respond(usage(done, {
      refreshStatus: usedFallback ? "cached" : "fresh", usedFallback,
      warning: usedFallback ? "Synthetic pricing failure" : null,
      checkedAt: "2026-10-22T10:00:00Z",
    }));
    await polling;
    assert.equal(app.element("pricingWarning").hidden, !usedFallback);
    assert.match(app.element("costSub").textContent, usedFallback ? /缓存/ : /实时/);
    assert.equal(app.polls().length, 0);
    assert.equal(app.element("refreshButton").disabled, false);
    assert.equal(app.element("errorToast").textContent, "");
  });
}

test("a current status request failure keeps the incomplete warning and offers retry", async () => {
  const app = await boot(status(1, true));
  const polling = app.firePoll();
  app.request("/api/index/status?").reject(new Error("Synthetic status failure"));
  await polling;
  assert.equal(app.element("indexStatus").hidden, false);
  assert.equal(app.element("indexRetry").hidden, false);
  assert.equal(app.element("refreshButton").disabled, false);
  assert.equal(app.element("errorToast").textContent, "Synthetic status failure");
  assert.equal(app.polls().length, 0);
});

// Synthetic amounts distinguish the included subset from additive components.
function costUsage(totals = {}, assumedModels = []) {
  return {
    ...usage(status(1, false)),
    totals, assumedModels,
    rows: [{ key: "synthetic", ...totals }],
  };
}

const mixedCosts = {
  estimated_cost_usd: 100,
  provisional_priced_requests: 3,
  provisional_estimated_cost_usd: 40,
  assumed_requests: 2,
  assumed_cost_usd: 2,
  assumed_upper_bound_cost_usd: 10,
  reference_total_cost_usd: 102,
  reference_total_upper_bound_cost_usd: 110,
};

async function bootCosts(totals = mixedCosts, models = []) {
  const app = dashboard();
  app.request("/api/usage?").respond(costUsage(totals, models));
  await flush();
  assert.equal(app.element("errorToast").textContent, "");
  return app;
}

test("cost cards distinguish an included provisional subset from the assumed baseline", async () => {
  const app = await bootCosts();
  assert.equal(app.element("estimatedCost").textContent, "$102.00");
  assert.equal(app.element("officialCost").textContent, "$100.00");
  assert.equal(app.element("provisionalCostRow").hidden, false);
  assert.equal(app.element("provisionalCost").textContent, "$40.00");
  assert.equal(app.element("assumedCostRow").hidden, false);
  assert.equal(app.element("assumedCost").textContent, "+$2.00");
  assert.equal(app.element("costEquation").textContent, "$102.00 ≈ $100.00 + $2.00（显示值已四舍五入）");
  assert.match(app.element("provisionalExplanation").textContent, /3 次请求.*\$40\.00 已包含.*无需再次相加/);
  assert.match(app.element("alternativeCost").textContent, /\$10\.00.*总额为 \$110\.00.*不额外叠加/);
  assert.doesNotMatch(app.element("costSub").textContent, /provisional|\$40|\$10/);
  assert.doesNotMatch(app.element("usageTable").innerHTML, /官方金额|\$110|–/);
  assert.match(app.element("usageTable").innerHTML, /历史生效日期待确认 \$40\.00（已包含）/);
});

for (const [name, totals, hasProvisional, hasAssumed] of [
  ["published rates only", { estimated_cost_usd: 5, reference_total_cost_usd: 5 }, false, false],
  ["provisional only", { estimated_cost_usd: 5, reference_total_cost_usd: 5, provisional_priced_requests: 1, provisional_estimated_cost_usd: 5 }, true, false],
  ["assumed only", { assumed_requests: 1, assumed_cost_usd: 2, assumed_upper_bound_cost_usd: 2, reference_total_cost_usd: 2, reference_total_upper_bound_cost_usd: 2 }, false, true],
  ["zero cost requests", { assumed_requests: 1, provisional_priced_requests: 1 }, true, true],
  ["empty result", {}, false, false],
  ["unpriced tokens", { unpriced_total_tokens: 1200 }, false, false],
]) {
  test(`cost explanations update after changing filters to ${name}`, async () => {
    const app = await bootCosts(mixedCosts, [{ model: "old-model", assumedModel: "old-baseline" }]);
    app.element("costDetails").open = true;
    app.changeSource("wsl");
    app.request("/api/usage?").respond(costUsage(totals));
    await flush();
    assert.equal(app.element("errorToast").textContent, "");
    assert.equal(app.element("provisionalCostRow").hidden, !hasProvisional);
    assert.equal(app.element("provisionalExplanation").hidden, !hasProvisional);
    assert.equal(app.element("assumedCostRow").hidden, !hasAssumed);
    assert.equal(app.element("costDetails").open, true, "Refreshing data preserves the user's expanded state");
    assert.equal(app.element("assumedModelList").innerHTML, "");
    if (!hasProvisional) assert.equal(app.element("provisionalExplanation").textContent, "");
    if (!hasAssumed) assert.equal(app.element("alternativeCost").textContent, "");
    assert.doesNotMatch(app.element("costEquation").textContent, /\$102|\$100|\$40/);
    if (totals.unpriced_total_tokens) assert.match(app.element("costSub").textContent, /1\.2K Token 未计价/);
  });
}

test("estimate details retain every period and associate each scenario with its model and amount", async () => {
  const models = [{
    model: "synthetic-review",
    routes: [
      { assumedModel: "baseline-a", upperBoundModel: "comparison-a", effectiveFrom: "2026-04-01T00:00:00Z", assumed_cost_usd: 1.25, assumed_upper_bound_cost_usd: 6 },
      { assumedModel: "baseline-b", upperBoundModel: "comparison-b", effectiveFrom: "2026-07-01T00:00:00Z", assumed_cost_usd: 0.75, assumed_upper_bound_cost_usd: 4 },
    ],
  }];
  const app = await bootCosts(mixedCosts, models);
  const html = app.element("assumedModelList").innerHTML;
  assert.equal(app.element("assumedBlock").hidden, false);
  assert.match(html, /方案起始 2026-04-01 UTC/);
  assert.match(html, /方案起始 2026-07-01 UTC/);
  assert.match(html, /基线方案（已计入）.*baseline-a.*\$1\.25/);
  assert.match(html, /另一参考方案.*comparison-a.*\$6\.00/);
  assert.match(html, /基线方案（已计入）.*baseline-b.*\$0\.7500/);
  assert.match(html, /另一参考方案.*comparison-b.*\$4\.00/);
  assert.doesNotMatch(html, /上界|–/);
});

test("cost explanations stay hidden while the first index is being built", async () => {
  const app = dashboard();
  app.request("/api/usage?").respond({
    ...costUsage(mixedCosts), index: { ...status(0, true), hasSnapshot: false },
  });
  await flush();
  assert.equal(app.element("estimatedCost").textContent, "--");
  assert.equal(app.element("costDetails").hidden, true);
  assert.equal(app.element("provisionalCostRow").hidden, true);
  assert.equal(app.element("assumedCostRow").hidden, true);
  const polling = app.firePoll();
  app.request("/api/index/status?").respond(status(1, false));
  await flush();
  app.request("/api/usage?").respond(costUsage(mixedCosts));
  await polling;
  assert.equal(app.element("estimatedCost").textContent, "$102.00");
  assert.equal(app.element("costDetails").hidden, false);
  assert.equal(app.element("provisionalCostRow").hidden, false);
  assert.equal(app.element("assumedCostRow").hidden, false);
});

async function bootTrend(rows, extra = {}) {
  const app = dashboard();
  app.request("/api/usage?").respond({
    ...usage(status(1, false)), rows, rowCount: 12,
    totals: { total_tokens: 10000, input_tokens: 9000, output_tokens: 1000, reference_total_cost_usd: .003, unpriced_total_tokens: 200 }, ...extra,
  });
  await flush();
  assert.equal(app.element("errorToast").textContent, "");
  return app;
}
const trendRows = [
  { key: "2026-10-22", total_tokens: 2000, input_tokens: 1800, output_tokens: 200, reference_total_cost_usd: .001, estimated_cost_usd: .0008, assumed_cost_usd: .0002, unpriced_total_tokens: 20 },
  { key: "2026-10-21", total_tokens: 1000, input_tokens: 900, output_tokens: 100, reference_total_cost_usd: .00003 },
];

test("switching trend metrics changes currency scale, peak, legend and touch tooltip without requests", async () => {
  const app = await bootTrend(trendRows);
  const total = app.element("totalTokens").textContent;
  app.canvasLabels.length = 0;
  app.element("costMetric").listeners.click();
  assert.equal(app.element("mainChartTitle").textContent, "参考金额趋势");
  assert.equal(app.element("costMetric").attributes["aria-pressed"], "true");
  assert.match(app.element(".legend").innerHTML, /USD/);
  assert.match(app.element("chartNote").textContent, /200 Token 未计价.*金额不完整/);
  assert.ok(app.canvasLabels.includes("峰值 $0.001"));
  assert.ok(app.canvasLabels.includes("$0.0005"));
  assert.ok(!app.canvasLabels.includes("峰值 2.0K"));
  assert.deepEqual(JSON.parse(app.evaluate("JSON.stringify(state.chartPoints.map(p => p.value))")), [.00003, .001]);
  // A tiny amount still occupies meaningful vertical space, and touches select
  // the nearest point even when the series has only a few days.
  const point = app.evaluate("state.chartPoints[1]");
  assert.ok(point.y < 30, "a fractional-dollar peak must not be flattened against a $1 minimum");
  app.element("usageChart").listeners.pointerdown({ clientX: point.x - 60 });
  assert.equal(app.element("chartTooltip").hidden, false);
  assert.match(app.element("chartTooltip").innerHTML, /参考金额（基线）.*\$0\.001/);
  assert.match(app.element("chartTooltip").innerHTML, /20 Token 未计价/);
  app.element("usageChart").listeners.pointerleave({ pointerType: "touch" });
  assert.equal(app.element("chartTooltip").hidden, false, "touch release keeps the tooltip visible");
  app.element("tokenMetric").listeners.click();
  assert.equal(app.element("chartTooltip").hidden, true);
  assert.equal(app.element("mainChartTitle").textContent, "Token 用量趋势");
  assert.equal(app.element("totalTokens").textContent, total);
  assert.equal(app.requests.length, 0);
});

for (const [name, rows] of [["empty", []], ["zero", [{key:"2026-10-21",reference_total_cost_usd:0}]], ["single tiny point", [trendRows[1]]]]) {
  test(`amount trend handles ${name} data`, async () => {
    const app = await bootTrend(rows);
    app.element("costMetric").listeners.click();
    assert.ok(app.evaluate("state.chartPoints.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))"));
    assert.equal(app.evaluate("state.chartPoints.length"), rows.length);
    if (rows.length === 0) assert.ok(app.canvasLabels.includes("暂无数据"));
    else assert.ok(app.canvasLabels.some(label => label === `峰值 ${formatChartMoney(rows[0].reference_total_cost_usd)}`));
    assert.equal(app.requests.length, 0);
  });
}

test("non-date groups hide the trend switch and follow the ranking sort, preserving the chosen trend", async () => {
  const app = await bootTrend(trendRows);
  app.element("costMetric").listeners.click();
  app.element("groupSelect").value = "model";
  app.element("groupSelect").listeners.change();
  const request = app.request("/api/usage?");
  assert.match(request.url, /group=model/);
  assert.match(request.url, /sort=total/);
  request.respond({...usage(status(1, false)), group:"model", sort:"cost", rows:[{...trendRows[1],key:"synthetic-model"}]});
  await flush();
  assert.equal(app.element("chartMetric").hidden, true);
  assert.match(app.element(".legend").innerHTML, /参考金额/);
  assert.ok(app.canvasLabels.includes("$0.00003"));
  app.element("groupSelect").value = "month";
  app.element("groupSelect").listeners.change();
  app.request("/api/usage?").respond({...usage(status(1, false)),group:"month",rows:trendRows});
  await flush();
  assert.equal(app.element("chartMetric").hidden, false);
  assert.equal(app.element("mainChartTitle").textContent, "参考金额趋势");
});

test("row limits, local search and full columns never change summary totals or request more data", async () => {
  const app = await bootTrend(trendRows);
  assert.equal(app.element("tableMeta").textContent, "展示 2 / 共 12 个分组");
  assert.match(app.element("mainChartMeta").textContent, /展示 2 \/ 共 12 个分组/);
  const total = app.element("totalTokens").textContent;
  app.element("tableSearch").value = "2026-10-21";
  app.element("tableSearch").listeners.input();
  assert.match(app.element("tableMeta").textContent, /搜索匹配 1 个（仅已加载分组）/);
  assert.doesNotMatch(app.element("usageTable").innerHTML, /2026-10-22/);
  app.element("fullColumns").checked = true;
  app.element("fullColumns").listeners.change();
  assert.equal(app.element("tableWrap").classList.values.get("show-full"), true);
  assert.match(app.element("usageTable").innerHTML, /class="detail-column"/);
  app.element("tableSearch").value = "missing";
  app.element("tableSearch").listeners.input();
  assert.match(app.element("usageTable").innerHTML, /colspan="12".*没有匹配结果/);
  assert.equal(app.element("totalTokens").textContent, total);
  assert.equal(app.requests.length, 0);
});

test("range presets issue one cached query and custom dates reject reversed bounds", async () => {
  const app = await boot(status(1, false));
  app.element("preset-30d").listeners.click();
  const request = app.request("/api/usage?");
  assert.match(request.url, /range=30d/);
  assert.match(request.url, /refreshIndex=0/);
  request.respond(usage(status(1, false)));
  await flush();
  assert.equal(app.element("preset-30d").attributes["aria-pressed"], "true");
  assert.equal(app.element("moreRanges").open, false);
  app.element("rangeSelect").value = "custom";
  app.element("rangeSelect").listeners.change();
  assert.equal(app.requests.length, 0, "empty custom dates do not issue an accidental all-time query");
  app.element("fromInput").value = "2026-10-28";
  app.element("toInput").value = "2026-10-21";
  app.element("rangeSelect").listeners.change();
  assert.match(app.element("toInput").validationMessage, /不能早于/);
  assert.equal(app.requests.length, 0);
  app.element("toInput").value = "2026-10-29";
  app.element("rangeSelect").listeners.change();
  const valid = app.request("/api/usage?");
  assert.match(valid.url, /from=2026-10-28&to=2026-10-29/);
  valid.respond(usage(status(1, false)));
  await flush();
  app.element("dedupeSelect").value = "file";
  app.element("dedupeSelect").listeners.change();
  assert.equal(app.element("dedupeWarning").hidden, false);
  app.request("/api/usage?").respond(usage(status(1, false)));
  await flush();
});

test("initial load errors stay visible and can be retried without refreshing the index", async () => {
  const app = dashboard();
  app.request("/api/usage?").reject(new Error("Synthetic usage failure"));
  await flush();
  assert.equal(app.element("loadingOverlay").hidden, true);
  assert.equal(app.element("loadError").hidden, false);
  assert.equal(app.element("loadErrorMessage").textContent, "Synthetic usage failure");
  app.element("loadRetry").listeners.click();
  app.request("/api/usage?").respond(usage(status(1, false)));
  await flush();
  assert.equal(app.element("loadError").hidden, true);
  assert.equal(app.requests.length, 0);
});
