/**
 * 持久 Mission 目录与并发准入。
 *
 * SQLite 保存“当前任务状态和查询索引”；runs/<id>/manifest.json 与 events.jsonl 仍分别是
 * 研究结果和不可变 Trace 的真源。每次准入/查询都会用 manifest + PID 对账，因此 API 重启后
 * 不会永久把已退出进程算作运行中。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { nowIso, readJsonIfExists, restrictPrivateFile } from "./fsutil.ts";

export interface MissionInput {
  run_id: string;
  symbol: string;
  market: string;
  endpoint_scope: "core" | "full";
  knowledge: "on" | "off";
  overwrite: boolean;
}

export interface MissionRecord {
  run_id: string;
  symbol: string;
  market: string;
  status: string;
  endpoint_scope: string;
  knowledge: string;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  error: string | null;
}

export class MissionCapacityError extends Error {
  readonly active: number;
  readonly limit: number;
  constructor(active: number, limit: number) {
    super(`研究并发已满(${active}/${limit})`);
    this.active = active;
    this.limit = limit;
  }
}

export class MissionExistsError extends Error {
  readonly runId: string;
  constructor(runId: string) { super(`Mission ${runId} 已存在`); this.runId = runId; }
}

const ACTIVE = new Set(["starting", "running"]);
const TERMINAL_MANIFEST = new Set(["complete", "failed", "incomplete", "stale"]);

function dbPath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), "runtime.sqlite");
}

function open(dataRoot: string): DatabaseSync {
  fs.mkdirSync(path.resolve(dataRoot), { recursive: true });
  const file = dbPath(dataRoot);
  const existed = fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      run_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      market TEXT NOT NULL,
      status TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL,
      knowledge TEXT NOT NULL,
      pid INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS missions_status_updated_idx ON missions(status, updated_at);
  `);
  // 数据库不保存 API Key，但任务主体和错误仍属于用户数据，沿用私密文件权限。
  if (!existed) restrictPrivateFile(file);
  return db;
}

function row(value: unknown): MissionRecord {
  const v = value as Record<string, unknown>;
  return {
    run_id: String(v.run_id), symbol: String(v.symbol), market: String(v.market), status: String(v.status),
    endpoint_scope: String(v.endpoint_scope), knowledge: String(v.knowledge),
    pid: typeof v.pid === "number" ? v.pid : null,
    created_at: String(v.created_at), started_at: typeof v.started_at === "string" ? v.started_at : null,
    finished_at: typeof v.finished_at === "string" ? v.finished_at : null,
    updated_at: String(v.updated_at), error: typeof v.error === "string" ? v.error : null,
  };
}

function processAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function terminalFromManifest(dataRoot: string, runId: string): { status: string; finished_at: string | null; error: string | null } | null {
  const manifest = readJsonIfExists<Record<string, unknown>>(path.join(dataRoot, "runs", runId, "manifest.json"));
  const status = typeof manifest?.status === "string" ? manifest.status : null;
  if (!status || !TERMINAL_MANIFEST.has(status)) return null;
  const errors = Array.isArray(manifest?.final_errors) ? manifest.final_errors.map(String) : [];
  return {
    status,
    finished_at: typeof manifest?.finished_at === "string" ? manifest.finished_at : nowIso(),
    error: errors.length ? errors.slice(0, 5).join("; ").slice(0, 1000) : null,
  };
}

function reconcile(db: DatabaseSync, dataRoot: string): void {
  const active = db.prepare("SELECT * FROM missions WHERE status IN ('starting','running')").all().map(row);
  const update = db.prepare("UPDATE missions SET status=?, finished_at=?, updated_at=?, error=?, pid=NULL WHERE run_id=?");
  const now = Date.now();
  for (const mission of active) {
    const final = terminalFromManifest(dataRoot, mission.run_id);
    if (final) {
      update.run(final.status, final.finished_at, nowIso(), final.error, mission.run_id);
      continue;
    }
    // starting 可能处在 reserve → spawn 的短窗口；五分钟后仍无 PID 才视为启动中断。
    const staleStarting = mission.status === "starting" && now - Date.parse(mission.updated_at) > 5 * 60_000;
    if ((mission.status === "running" && !processAlive(mission.pid)) || staleStarting) {
      const ts = nowIso();
      update.run("interrupted", ts, ts, "进程已退出且没有终态 manifest；可用新 run_id 重试", mission.run_id);
    }
  }
}

export function missionConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.VRA_MAX_CONCURRENT_RESEARCH ?? 2);
  return Number.isInteger(raw) && raw >= 1 && raw <= 16 ? raw : 2;
}

export function reserveMission(dataRoot: string, input: MissionInput, limit = missionConcurrency()): MissionRecord {
  const db = open(dataRoot);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      reconcile(db, dataRoot);
      const existing = db.prepare("SELECT * FROM missions WHERE run_id=?").get(input.run_id);
      if (existing) {
        const current = row(existing);
        if (!input.overwrite || ACTIVE.has(current.status)) throw new MissionExistsError(input.run_id);
        db.prepare("DELETE FROM missions WHERE run_id=?").run(input.run_id);
      }
      const active = Number((db.prepare("SELECT COUNT(*) AS n FROM missions WHERE status IN ('starting','running')").get() as { n: number }).n);
      if (active >= limit) throw new MissionCapacityError(active, limit);
      const ts = nowIso();
      db.prepare(`INSERT INTO missions(run_id,symbol,market,status,endpoint_scope,knowledge,pid,created_at,started_at,finished_at,updated_at,error)
        VALUES(?,?,?,'starting',?,?,NULL,?,NULL,NULL,?,NULL)`)
        .run(input.run_id, input.symbol, input.market, input.endpoint_scope, input.knowledge, ts, ts);
      db.exec("COMMIT");
      return row(db.prepare("SELECT * FROM missions WHERE run_id=?").get(input.run_id));
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

function update(dataRoot: string, sql: string, args: unknown[]): void {
  const db = open(dataRoot);
  try { (db.prepare(sql) as StatementSync).run(...args as never[]); }
  finally { db.close(); }
}

export function missionSpawned(dataRoot: string, runId: string, pid: number | null): void {
  const ts = nowIso();
  update(dataRoot, "UPDATE missions SET status='running',pid=?,started_at=COALESCE(started_at,?),updated_at=?,error=NULL WHERE run_id=?", [pid, ts, ts, runId]);
}

export function missionSpawnFailed(dataRoot: string, runId: string, error: string): void {
  const ts = nowIso();
  update(dataRoot, "UPDATE missions SET status='failed',pid=NULL,finished_at=?,updated_at=?,error=? WHERE run_id=?", [ts, ts, error.slice(0, 1000), runId]);
}

export function missionProcessExited(dataRoot: string, runId: string, code: number | null): void {
  const db = open(dataRoot);
  try {
    const final = terminalFromManifest(dataRoot, runId);
    const ts = nowIso();
    if (final) db.prepare("UPDATE missions SET status=?,pid=NULL,finished_at=?,updated_at=?,error=? WHERE run_id=?").run(final.status, final.finished_at, ts, final.error, runId);
    else db.prepare("UPDATE missions SET status='interrupted',pid=NULL,finished_at=?,updated_at=?,error=? WHERE run_id=?")
      .run(ts, ts, `研究进程退出(${code ?? "unknown"})但没有终态 manifest`, runId);
  } finally { db.close(); }
}

export function listMissions(dataRoot: string, limit = 100): MissionRecord[] {
  const db = open(dataRoot);
  try {
    reconcile(db, dataRoot);
    const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    return db.prepare("SELECT * FROM missions ORDER BY created_at DESC LIMIT ?").all(n).map(row);
  } finally { db.close(); }
}

export function missionById(dataRoot: string, runId: string): MissionRecord | null {
  const db = open(dataRoot);
  try { reconcile(db, dataRoot); const found = db.prepare("SELECT * FROM missions WHERE run_id=?").get(runId); return found ? row(found) : null; }
  finally { db.close(); }
}
