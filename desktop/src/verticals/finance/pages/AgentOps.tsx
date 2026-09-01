import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Bot, CheckCircle2, Clock3, GitBranch, RefreshCw, RotateCcw, TerminalSquare, WalletCards } from "lucide-react";

import { GlassCard } from "@/components/ui/GlassCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { ApiError, backend, type MissionRecord, type ObservabilityOverview, type RunMetrics, type RunTrace } from "@/lib/backend";
import { useAiPage } from "../../../core/ai/pageContext";

const STAGE_CN: Record<string, string> = {
  profile: "公司画像", financials: "财务", estimates: "一致预期", valuation: "估值", risk: "风险与卡口", report: "成稿",
};

const STATUS_CN: Record<string, string> = {
  complete: "完成", starting: "启动中", running: "进行中", failed: "失败", interrupted: "已中断", incomplete: "未跑完", pending: "待执行", skipped: "跳过", stale: "数据陈旧",
};

const fmtDuration = (ms: number | null) => {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;
};

const fmtTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

function Stat({ label, value, note, tone = "default" }: { label: string; value: string | number; note?: string; tone?: "default" | "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={tone === "good" ? "mt-1 text-xl font-semibold text-primary" : tone === "bad" ? "mt-1 text-xl font-semibold text-destructive" : "mt-1 text-xl font-semibold"}>{value}</div>
      {note && <div className="mt-1 text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

export function AgentOps() {
  const [overview, setOverview] = useState<ObservabilityOverview | null>(null);
  const [active, setActive] = useState<RunMetrics | null>(null);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const loadTrace = async (run: RunMetrics) => {
    setActive(run); setTrace(null); setErr("");
    try { setTrace(await backend.runTrace(run.run_id, 500)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  };

  const refresh = async () => {
    setLoading(true); setErr("");
    try {
      const [data, missionData] = await Promise.all([backend.observability(50), backend.missions(100)]);
      setOverview(data);
      setMissions(missionData);
      const selected = active ? data.runs.find((run) => run.run_id === active.run_id) : data.runs[0];
      if (selected) await loadTrace(selected); else { setActive(null); setTrace(null); }
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []);

  const tokenTotal = useMemo(() => {
    if (!active) return 0;
    const preferred = Object.entries(active.usage).filter(([key]) => /total/i.test(key));
    if (preferred.length) return preferred.reduce((sum, [, value]) => sum + value, 0);
    return Object.entries(active.usage).filter(([key]) => /input|output/i.test(key)).reduce((sum, [, value]) => sum + value, 0);
  }, [active]);

  useAiPage({
    key: "agent-ops",
    title: "Agent 运行控制台",
    context: active
      ? `当前运行 ${active.run_id}，状态 ${active.status}，完成 ${active.steps.completed}/${active.steps.total} 个步骤，工具失败 ${active.tools.failed} 次，恢复 ${active.recovery.recovered_steps} 个步骤。`
      : "这里汇总研究 Agent 的 Mission、步骤 Trace、工具结果、恢复过程、耗时、Token 与质量代理指标。",
    suggestions: ["这次运行失败在哪一步", "哪些步骤发生了重试", "质量指标为什么未通过"],
  });

  return (
    <div>
      <PageHeader title="Agent 运行控制台" subtitle="Mission DAG、步骤 Trace、工具结果、失败恢复、性能与质量指标统一观测" />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">这里只展示安全摘要，不展示 Prompt、模型正文、完整命令输出或本机路径。</p>
        <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted/40 disabled:opacity-50">
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />刷新
        </button>
      </div>

      {err && <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>}

      {overview && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <Stat label="运行" value={overview.totals.runs} />
          <Stat label="活跃任务" value={missions.filter((mission) => mission.status === "starting" || mission.status === "running").length} />
          <Stat label="完成" value={overview.totals.complete} tone="good" />
          <Stat label="失败" value={overview.totals.failed} tone={overview.totals.failed ? "bad" : "default"} />
          <Stat label="工具调用" value={overview.totals.tools} />
          <Stat label="工具失败" value={overview.totals.tool_failures} tone={overview.totals.tool_failures ? "bad" : "default"} />
          <Stat label="自动重试" value={overview.totals.retries} />
        </div>
      )}

      {missions.length > 0 && (
        <GlassCard className="mb-4">
          <div className="mb-3 flex items-center gap-2"><Bot className="h-4 w-4 text-primary" /><h3 className="font-semibold">持久任务目录</h3><span className="text-xs text-muted-foreground">SQLite · 最近 {Math.min(missions.length, 12)} 条</span></div>
          <div className="overflow-auto">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">Mission</th><th className="pb-2 font-medium">主体</th><th className="pb-2 font-medium">状态</th><th className="pb-2 font-medium">范围</th><th className="pb-2 font-medium">PID</th><th className="pb-2 font-medium">更新时间</th></tr></thead>
              <tbody>
                {missions.slice(0, 12).map((mission) => (
                  <tr key={mission.run_id} className="border-t border-border/40">
                    <td className="max-w-[260px] truncate py-2 pr-3 font-mono" title={mission.run_id}>{mission.run_id}</td>
                    <td className="py-2 pr-3 font-mono">{mission.symbol}.{mission.market || "—"}</td>
                    <td className={mission.status === "failed" || mission.status === "interrupted" ? "py-2 pr-3 text-destructive" : mission.status === "complete" ? "py-2 pr-3 text-primary" : "py-2 pr-3"}>{STATUS_CN[mission.status] ?? mission.status}</td>
                    <td className="py-2 pr-3">{mission.endpoint_scope}</td><td className="py-2 pr-3 font-mono">{mission.pid ?? "—"}</td><td className="py-2 text-muted-foreground">{fmtTime(mission.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {!overview || overview.runs.length === 0 ? (
        <GlassCard><p className="text-sm text-muted-foreground">还没有研究运行。先到「个股研究」启动一次，Mission 和 Trace 会自动出现在这里。</p></GlassCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
          <GlassCard className="h-fit">
            <h3 className="mb-3 font-semibold">运行列表</h3>
            <div className="space-y-1">
              {overview.runs.map((run) => (
                <button key={run.run_id} onClick={() => void loadTrace(run)} className={active?.run_id === run.run_id ? "w-full rounded-lg bg-primary/15 px-3 py-2 text-left ring-1 ring-primary/25" : "w-full rounded-lg px-3 py-2 text-left hover:bg-muted/40"}>
                  <div className="flex items-center justify-between gap-2 text-xs"><span className="font-mono">{run.symbol ?? "—"}</span><span>{STATUS_CN[run.status ?? ""] ?? run.status ?? "未知"}</span></div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground" title={run.run_id}>{run.run_id}</div>
                </button>
              ))}
            </div>
          </GlassCard>

          {active && (
            <div className="min-w-0 space-y-4">
              <GlassCard>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div><h3 className="font-semibold">{active.run_id}</h3><p className="mt-0.5 text-xs text-muted-foreground">{active.model.provider ?? "默认 Provider"} · {active.model.model ?? "Provider 默认模型"} · {fmtTime(active.started_at)}</p></div>
                  <span className="rounded-full bg-muted/50 px-2.5 py-1 text-xs">{STATUS_CN[active.status ?? ""] ?? active.status ?? "未知"}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="总耗时" value={fmtDuration(active.duration_ms)} note="运行开始到结束" />
                  <Stat label="Token" value={tokenTotal || "—"} note={Object.keys(active.usage).length ? Object.keys(active.usage).join(" / ") : "等待模型用量事件"} />
                  <Stat label="成本" value={active.cost.amount === null ? "未配置" : `$${active.cost.amount.toFixed(4)}`} note="未配置模型价格表时不估算" />
                  <Stat label="质量代理" value={active.quality.verdict === "passed" ? "通过" : active.quality.verdict === "failed" ? "未通过" : "待判断"} tone={active.quality.verdict === "passed" ? "good" : active.quality.verdict === "failed" ? "bad" : "default"} note={`证据 ${active.quality.evidence_count ?? "—"} · 计算 ${active.quality.calculation_count ?? "—"}`} />
                </div>
              </GlassCard>

              <GlassCard>
                <div className="mb-3 flex items-center gap-2"><GitBranch className="h-4 w-4 text-primary" /><h3 className="font-semibold">Mission DAG</h3></div>
                <div className="flex flex-wrap items-center gap-2">
                  {active.mission.map((node, index) => (
                    <div key={node.id} className="flex items-center gap-2">
                      {index > 0 && <span className="text-muted-foreground/50">→</span>}
                      <div className={node.status === "complete" ? "rounded-lg border border-primary/30 bg-primary/10 px-3 py-2" : node.status === "failed" ? "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2" : "rounded-lg border border-border bg-muted/20 px-3 py-2"}>
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          {node.status === "complete" ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : node.status === "failed" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : <Clock3 className="h-3.5 w-3.5" />}
                          {STAGE_CN[node.id] ?? node.id}
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">{STATUS_CN[node.status] ?? node.status} · {node.attempts} 次</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="步骤" value={`${active.steps.completed}/${active.steps.total}`} />
                  <Stat label="工具成功" value={`${active.tools.succeeded}/${active.tools.total}`} tone={active.tools.succeeded ? "good" : "default"} />
                  <Stat label="失败事件" value={active.recovery.failure_events} tone={active.recovery.failure_events ? "bad" : "default"} />
                  <Stat label="恢复成功" value={active.recovery.recovered_steps} note={`重试 ${active.recovery.retries} · Gate 改写 ${active.recovery.gate_rewrites}`} />
                </div>
              </GlassCard>

              <GlassCard>
                <div className="mb-3 flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h3 className="font-semibold">步骤 Trace</h3><span className="text-xs text-muted-foreground">{trace?.total ?? 0} 条</span></div>
                {!trace ? <p className="text-sm text-muted-foreground">正在读取 Trace…</p> : trace.items.length === 0 ? <p className="text-sm text-muted-foreground">这次运行还没有事件。</p> : (
                  <div className="max-h-[520px] space-y-1 overflow-auto pr-1">
                    {trace.items.map((event) => (
                      <div key={`${event.seq}-${event.type}`} className="grid grid-cols-[55px_90px_minmax(0,1fr)] gap-2 rounded-md border border-border/40 px-2.5 py-2 text-xs">
                        <span className="font-mono text-muted-foreground">#{event.seq}</span>
                        <span className="truncate" title={event.stage}>{STAGE_CN[event.stage] ?? event.stage}</span>
                        <div className="min-w-0"><div className="flex items-center gap-1.5 font-medium">{event.type === "command" ? <TerminalSquare className="h-3.5 w-3.5" /> : event.type.includes("retry") || event.type === "gate.rewrite" ? <RotateCcw className="h-3.5 w-3.5" /> : event.type.includes("turn") ? <Bot className="h-3.5 w-3.5" /> : event.type.includes("cost") ? <WalletCards className="h-3.5 w-3.5" /> : null}{event.type}</div>{event.detail && <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={event.detail}>{event.detail}</div>}</div>
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
