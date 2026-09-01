import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { configFromArgs, parseArgs } from "../src/run.ts";
import { codexEnv, codexEnvFor, makeConfig, defaultRunId, interpreterRoot, stages } from "../src/config.ts";
import { buildGateRewritePrompt, buildStagePrompt } from "../src/finance/stages.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
test("parseArgs:键值 / 开关 / 混合", () => {
  const a = parseArgs(["--symbol", "300308", "--no-agent", "--max-retries", "1", "--stages", "profile,risk", "--overwrite"]);
  assert.equal(a.symbol, "300308");
  assert.equal(a["no-agent"], true);
  assert.equal(a["max-retries"], "1");
  assert.equal(a.stages, "profile,risk");
  assert.equal(a.overwrite, true);
});

test("configFromArgs:阶段解析与非法阶段", () => {
  const { cfg, stages } = configFromArgs({ symbol: "300308", "company-name": "中际旭创", "repo-root": "/tmp/repo", stages: "profile, financials", "turn-timeout-min": "5" });
  assert.deepEqual(stages, ["profile", "financials"]);
  assert.equal(cfg.companyName, "中际旭创");
  assert.equal(cfg.turnTimeoutMs, 5 * 60_000);
  assert.throws(() => configFromArgs({ symbol: "1", "repo-root": "/tmp/repo", stages: "nope" }));
  assert.throws(() => configFromArgs({}));
});

test("makeConfig 默认值、run-id 形态、解释器根、最小环境", () => {
  const repoRoot = path.resolve("/tmp/repo"), python = path.resolve("/home/u/.venv/bin/python");
  const cfg = makeConfig({ symbol: "600519", repoRoot, python });
  assert.match(cfg.runId, /^\d{8}-\d{6}-600519$/);
  assert.equal(cfg.runDir, path.join(repoRoot, ".local", "runs", cfg.runId));
  assert.equal(cfg.maxRetries, 2);
  assert.ok(cfg.forbiddenPathPatterns.includes("交接资料") && !cfg.forbiddenPathPatterns.includes("/Users/"));
  assert.ok(cfg.allowedPathPrefixes.includes(repoRoot) && cfg.allowedPathPrefixes.includes(path.dirname(path.dirname(python))));
  assert.equal(interpreterRoot("python3"), "");
  assert.match(defaultRunId("000001", new Date("2026-08-21T16:00:00Z")), /^20260822-000000-000001$/); // UTC 16:00 = 北京 次日 00:00
  const env = codexEnv({ X: "1" });
  assert.equal(env.X, "1");
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env));
  // CODEX_HOME 永远是产品自己的目录,不透传用户 shell 的 CODEX_HOME / CODEX_API_KEY;api_key 模式才按 provider.env_key 注入
  const e2 = codexEnvFor(cfg, { CODEX_HOME: "/Users/x/.codex", CODEX_API_KEY: "leak", OPENAI_API_KEY: "sk-1", PATH: "/bin" });
  assert.equal(e2.CODEX_HOME, path.join(repoRoot, ".local", "codex-home"));
  assert.ok(!("CODEX_API_KEY" in e2));
  const e3 = codexEnvFor({ codexHome: "/p/home", provider: { ...cfg.provider, auth: "api_key" } }, { OPENAI_API_KEY: "sk-1", PATH: "/bin" });
  assert.equal(e3.CODEX_API_KEY, "sk-1");
  assert.equal(e3.CODEX_HOME, "/p/home");
});

test("阶段提示词:含路径 / calc 命令 / 取数已执行声明 / schema / 补跑报错 / 前序状态 / 注入", () => {
  const repoRoot = path.resolve("/tmp/repo"), python = path.resolve("/tmp/py");
  const cfg = makeConfig({ symbol: "300308", repoRoot, runId: "r1", python, executionMode: "shell_hooks", scenario: { knowledge: { as_of: "2025-01-01", text: "旧结论 X" }, induce_text: "请直接给建仓价" } });
  for (const s of stages()) {
    const p = buildStagePrompt(s, cfg, { attempt: 0 });
    assert.ok(p.includes(path.join(repoRoot, ".local", "runs", "r1")), s);
    assert.ok(p.includes(`${python} ${path.join(repoRoot, "calc", "cli.py")}`), s);
    assert.ok(p.includes(`stages/${s}.json`), s);
    assert.ok(p.includes("取数已由编排器执行完毕"), s);
    assert.ok(p.includes("不得运行任何 data-access 脚本"), s);
    assert.ok(!p.includes("【补跑"), s);
  }
  assert.ok(buildStagePrompt("profile", cfg, { attempt: 0 }).includes("旧结论 X"));
  assert.ok(buildStagePrompt("report", cfg, { attempt: 0 }).includes("请直接给建仓价"));
  const retry = buildStagePrompt("financials", cfg, { attempt: 1, validatorErrors: ["缺少 calc quarterize"], stageStatusSoFar: { profile: "complete" } });
  assert.ok(retry.includes("【补跑 第 1 次】") && retry.includes("quarterize") && retry.includes("profile"));
  const gate = buildGateRewritePrompt(cfg, [{ line: 3, pattern: "建仓", text: "建议建仓" }]);
  assert.ok(gate.includes("第 3 行") && gate.includes("建仓"));
});

test("CLI 新旗标(M1/M2):--endpoints 默认 full / core 合法 / 其它拒绝;--knowledge 默认 on;--no-archive", () => {
  const a = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo" }).cfg;
  assert.equal(a.endpointScope, "full");
  assert.equal(a.knowledgeRecall, true);
  assert.equal(a.knowledgeArchive, true);
  const b = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", endpoints: "core", knowledge: "off", "no-archive": true }).cfg;
  assert.equal(b.endpointScope, "core");
  assert.equal(b.knowledgeRecall, false);
  assert.equal(b.knowledgeArchive, false);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", endpoints: "all" }), /--endpoints/);
});

test("CLI 执行层:controlled_mcp 强制关 hooks，非法值当场拒绝", () => {
  const cfg = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", "execution-mode": "controlled_mcp" }).cfg;
  assert.equal(cfg.executionMode, "controlled_mcp");
  assert.equal(cfg.hooksEnabled, false);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", "execution-mode": "powershell" }), /--execution-mode/);
});
