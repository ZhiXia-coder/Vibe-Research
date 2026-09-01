import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MissionCapacityError, MissionExistsError, listMissions, missionById, missionConcurrency, missionProcessExited, missionSpawned, reserveMission } from "../src/mission_store.ts";

function tempRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "vra-missions-")); }

const input = (runId: string, overwrite = false) => ({
  run_id: runId, symbol: "600519", market: "SH", endpoint_scope: "core" as const, knowledge: "on" as const, overwrite,
});

test("SQLite MissionStore 原子限制并发，并用终态 manifest 释放容量", (t) => {
  const dataRoot = tempRoot();
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  const first = reserveMission(dataRoot, input("mission-a"), 1);
  assert.equal(first.status, "starting");
  missionSpawned(dataRoot, first.run_id, process.pid);
  assert.throws(() => reserveMission(dataRoot, input("mission-b"), 1), MissionCapacityError);

  const runDir = path.join(dataRoot, "runs", first.run_id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
    status: "complete", finished_at: "2026-09-01T01:00:00.000Z", final_errors: [],
  }));

  const second = reserveMission(dataRoot, input("mission-b"), 1);
  assert.equal(second.status, "starting");
  assert.equal(missionById(dataRoot, first.run_id)?.status, "complete");
  assert.deepEqual(listMissions(dataRoot).map((mission) => mission.run_id), ["mission-b", "mission-a"]);
});

test("重复 run-id 默认拒绝；终态任务只有显式 overwrite 才可复用", (t) => {
  const dataRoot = tempRoot();
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  reserveMission(dataRoot, input("same-id"), 2);
  missionSpawned(dataRoot, "same-id", process.pid);
  assert.throws(() => reserveMission(dataRoot, input("same-id"), 2), MissionExistsError);
  assert.throws(() => reserveMission(dataRoot, input("same-id", true), 2), MissionExistsError, "运行中的任务即使 overwrite 也不能覆盖");

  missionProcessExited(dataRoot, "same-id", 3);
  assert.equal(missionById(dataRoot, "same-id")?.status, "interrupted");
  const replaced = reserveMission(dataRoot, input("same-id", true), 2);
  assert.equal(replaced.status, "starting");
});

test("并发配置只接受 1..16 的整数", () => {
  assert.equal(missionConcurrency({ VRA_MAX_CONCURRENT_RESEARCH: "4" }), 4);
  assert.equal(missionConcurrency({ VRA_MAX_CONCURRENT_RESEARCH: "0" }), 2);
  assert.equal(missionConcurrency({ VRA_MAX_CONCURRENT_RESEARCH: "abc" }), 2);
});
