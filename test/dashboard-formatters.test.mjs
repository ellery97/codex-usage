import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRange,
  rankingMetricForSort,
} from "../public/dashboard-formatters.js";

test("dashboard ranges render date bounds in the payload timezone", () => {
  assert.equal(
    formatRange({ from: "2026-08-19T16:00:00Z", to: null }, "Asia/Shanghai"),
    "2026-08-20 .. 当前",
  );
  assert.equal(
    formatRange(
      { from: null, to: "2026-08-21T06:59:59.999Z" },
      "America/Los_Angeles",
    ),
    "开始 .. 2026-08-20",
  );
  assert.equal(formatRange({ from: null, to: null }, "UTC"), "全部");
});

test("ranking chart metrics follow the selected numeric sort", () => {
  assert.deepEqual(rankingMetricForSort("total"), {
    field: "total_tokens",
    label: "Token 总量",
  });
  assert.deepEqual(rankingMetricForSort("input"), {
    field: "input_tokens",
    label: "输入 Token",
  });
  assert.deepEqual(rankingMetricForSort("cached"), {
    field: "cached_input_tokens",
    label: "缓存输入",
  });
  assert.deepEqual(rankingMetricForSort("output"), {
    field: "output_tokens",
    label: "输出 Token",
  });
  assert.deepEqual(rankingMetricForSort("reasoning"), {
    field: "reasoning_output_tokens",
    label: "推理输出",
  });
  assert.deepEqual(rankingMetricForSort("requests"), {
    field: "requests",
    label: "请求数",
  });
  assert.deepEqual(rankingMetricForSort("sessions"), {
    field: "sessions",
    label: "会话数",
  });
  assert.deepEqual(rankingMetricForSort("cost"), {
    field: "reference_total_cost_usd",
    label: "参考金额",
  });
  assert.deepEqual(rankingMetricForSort("key"), {
    field: "total_tokens",
    label: "Token 总量",
  });
});

test("chart scales and currency labels preserve fractional-dollar usage", async () => {
  const { chartScaleMax, formatChartMoney, groupScopeLabel } = await import("../public/dashboard-formatters.js");
  assert.equal(chartScaleMax([0, 0]), 1);
  assert.equal(chartScaleMax([0.001, 0.003]), 0.005);
  assert.ok(Math.abs(chartScaleMax([0.00003]) - 0.00005) < 1e-12);
  assert.equal(chartScaleMax([1, 14, null, undefined]), 20);
  assert.equal(formatChartMoney(0), "$0.00");
  assert.equal(formatChartMoney(0.00003), "$0.00003");
  assert.equal(formatChartMoney(0.25), "$0.25");
  assert.equal(formatChartMoney(1024), "$1,024.00");
  assert.equal(groupScopeLabel(18, 60), "展示 18 / 共 60 个分组");
});
