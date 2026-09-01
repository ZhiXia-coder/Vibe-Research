import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalAgentError, claudeArgs, codexLoginProgress, findExecutable, parseClaudeOutput, probeClaude,
  probeCodex, runLocalAgent, startCodexLogin,
} from "../src/local_agent_runtime.ts";

function fakeNodeExecutable(dir: string, name: string, source: string): string {
  if (process.platform !== "win32") {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    return bin;
  }
  const script = path.join(dir, `${name}.cjs`);
  const bin = path.join(dir, `${name}.ps1`);
  fs.writeFileSync(script, source);
  const quote = (s: string) => s.replaceAll("'", "''");
  fs.writeFileSync(bin, `& '${quote(process.execPath)}' '${quote(script)}' @args\r\nexit $LASTEXITCODE\r\n`);
  return bin;
}

function fakeClaude(): { dir: string; bin: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-claude-"));
  const bin = fakeNodeExecutable(dir, "claude", `
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('2.1.226 (Claude Code)');process.exit(0)}
if(a[0]==='--help'){console.log(process.env.FAKE_OLD_HELP==='1'?'--output-format':'--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema');process.exit(0)}
if(a[0]==='auth'&&a[1]==='status'){console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_AUTH_METHOD||'claude.ai',apiProvider:process.env.FAKE_API_PROVIDER||'firstParty',email:'hidden@example.com'}));process.exit(0)}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({result:input+'|keys='+Boolean(process.env.ANTHROPIC_API_KEY)+'|oauth='+Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)})));
`);
  return { dir, bin };
}

