/**
 * 研究运行的可观测性投影。
 *
 * 事件账本仍以 runs/<id>/events.jsonl 为真源；本模块只生成面向 API / UI 的安全摘要，
 * 不回传 prompt、模型正文、完整命令输出或本机路径。这样既能排障，也不会把运行上下文
 * 当作普通接口数据扩散出去。
 */
import fs from "node:fs";

import { RUN_ID_RE } from "./config.ts";
import { readJsonIfExists } from "./fsutil.ts";
import { safePath, type ServiceContext } from "./service.ts";

type Json = Record<string, unknown>;

export interface MissionNode {
  id: string;
  depends_on: string[];
  status: string;
  attempts: number;
  validator_ok: boolean | null;
  errors: string[];
}

export interface TraceEvent {
  seq: number;
  ts: string | null;
  stage: string;
  type: string;
  attempt: number | null;
  status: string | null;
  duration_ms: number | null;
  detail: string | null;
}

export interface RunMetrics {
  run_id: string;
  exists: boolean;
  status: string | null;
  symbol: string | null;
  market: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  model: { provider: string | null; model: string | null };
  mission: MissionNode[];
  steps: { total: number; completed: number; failed: number; retried: number };
  tools: { total: number; succeeded: number; failed: number; other: number; commands: number; mcp_calls: number };
  recovery: { retries: number; recovered_steps: number; gate_rewrites: number; failure_events: number };
  usage: Record<string, number>;
  cost: { amount: number | null; currency: "USD"; status: "not_configured" };
  quality: {
    verdict: "passed" | "failed" | "unknown";
    gate_ok: boolean | null;
    validator_pass_rate: number | null;
    evidence_count: number | null;
    calculation_count: number | null;
  };
}

function runFiles(ctx: ServiceContext, runId: string): { manifest: string; events: string } {
  if (!RUN_ID_RE.test(runId)) throw new Error("bad run id");
  return {
    manifest: safePath(ctx, "runs", runId, "manifest.json"),
    events: safePath(ctx, "runs", runId, "events.jsonl"),
  };
}

function eventsOf(file: string): Json[] {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? [value as Json] : [];
    } catch { return []; }
  });
}

const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

function elapsed(start: unknown, finish: unknown, events: Json[]): number | null {
  const a = Date.parse(String(start ?? ""));
  const b = Date.parse(String(finish ?? ""));
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
  const turns = events.filter((e) => e.type === "turn.done").map((e) => num(e.duration_ms) ?? 0);
  return turns.length ? turns.reduce((sum, value) => sum + value, 0) : null;
}

function toolStatus(event: Json): "success" | "failed" | "other" {
  const status = String(event.status ?? "").toLowerCase();
  const exitCode = num(event.exit_code);
  if (exitCode !== null) return exitCode === 0 ? "success" : "failed";
  if (["completed", "complete", "success", "succeeded", "ok"].includes(status)) return "success";
  if (["failed", "error", "cancelled", "timed_out", "timeout"].includes(status)) return "failed";
  return "other";
}

