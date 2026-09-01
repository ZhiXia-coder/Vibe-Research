import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_PRODUCT_CONFIG, PRODUCT_CONFIG_FILE, loadProductConfig } from "../src/productConfig.ts";
import { configFromArgs } from "../src/run.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
function tmpRepo(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "vra-pc-")); }

test("产品配置:无文件 → 内置默认;相对路径相对产品根解析", () => {
  const repo = tmpRepo();
  const pc = loadProductConfig(repo, { env: {} });
  assert.deepEqual(pc.sources, ["builtin"]);
  assert.equal(pc.resolved.codexHome, path.join(repo, ".local", "codex-home"));
  assert.equal(pc.resolved.dataRoot, path.join(repo, ".local"));
  assert.equal(pc.resolved.constitution, path.join(repo, "AGENTS.md"));
  assert.equal(pc.resolved.scriptsRel, path.join(".agents", "skills", "data-access", "scripts"));
  assert.equal(pc.resolved.codexPath, null);
  assert.equal(pc.provider.auth, DEFAULT_PRODUCT_CONFIG.provider.auth);
});

test("产品配置:产品文件 ← 用户文件 ← 环境变量 逐层覆盖;schema 校验拒绝未知字段与非法值", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ engine: { codex_home: "home-p" }, defaults: { max_retries: 1 }, paths: { data_root: "data" } }));
  fs.mkdirSync(path.join(repo, "data"), { recursive: true });
  // Phase 0 只接受 OpenAI 原生 provider:国产 provider 显式报错,不静默忽略
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { name: "deepseek", auth: "api_key", env_key: "DEEPSEEK_API_KEY", base_url: "http://127.0.0.1:8787/v1" } }));
  assert.throws(() => loadProductConfig(repo, { env: { DEEPSEEK_API_KEY: "x" } }), /provider 必须指定 profile|未知 provider/);  // M4:非 openai 必须经 providers/<id>.json 模板
  // OpenAI 原生 + api_key:env 缺失 → 报错;env 在 → 通过
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { auth: "api_key" }, python: "/v/bin/python" }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /OPENAI_API_KEY 未设置/);
  let pc = loadProductConfig(repo, { env: { OPENAI_API_KEY: "sk-x" } });
  assert.equal(pc.resolved.codexHome, path.join(repo, "home-p"));
  assert.equal(pc.resolved.dataRoot, path.join(repo, "data"));
  assert.equal(pc.defaults.max_retries, 1);
  assert.equal(pc.provider.auth, "api_key");
  assert.equal(pc.provider.wire_api, "responses"); // 未覆盖的字段保留默认
  assert.equal(pc.python, "/v/bin/python");
  // 用户层不得改 data_root
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ paths: { data_root: "elsewhere" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /不得修改 paths.data_root/);
  // env_key 黑名单 / base_url 形态
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { env_key: "PATH" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { base_url: "not a url" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ paths: { constitution: "docs/MY.md" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /必须是 "AGENTS.md"/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), "{}");
  const absoluteHome = path.join(path.parse(repo).root, "abs", "home");
  pc = loadProductConfig(repo, { env: { VRA_CODEX_PATH: "bin/codex-engine", VRA_CODEX_HOME: absoluteHome } });
  assert.equal(pc.resolved.codexPath, path.join(repo, "bin", "codex-engine"));
  assert.equal(pc.resolved.codexHome, absoluteHome);
  assert.ok(pc.sources.includes("env"));
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { api_key: "sk-secret" } })); // 密钥不允许进配置文件(未知字段)
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { auth: "magic" } }));
  assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/);
  fs.writeFileSync(path.join(repo, "data", "config.json"), "{oops");
  assert.throws(() => loadProductConfig(repo, { env: {} }), /JSON/);
});

test("configFromArgs:产品配置进入 RunConfig;CLI 覆盖配置文件", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ engine: { codex_path: "engine/bin/codex-engine", codex_home: "home" }, defaults: { turn_timeout_min: 7, gate_retries: 1 } }));
  let { cfg, sources } = configFromArgs({ symbol: "300308", "repo-root": repo }, {});
  assert.equal(cfg.codexPath, path.join(repo, "engine", "bin", "codex-engine"));
  assert.equal(cfg.codexHome, path.join(repo, "home"));
  assert.equal(cfg.turnTimeoutMs, 7 * 60_000);
  assert.equal(cfg.gateRetries, 1);
  assert.equal(cfg.runDir, path.join(repo, ".local", "runs", cfg.runId));
  assert.ok(sources.some((s) => s.endsWith(PRODUCT_CONFIG_FILE)));
  const cliCodexPath = path.join(path.parse(repo).root, "x", "codex");
  const cliCodexHome = path.join(path.parse(repo).root, "x", "home");
  ({ cfg } = configFromArgs({ symbol: "300308", "repo-root": repo, "codex-path": cliCodexPath, "codex-home": cliCodexHome, "turn-timeout-min": "3" }, {}));
  assert.equal(cfg.codexPath, cliCodexPath);
  assert.equal(cfg.codexHome, cliCodexHome);
  assert.equal(cfg.turnTimeoutMs, 3 * 60_000);
});

/* ===== 数据根:代码与用户数据分离 ===== */

test("VRA_DATA_ROOT 改数据根 —— 用户配置 / 产物 / 引擎 home 必须同时跟着走", () => {
  const repo = tmpRepo();
  const data = tmpRepo();                        // 一个与产品根完全无关的位置
  // 用户配置放在**新数据根**下:能读到它,才证明"读配置的根"确实换了
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ defaults: { max_retries: 4 } }));

  const pc = loadProductConfig(repo, { env: { VRA_DATA_ROOT: data } });

  assert.equal(pc.resolved.dataRoot, data, "产物根没跟着换 —— 会继续往旧代码目录写");
  assert.equal(pc.defaults.max_retries, 4, "没读到新数据根下的用户配置 —— 说明读配置的根还是旧的");
  // 🔴 引擎 home 的默认值写的是「数据根下面那一格」,数据根一换它必须跟着换
  assert.equal(pc.resolved.codexHome, path.join(data, "codex-home"),
    "引擎 home 留在产品根下 —— 换代码目录后会丢失原有引擎状态");
  assert.ok(pc.sources.some((s) => s.startsWith(data)), `用户配置来源应指向新数据根:${pc.sources.join(" / ")}`);
});

test("显式配过的引擎 home 不被数据根带走", () => {
  const repo = tmpRepo();
  const data = tmpRepo();
  const engineHome = path.join(path.parse(repo).root, "tmp", "my-engine-home");
  const pc = loadProductConfig(repo, { env: { VRA_DATA_ROOT: data, VRA_CODEX_HOME: engineHome } });
  assert.equal(pc.resolved.dataRoot, data);
  assert.equal(pc.resolved.codexHome, engineHome, "显式指定的 home 被数据根覆盖了");
});

test("调用方显式 override 优先于 VRA_DATA_ROOT", () => {
  const repo = tmpRepo();
  const viaEnv = tmpRepo();
  const viaOpt = tmpRepo();
  const pc = loadProductConfig(repo, { env: { VRA_DATA_ROOT: viaEnv }, dataRootOverride: viaOpt });
  assert.equal(pc.resolved.dataRoot, viaOpt, "显式 override 应当赢过环境变量");
});