test("Codex 订阅登录只写产品 CODEX_HOME，并合并重复启动", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-codex-login-"));
  const codexHome = path.join(dir, "product-home");
  const launchFile = path.join(dir, "launch.json");
  const bin = fakeNodeExecutable(dir, "codex", `
const fs=require('node:fs');
const path=require('node:path');
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli 0.149.0');process.exit(0)}
if(a[0]==='login'&&a[1]==='status'){process.exit(fs.existsSync(path.join(process.env.CODEX_HOME,'auth.ok'))?0:1)}
if(a[0]==='login'){
  fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
  fs.writeFileSync(process.env.TEST_LAUNCH_FILE,JSON.stringify({home:process.env.CODEX_HOME,args:a}));
  setTimeout(()=>{fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.ok'),'ok');process.exit(0)},120);
}
`);
  try {
    const before = await probeCodex(bin, codexHome, { TEST_LAUNCH_FILE: launchFile });
    assert.equal(before.status, "not_authenticated");

    const first = startCodexLogin(bin, codexHome, { TEST_LAUNCH_FILE: launchFile });
    const duplicate = startCodexLogin(bin, codexHome, { TEST_LAUNCH_FILE: launchFile });
    assert.equal(first.state, "started");
    assert.equal(duplicate.state, "pending", "同一个产品 home 不能同时弹出两个登录流程");
    assert.equal(codexLoginProgress(codexHome)?.state, "pending");

    // 全量回归会并行启动大量 Node / PowerShell 子进程；给 Windows 启动器足够调度时间，
    // 否则测到的是机器负载而不是登录流程是否合并。
    for (let i = 0; i < 200 && !fs.existsSync(path.join(codexHome, "auth.ok")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(launchFile), "登录子进程应已启动并记录产品 CODEX_HOME");
    const launched = JSON.parse(fs.readFileSync(launchFile, "utf8")) as { home: string; args: string[] };
    assert.equal(launched.home, codexHome);
    assert.deepEqual(launched.args, ["login"]);
    const after = await probeCodex(bin, codexHome, { TEST_LAUNCH_FILE: launchFile });
    assert.equal(after.status, "ready");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex 登录超时后必须杀掉整组进程，父进程先退但子进程活着时仍不允许重开", { skip: process.platform === "win32" ? "中间态断言只适用于 POSIX 进程组；Windows 由 taskkill /T 直接终止树" : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-stubborn-codex-login-"));
  const codexHome = path.join(dir, "product-home");
  const parentPidFile = path.join(dir, "parent-pid");
  const childPidFile = path.join(dir, "child-pid");
  const bin = fakeNodeExecutable(dir, "codex", `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
if(process.env.TEST_IS_CHILD==='1'){
  process.on('SIGTERM',()=>{});
  fs.writeFileSync(process.env.TEST_CHILD_PID_FILE,String(process.pid));
  setInterval(()=>{},1000);
}else if(process.argv[2]==='login'){
  fs.writeFileSync(process.env.TEST_PARENT_PID_FILE,String(process.pid));
  spawn(process.execPath,[__filename],{env:{...process.env,TEST_IS_CHILD:'1'},stdio:'ignore'});
  setInterval(()=>{},1000);
}
`);
  try {
    const env = { TEST_PARENT_PID_FILE: parentPidFile, TEST_CHILD_PID_FILE: childPidFile };
    assert.equal(startCodexLogin(bin, codexHome, env, { timeoutMs: 1_500 }).state, "started");
    for (let i = 0; i < 100 && (!fs.existsSync(parentPidFile) || !fs.existsSync(childPidFile)); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(fs.existsSync(parentPidFile) && fs.existsSync(childPidFile), "父子进程都应真实启动");
    await new Promise((r) => setTimeout(r, 1_600));
    const parentPid = Number(fs.readFileSync(parentPidFile, "utf8"));
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    assert.throws(() => process.kill(parentPid, 0), /ESRCH/, "父进程应先响应 TERM 退出");
    assert.doesNotThrow(() => process.kill(childPid, 0), "顽固子进程仍活着时 job 必须保持 pending");
    assert.equal(startCodexLogin(bin, codexHome, env, { timeoutMs: 1_500 }).state, "pending");
    for (let i = 0; i < 80; i += 1) {
      let alive = true;
      try { process.kill(childPid, 0); } catch { alive = false; }
      if (!alive && codexLoginProgress(codexHome)?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 75));
    }
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    assert.equal(codexLoginProgress(codexHome)?.state, "failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude 参数强制无工具、无 MCP、无会话落盘，正文不进 argv", () => {
  const args = claudeArgs("SYSTEM", { type: "object" });
  assert.ok(args.includes("--safe-mode"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(!args.join(" ").includes("USER_SECRET_PROMPT"));
});

test("本机 Claude 探针只返回版本与登录布尔，不泄露账号", async () => {
  const f = fakeClaude();
  try {
    assert.equal(findExecutable("claude", { CLAUDE_BIN: f.bin, PATH: "" }), f.bin);
    const status = await probeClaude({ CLAUDE_BIN: f.bin, PATH: "" });
    assert.equal(status.status, "ready");
    assert.equal(status.version, "2.1.226 (Claude Code)");
    assert.ok(!JSON.stringify(status).includes("hidden@example.com"));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude 探针不把 API/云平台认证冒充订阅，旧版 CLI 也不点亮", async () => {
  const f = fakeClaude();
  try {
    const api = await probeClaude({ CLAUDE_BIN: f.bin, PATH: "", FAKE_AUTH_METHOD: "api_key" });
    assert.equal(api.status, "not_authenticated");
    const bedrock = await probeClaude({ CLAUDE_BIN: f.bin, PATH: "", FAKE_API_PROVIDER: "bedrock" });
    assert.equal(bedrock.status, "not_authenticated");
    const old = await probeClaude({ CLAUDE_BIN: f.bin, PATH: "", FAKE_OLD_HELP: "1" });
    assert.equal(old.status, "probe_failed");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude 订阅调用走 stdin，并移除会静默改计费方的 Anthropic API 环境变量", async () => {
  const f = fakeClaude();
  try {
    const out = await runLocalAgent("claude", {
      systemPrompt: "规则", userPrompt: "USER_SECRET_PROMPT",
      env: {
        CLAUDE_BIN: f.bin, PATH: process.env.PATH, ANTHROPIC_API_KEY: "must-not-forward",
        CLAUDE_CODE_OAUTH_TOKEN: "official-subscription-token",
      },
    });
    assert.equal(out, "USER_SECRET_PROMPT|keys=false|oauth=true");
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("Claude JSON 输出优先 structured_output，坏输出明确失败", () => {
  assert.equal(parseClaudeOutput('{"result":"普通回答"}'), "普通回答");
  assert.equal(parseClaudeOutput('{"result":"忽略","structured_output":{"ok":true}}'), '{"ok":true}');
  assert.throws(() => parseClaudeOutput("not json"), (e: unknown) => e instanceof LocalAgentError && e.code === "agent_bad_output");
});

test("Claude 超时后会清掉忽略 TERM 的整个派生进程组，再返回错误", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-stubborn-claude-"));
  const parentPidFile = path.join(dir, "parent-pid");
  const childPidFile = path.join(dir, "child-pid");
  const bin = fakeNodeExecutable(dir, "claude", `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
if(process.env.TEST_IS_CHILD==='1'){
  fs.writeFileSync(process.env.TEST_CHILD_PID_FILE,String(process.pid));
}else{
  fs.writeFileSync(process.env.TEST_PARENT_PID_FILE,String(process.pid));
  spawn(process.execPath,[__filename],{env:{...process.env,TEST_IS_CHILD:'1'}});
}
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`);
  try {
    await assert.rejects(
      () => runLocalAgent("claude", {
        // 全量测试并行启动大量 Node 子进程；1 秒可能在假进程真正获得调度前就到期，
        // 那只测到了机器负载，不是“已启动的顽固进程树能否被清理”。
        systemPrompt: "规则", userPrompt: "等待", timeoutMs: 5_000,
        env: {
          CLAUDE_BIN: bin, PATH: process.env.PATH,
          TEST_PARENT_PID_FILE: parentPidFile, TEST_CHILD_PID_FILE: childPidFile,
        },
      }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_timeout",
    );
    const parentPid = Number(fs.readFileSync(parentPidFile, "utf8"));
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    assert.throws(() => process.kill(parentPid, 0), /ESRCH/);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("一次性任务也受本机 Agent 全局并发上限约束，不能绕过会话表无限启动", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-busy-claude-"));
  const bin = fakeNodeExecutable(dir, "claude", `setInterval(()=>{},1000);\n`);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const runs = controllers.map((ac) => runLocalAgent("claude", {
    systemPrompt: "规则", userPrompt: "等待", signal: ac.signal,
    env: { CLAUDE_BIN: bin, PATH: process.env.PATH },
  }));
  try {
    await assert.rejects(
      () => runLocalAgent("claude", {
        systemPrompt: "规则", userPrompt: "第五个", env: { CLAUDE_BIN: bin, PATH: process.env.PATH },
      }),
      (e: unknown) => e instanceof LocalAgentError && e.code === "agent_busy",
    );
  } finally {
    controllers.forEach((ac) => ac.abort());
    const done = await Promise.allSettled(runs);
    assert.ok(done.every((x) => x.status === "rejected"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
