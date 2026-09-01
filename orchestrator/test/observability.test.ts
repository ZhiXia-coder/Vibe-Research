import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { metricsForRun, observabilityOverview, traceForRun } from "../src/observability.ts";
import type { ServiceContext } from "../src/service.ts";

function fixture(): { root: string; ctx: ServiceContext; runId: string; runDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-observability-"));
  const dataRoot = path.join(root, ".local");
  const runId = "20260901-600519-observe";
  const runDir = path.join(dataRoot, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const ctx: ServiceContext = { repoRoot: root, dataRoot, python: "python", node: process.execPath, providerEnvKey: null };
  return { root, ctx, runId, runDir };
}

test("运行指标汇总 Mission、工具、恢复、用量与质量，且不伪造成本", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.runDir, "manifest.json"), JSON.stringify({
    run_id: f.runId, symbol: "600519", market: "SH", status: "complete",
    started_at: "2026-09-01T00:00:00.000Z", finished_at: "2026-09-01T00:00:10.000Z",
    model: "gpt-test", provider: { name: "openai" }, execution_scope: ["profile", "financials", "report"],
    stages: [
      { stage: "profile", status: "complete", attempts: 1, validator_ok: true, errors: [] },
      { stage: "financials", status: "complete", attempts: 2, validator_ok: true, errors: [] },
      { stage: "report", status: "complete", attempts: 1, validator_ok: true, errors: [] },
    ],
    gate: { ok: true, hits: [] }, evidence_count: 12, calculation_count: 3,
  }));
  const events = [
    { ts: "2026-09-01T00:00:01Z", run_id: f.runId, seq: 1, stage: "profile", type: "command", command: "python fetch.py", exit_code: 0, status: "completed" },
    { ts: "2026-09-01T00:00:02Z", run_id: f.runId, seq: 2, stage: "financials", type: "mcp_tool_call", server: "controlled", tool: "calculate", status: "failed" },
    { ts: "2026-09-01T00:00:03Z", run_id: f.runId, seq: 3, stage: "financials", type: "validator", attempt: 1, ok: false, errors: ["缺字段"] },
    { ts: "2026-09-01T00:00:04Z", run_id: f.runId, seq: 4, stage: "financials", type: "mcp_tool_call", server: "controlled", tool: "calculate", status: "completed" },
    { ts: "2026-09-01T00:00:05Z", run_id: f.runId, seq: 5, stage: "financials", type: "turn.completed", usage: { input_tokens: 99, output_tokens: 99 } },
    { ts: "2026-09-01T00:00:06Z", run_id: f.runId, seq: 6, stage: "financials", type: "turn.done", duration_ms: 5000, usage: { input_tokens: 100, output_tokens: 20 } },
    { ts: "2026-09-01T00:00:07Z", run_id: f.runId, seq: 7, stage: "report", type: "gate.rewrite", attempt: 1 },
  ];
  fs.writeFileSync(path.join(f.runDir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");

  const metrics = metricsForRun(f.ctx, f.runId);
  assert.equal(metrics.duration_ms, 10_000);
  assert.deepEqual(metrics.mission.map((node) => node.depends_on), [[], ["profile"], ["financials"]]);
  assert.deepEqual(metrics.tools, { total: 3, succeeded: 2, failed: 1, other: 0, commands: 1, mcp_calls: 2 });
  assert.deepEqual(metrics.recovery, { retries: 1, recovered_steps: 1, gate_rewrites: 1, failure_events: 2 });
  assert.deepEqual(metrics.usage, { input_tokens: 100, output_tokens: 20 }, "turn.completed 与 turn.done 不得双计数");
  assert.equal(metrics.cost.amount, null);
  assert.equal(metrics.cost.status, "not_configured");
  assert.equal(metrics.quality.verdict, "passed");
  assert.equal(metrics.quality.validator_pass_rate, 1);

  const overview = observabilityOverview(f.ctx);
  assert.equal(overview.totals.runs, 1);
  assert.equal(overview.totals.tool_failures, 1);
  assert.equal(overview.totals.retries, 1);
});

test("Trace 只返回安全摘要，不回传完整事件负载", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.runDir, "events.jsonl"), JSON.stringify({
    ts: "2026-09-01T00:00:00Z", run_id: f.runId, seq: 1, stage: "profile", type: "turn.prompt",
    prompt: "绝不能出现在 API 里", config: { api_key: "secret" }, chars: 123,
  }) + "\n");
  const trace = traceForRun(f.ctx, f.runId);
  assert.equal(trace.total, 1);
  assert.deepEqual(Object.keys(trace.items[0]!).sort(), ["attempt", "detail", "duration_ms", "seq", "stage", "status", "ts", "type"]);
  assert.equal(JSON.stringify(trace).includes("绝不能出现在 API 里"), false);
  assert.equal(JSON.stringify(trace).includes("secret"), false);
});