function usageOf(events: Json[]): Record<string, number> {
  const totals: Record<string, number> = {};
  // turn.done 是每轮的最终摘要；若旧运行没有它，再退到 turn.completed，避免双计数。
  const source = events.some((e) => e.type === "turn.done")
    ? events.filter((e) => e.type === "turn.done")
    : events.filter((e) => e.type === "turn.completed");
  for (const event of source) {
    const usage = event.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    for (const [key, value] of Object.entries(usage as Json)) {
      if (typeof value === "number" && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

function missionOf(manifest: Json): MissionNode[] {
  const records = Array.isArray(manifest.stages) ? manifest.stages.filter((v): v is Json => !!v && typeof v === "object" && !Array.isArray(v)) : [];
  const byStage = new Map(records.map((record) => [String(record.stage ?? ""), record]));
  const scope = Array.isArray(manifest.execution_scope) ? manifest.execution_scope.map(String) : records.map((record) => String(record.stage ?? ""));
  return scope.filter(Boolean).map((stage, index) => {
    const record = byStage.get(stage);
    return {
      id: stage,
      depends_on: index === 0 ? [] : [scope[index - 1]!],
      status: String(record?.status ?? (manifest.status === "running" ? "pending" : "skipped")),
      attempts: num(record?.attempts) ?? 0,
      validator_ok: bool(record?.validator_ok),
      errors: Array.isArray(record?.errors) ? record.errors.map(String).slice(0, 10) : [],
    };
  });
}

export function metricsForRun(ctx: ServiceContext, runId: string): RunMetrics {
  const files = runFiles(ctx, runId);
  const manifest = readJsonIfExists<Json>(files.manifest);
  const events = eventsOf(files.events);
  if (!manifest) {
    return {
      run_id: runId, exists: false, status: null, symbol: null, market: null, started_at: null, finished_at: null, duration_ms: null,
      model: { provider: null, model: null }, mission: [], steps: { total: 0, completed: 0, failed: 0, retried: 0 },
      tools: { total: 0, succeeded: 0, failed: 0, other: 0, commands: 0, mcp_calls: 0 },
      recovery: { retries: 0, recovered_steps: 0, gate_rewrites: 0, failure_events: 0 }, usage: {},
      cost: { amount: null, currency: "USD", status: "not_configured" },
      quality: { verdict: "unknown", gate_ok: null, validator_pass_rate: null, evidence_count: null, calculation_count: null },
    };
  }
  const mission = missionOf(manifest);
  const toolEvents = events.filter((e) => e.type === "command" || e.type === "mcp_tool_call");
  const succeeded = toolEvents.filter((e) => toolStatus(e) === "success").length;
  const failed = toolEvents.filter((e) => toolStatus(e) === "failed").length;
  const validators = mission.filter((node) => node.validator_ok !== null);
  const gate = manifest.gate && typeof manifest.gate === "object" && !Array.isArray(manifest.gate) ? manifest.gate as Json : null;
  const gateOk = bool(gate?.ok);
  const status = str(manifest.status);
  const validatorRate = validators.length ? validators.filter((node) => node.validator_ok).length / validators.length : null;
  const verdict = status === "complete" && gateOk === true && validatorRate === 1 ? "passed"
    : status === "failed" || gateOk === false || (validatorRate !== null && validatorRate < 1) ? "failed" : "unknown";
  const retries = mission.reduce((sum, node) => sum + Math.max(0, node.attempts - 1), 0);
  const failureEvents = events.filter((event) => {
    const type = String(event.type ?? "");
    return type.endsWith(".failed") || type.endsWith(".exception") || type === "stream.error" || (type === "validator" && event.ok === false)
      || (type === "command" || type === "mcp_tool_call") && toolStatus(event) === "failed";
  }).length;
  const provider = manifest.provider && typeof manifest.provider === "object" && !Array.isArray(manifest.provider) ? manifest.provider as Json : null;
  return {
    run_id: runId,
    exists: true,
    status,
    symbol: str(manifest.symbol),
    market: str(manifest.market),
    started_at: str(manifest.started_at),
    finished_at: str(manifest.finished_at),
    duration_ms: elapsed(manifest.started_at, manifest.finished_at, events),
    model: { provider: str(provider?.name), model: str(manifest.model) },
    mission,
    steps: {
      total: mission.length,
      completed: mission.filter((node) => node.status === "complete").length,
      failed: mission.filter((node) => node.status === "failed").length,
      retried: mission.filter((node) => node.attempts > 1).length,
    },
    tools: {
      total: toolEvents.length,
      succeeded,
      failed,
      other: toolEvents.length - succeeded - failed,
      commands: toolEvents.filter((event) => event.type === "command").length,
      mcp_calls: toolEvents.filter((event) => event.type === "mcp_tool_call").length,
    },
    recovery: {
      retries,
      recovered_steps: mission.filter((node) => node.attempts > 1 && node.status === "complete").length,
      gate_rewrites: events.filter((event) => event.type === "gate.rewrite").length,
      failure_events: failureEvents,
    },
    usage: usageOf(events),
    cost: { amount: null, currency: "USD", status: "not_configured" },
    quality: {
      verdict,
      gate_ok: gateOk,
      validator_pass_rate: validatorRate,
      evidence_count: num(manifest.evidence_count),
      calculation_count: num(manifest.calculation_count),
    },
  };
}

function eventDetail(event: Json): string | null {
  const type = String(event.type ?? "");
  if (type === "command") return `${String(event.command ?? "").slice(0, 180)}${num(event.exit_code) === null ? "" : ` · exit ${event.exit_code}`}`;
  if (type === "mcp_tool_call") return `${String(event.server ?? "mcp")}.${String(event.tool ?? "tool")} · ${String(event.status ?? "unknown")}`;
  if (type === "validator") return `${event.ok === true ? "校验通过" : "校验未通过"} · ${Array.isArray(event.errors) ? event.errors.length : 0} 个错误`;
  if (type === "turn.done") return `${num(event.duration_ms) ?? 0} ms${event.failed ? ` · ${String(event.failed).slice(0, 120)}` : ""}`;
  if (type === "stage.completed") return `${String(event.status ?? "unknown")} · ${num(event.attempts) ?? 0} 次尝试`;
  if (type.endsWith(".failed") || type.endsWith(".exception") || type === "stream.error") return String(event.error ?? event.message ?? type).slice(0, 180);
  if (typeof event.endpoint === "string") return event.endpoint.slice(0, 120);
  return null;
}

export function traceForRun(ctx: ServiceContext, runId: string, limit = 300): { run_id: string; total: number; items: TraceEvent[] } {
  const events = eventsOf(runFiles(ctx, runId).events);
  const capped = Math.min(Math.max(Math.trunc(limit) || 300, 1), 1000);
  const items = events.slice(-capped).map((event, index): TraceEvent => ({
    seq: num(event.seq) ?? index + 1,
    ts: str(event.ts),
    stage: str(event.stage) ?? "orchestrator",
    type: str(event.type) ?? "unknown",
    attempt: num(event.attempt),
    status: str(event.status),
    duration_ms: num(event.duration_ms),
    detail: eventDetail(event),
  }));
  return { run_id: runId, total: events.length, items };
}

export function observabilityOverview(ctx: ServiceContext, limit = 50): { runs: RunMetrics[]; totals: Json } {
  const root = safePath(ctx, "runs");
  if (!fs.existsSync(root)) return { runs: [], totals: { runs: 0, complete: 0, failed: 0, tools: 0, tool_failures: 0, retries: 0 } };
  const ids = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name))
    .map((entry) => entry.name).sort().slice(-Math.min(Math.max(limit, 1), 200)).reverse();
  const runs = ids.map((id) => metricsForRun(ctx, id));
  return {
    runs,
    totals: {
      runs: runs.length,
      complete: runs.filter((run) => run.status === "complete").length,
      failed: runs.filter((run) => run.status === "failed").length,
      tools: runs.reduce((sum, run) => sum + run.tools.total, 0),
      tool_failures: runs.reduce((sum, run) => sum + run.tools.failed, 0),
      retries: runs.reduce((sum, run) => sum + run.recovery.retries, 0),
    },
  };
}
