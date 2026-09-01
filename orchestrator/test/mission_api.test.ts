import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApiServer } from "../src/api.ts";
import { missionSpawned, reserveMission } from "../src/mission_store.ts";
import type { ServiceContext } from "../src/service.ts";

test("Mission API 通过 Bearer 鉴权返回持久任务目录和单条状态", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-mission-api-"));
  const dataRoot = path.join(root, ".local");
  const ctx: ServiceContext = { repoRoot: root, dataRoot, python: "python", node: process.execPath, providerEnvKey: null };
  reserveMission(dataRoot, { run_id: "api-mission", symbol: "600519", market: "SH", endpoint_scope: "core", knowledge: "on", overwrite: false }, 2);
  missionSpawned(dataRoot, "api-mission", process.pid);

  const token = "mission-api-test-token-123456";
  const server = createApiServer(ctx, { token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };

  const unauthorized = await fetch(`${base}/missions`);
  assert.equal(unauthorized.status, 401);
  const listResponse = await fetch(`${base}/missions`, { headers });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json() as { run_id: string; status: string }[];
  assert.deepEqual(list.map((mission) => mission.run_id), ["api-mission"]);
  assert.equal(list[0]?.status, "running");

  const oneResponse = await fetch(`${base}/missions/api-mission`, { headers });
  assert.equal(oneResponse.status, 200);
  assert.equal((await oneResponse.json() as { pid: number }).pid, process.pid);
  const missing = await fetch(`${base}/missions/not-found`, { headers });
  assert.equal(missing.status, 404);
});
