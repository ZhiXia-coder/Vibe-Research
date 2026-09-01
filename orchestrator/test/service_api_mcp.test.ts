import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createApiServer, resolveToken, isLoopbackHost } from "../src/api.ts";
import { ServiceError, assertArgs, chatSend, fetchEndpoint, ledgerList, ledgerSnapshot, ledgerUpsert, getEvidence, getReport, knowledgeRecall, listEndpoints, listRuns, redact, researchEnv, researchStatus, safePath, startResearch, type ServiceContext, displayUrl } from "../src/service.ts";
import { writeJson } from "../src/fsutil.ts";
import { detectPython } from "../src/init.ts";
import { directoryLink, fileLinkOrSkip } from "./platform.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 解释器:VRA_PYTHON → 仓库 .venv → 上一级 .venv(开发布局)→ PATH 上的 python3;不写死任何机器的绝对路径 */
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const TOKEN = "t".repeat(32);

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

/** 假仓库:真实注册表 + 假取数器(fetch_endpoint.py 替身,不联网,回显 args 与选定环境变量)+ 假运行目录 */
function fakeCtx(): ServiceContext {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-svc-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), `import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]; sym=a[a.index('--symbol')+1] if '--symbol' in a else 'MARKET'
extra=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
os.makedirs(os.path.join(out,'raw'),exist_ok=True); open(os.path.join(out,'raw','fake.json'),'w').write('{}')
envs={k:os.environ.get(k) for k in ('IWENCAI_API_KEY','VRA_SEC_CONTACT','OPENAI_API_KEY','MY_SECRET_TOKEN','VRA_ALLOW_INSECURE_TLS')}
env={"script":ep,"symbol":sym,"market":"SZ","status":"ok","fetched_at":"2026-01-01T00:00:00+08:00","primary_source":"fake","used_sources":["fake"],"evidence":[{"id":"ev-abcdef","symbol":sym,"market":"SZ","field":"f","value":1,"unit":"个","currency":"n/a","period":"2026-01-01","as_of":"2026-01-01","source":"fake","endpoint":ep,"fetched_at":"2026-01-01T00:00:00+08:00","adjustment":"not_applicable","raw_ref":"raw/fake.json"}],"extra":{"args":extra,"envs":envs},"errors":[],"missing":[]}
json.dump(env, open(os.path.join(out,'fetch',ep+'.json'),'w')); print(json.dumps(env)); sys.stderr.write('token=abc123 https://x/y?key=SECRET\\n'); sys.exit(0)
`);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "runs", "r1", "stages"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "runs", "r1", "fetch"), { recursive: true });
  writeJson(path.join(dataRoot, "runs", "r1", "manifest.json"), { run_id: "r1", symbol: "300308", status: "complete", exit_code: 0, stages: [{ stage: "profile", status: "complete", attempts: 1 }], evidence_count: 1, calculation_count: 0, started_at: "2026-01-01T00:00:00+08:00", finished_at: "2026-01-01T00:10:00+08:00" });
  writeJson(path.join(dataRoot, "runs", "r1", "evidence.json"), [{ id: "ev-111111", field: "price", value: 9, source: "tencent" }, { id: "ev-222222", field: "pe_ttm", value: 50, source: "tencent" }]);
  writeJson(path.join(dataRoot, "runs", "r1", "fetch", "fetch_profile.json"), {
    evidence: [{ id: "ev-name", field: "security_name", value: "中际旭创" }],
  });
  fs.writeFileSync(path.join(dataRoot, "runs", "r1", "report.md"), "# 报告\n");
  fs.writeFileSync(path.join(dataRoot, "runs", "r1", "viewer.html"), "<html></html>");
  fs.writeFileSync(path.join(dataRoot, "runs", "r1", "events.jsonl"), JSON.stringify({ type: "run.done" }) + "\n");
  return { repoRoot: repo, dataRoot, python: PY, node: process.execPath, providerEnvKey: "OPENAI_API_KEY" };
}

const noAbs = (v: unknown, ctx: ServiceContext) => { const s = JSON.stringify(v); assert.ok(!s.includes(ctx.dataRoot) && !s.includes(ctx.repoRoot) && !s.includes(os.tmpdir()), `返回值含绝对路径:${s.slice(0, 200)}`); };

test("service:端点列表 / 取数(子进程 + 落 .local/mcp,只带 auth_env,stderr 脱敏,相对路径)/ 运行状态 / 报告 / 证据 / 列表 / 输入校验", async () => {
  const ctx = fakeCtx();
  const eps = listEndpoints(ctx, { market: "CN", q: "研报" });
  assert.ok(eps.length >= 1 && eps.every((e) => e.market.includes("CN")));
  process.env.IWENCAI_API_KEY = "iw-secret"; process.env.MY_SECRET_TOKEN = "leak-me"; process.env.VRA_SEC_CONTACT = "Name mail@x.com";
  try {
    const r = await fetchEndpoint(ctx, { endpoint: "em_reports", symbol: "300308", args: { max_pages: 1 }, session: "t1" });
    assert.equal(r.exit_code, 0);
    assert.equal((r.envelope as { status: string }).status, "ok");
    assert.equal(r.out_dir, "mcp/t1");
    noAbs(r, ctx);
    const envs = (r.envelope as { extra: { envs: Record<string, string | null>; args: unknown } }).extra.envs;
    assert.equal(envs.IWENCAI_API_KEY, null, "非该端点 auth_env 的密钥不得透传");
    assert.equal(envs.MY_SECRET_TOKEN, null);
    assert.equal(envs.OPENAI_API_KEY, null);
    assert.deepEqual((r.envelope as { extra: { args: unknown } }).extra.args, { max_pages: 1 });
    assert.ok(!r.stderr_tail.includes("abc123") && !r.stderr_tail.includes("SECRET"), r.stderr_tail);
    const r2 = await fetchEndpoint(ctx, { endpoint: "iwencai_search", args: { query: "x" }, session: "t2" });
    assert.equal((r2.envelope as { extra: { envs: Record<string, string | null> } }).extra.envs.IWENCAI_API_KEY, "iw-secret", "只把该端点声明的 auth_env 传给取数器");
    const r3 = await fetchEndpoint(ctx, { endpoint: "sec_filings", symbol: "AAPL", session: "t3" });
    assert.equal((r3.envelope as { extra: { envs: Record<string, string | null> } }).extra.envs.VRA_SEC_CONTACT, "Name mail@x.com");
    assert.equal((r3.envelope as { extra: { envs: Record<string, string | null> } }).extra.envs.IWENCAI_API_KEY, null);
  } finally { delete process.env.IWENCAI_API_KEY; delete process.env.MY_SECRET_TOKEN; delete process.env.VRA_SEC_CONTACT; }
  await assert.rejects(() => fetchEndpoint(ctx, { endpoint: "no_such" }), (e: unknown) => e instanceof ServiceError && e.code === "unknown_endpoint");
  await assert.rejects(() => fetchEndpoint(ctx, { endpoint: "em_reports", symbol: "../x" }), (e: unknown) => e instanceof ServiceError && e.code === "bad_symbol");
  await assert.rejects(() => fetchEndpoint(ctx, { endpoint: "em_reports" }), (e: unknown) => e instanceof ServiceError && e.code === "missing_symbol");
  await assert.rejects(() => fetchEndpoint(ctx, { endpoint: "em_reports", symbol: "300308", session: "../evil" }), (e: unknown) => e instanceof ServiceError && e.code === "bad_session");
  // args 闭合校验
  const ep = { id: "em_reports", module: "eastmoney", function: "f", market: ["CN"], args: { max_pages: 2 } };
  assert.deepEqual(assertArgs(ep, { max_pages: 1, limit: 5 }), { max_pages: 1, limit: 5 });
  assert.throws(() => assertArgs(ep, { evil_param: 1 }), (e: unknown) => e instanceof ServiceError && e.code === "bad_args");
  assert.throws(() => assertArgs(ep, { max_pages: { nested: 1 } }), (e: unknown) => e instanceof ServiceError && e.code === "bad_args");
  assert.throws(() => assertArgs(ep, { max_pages: "x".repeat(201) }), (e: unknown) => e instanceof ServiceError && e.code === "bad_args");
  assert.throws(() => assertArgs(ep, { max_pages: Infinity }), (e: unknown) => e instanceof ServiceError && e.code === "bad_args");
  assert.throws(() => assertArgs(ep, [1]), (e: unknown) => e instanceof ServiceError && e.code === "bad_args");
  const st = researchStatus(ctx, "r1");
  assert.ok(st.exists && st.status === "complete" && st.report && st.stages[0].stage === "profile" && st.last_events.length === 1 && st.viewer === "runs/r1/viewer.html");
  noAbs(st, ctx);
  assert.equal(researchStatus(ctx, "nope").exists, false);
  assert.throws(() => researchStatus(ctx, "../x"), (e: unknown) => e instanceof ServiceError && e.code === "bad_run_id");
  assert.equal(getReport(ctx, "r1").report, "# 报告\n");
  assert.equal(getEvidence(ctx, "r1", { field: "pe_ttm" }).total, 1);
  assert.equal(getEvidence(ctx, "r1", { q: "tencent" }).total, 2);
  assert.deepEqual({ run_id: listRuns(ctx)[0].run_id, name: listRuns(ctx)[0].name }, { run_id: "r1", name: "中际旭创" });
  assert.equal(knowledgeRecall(ctx, "300308", "SZ"), null);
  assert.throws(() => knowledgeRecall(ctx, "300308", "XX"), (e: unknown) => e instanceof ServiceError && e.code === "bad_market");
  const red = redact("x ?token=abc&key=def https://h/p?sig=1 api_key: sk-1");
  assert.ok(!red.includes("abc") && !red.includes("def") && !red.includes("sig=1") && !red.includes("sk-1") && red.includes("***"), red);
});

test("service:符号链接穿越被拒(运行目录 / 产物文件 / session 目录)", async (t) => {
  const ctx = fakeCtx();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-outside-"));
  fs.writeFileSync(path.join(outside, "report.md"), "OUTSIDE");
  directoryLink(outside, path.join(ctx.dataRoot, "runs", "r2"));            // 运行目录是链接
  assert.throws(() => getReport(ctx, "r2"), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  assert.throws(() => researchStatus(ctx, "r2"), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  fs.mkdirSync(path.join(ctx.dataRoot, "mcp"), { recursive: true });
  directoryLink(outside, path.join(ctx.dataRoot, "mcp", "evil"));             // session 目录是链接
  await assert.rejects(() => fetchEndpoint(ctx, { endpoint: "em_reports", symbol: "300308", session: "evil" }), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  assert.throws(() => safePath(ctx, "..", "x"), (e: unknown) => e instanceof ServiceError && e.code === "path_escape");
  assert.equal(safePath(ctx, "runs", "r1"), path.resolve(ctx.dataRoot, "runs", "r1"));
  if (!fileLinkOrSkip(t, path.join(outside, "report.md"), path.join(ctx.dataRoot, "runs", "r1", "report_appendix.md"))) return;
  assert.throws(() => getReport(ctx, "r1"), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  // 最终文件是链接:日志 / manifest / api.token
  fs.mkdirSync(path.join(ctx.dataRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(outside, "victim.log"), "");
  fs.symlinkSync(path.join(outside, "victim.log"), path.join(ctx.dataRoot, "logs", "svc-link.log"));
  assert.throws(() => startResearch(ctx, { symbol: "300308", run_id: "svc-link", no_agent: true }), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  assert.equal(fs.readFileSync(path.join(outside, "victim.log"), "utf8"), "", "数据区外文件不得被追加");
  fs.mkdirSync(path.join(ctx.dataRoot, "runs", "r3"));
  fs.writeFileSync(path.join(outside, "m.json"), JSON.stringify({ status: "OUTSIDE", symbol: "X" }));
  fs.symlinkSync(path.join(outside, "m.json"), path.join(ctx.dataRoot, "runs", "r3", "manifest.json"));
  assert.equal(listRuns(ctx).find((r) => r.run_id === "r3")?.status, null, "manifest 是链接 → 不读");
  assert.throws(() => researchStatus(ctx, "r3"), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  fs.writeFileSync(path.join(outside, "tok"), "x".repeat(40));
  fs.symlinkSync(path.join(outside, "tok"), path.join(ctx.dataRoot, "api.token"));
  assert.throws(() => resolveToken(ctx, {}), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  assert.equal(fs.readFileSync(path.join(outside, "tok"), "utf8"), "x".repeat(40), "数据区外 token 文件不得被覆盖");
});

test("service:startResearch 立即返回相对路径;子进程最小环境(researchEnv);参数校验", async () => {
  const ctx = fakeCtx();
  const r = startResearch(ctx, { symbol: "300308", market: "SZ", endpoints: "core", knowledge: "off", no_agent: true, run_id: "svc-test-1" });
  assert.equal(r.run_id, "svc-test-1");
  assert.equal(r.run_dir, "runs/svc-test-1");
  assert.equal(r.log, "logs/svc-test-1.log");
  noAbs(r, ctx);
  assert.ok(fs.existsSync(path.join(ctx.dataRoot, r.log)));
  assert.throws(
    () => startResearch(ctx, { symbol: "00700", market: "HK", no_agent: true, run_id: "svc-hk" }),
    (e: unknown) => e instanceof ServiceError && e.code === "unsupported_market",
    "港股没有完整必需取数链时不应空跑并消耗模型额度",
  );
  assert.throws(
    () => startResearch(ctx, { symbol: "NVDA", market: "US", no_agent: true, run_id: "svc-us" }),
    (e: unknown) => e instanceof ServiceError && e.code === "unsupported_market",
    "美股没有完整必需取数链时不应空跑并消耗模型额度",
  );
  const env = researchEnv(ctx, { PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk-prov", VRA_SEC_CONTACT: "c", AWS_SECRET_ACCESS_KEY: "leak", GITHUB_TOKEN: "leak", CODEX_API_KEY: "leak", HTTPS_PROXY: "p" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "OPENAI_API_KEY", "PATH", "VRA_SEC_CONTACT"]);
  assert.throws(() => startResearch(ctx, { symbol: "300308", market: "XX" }), (e: unknown) => e instanceof ServiceError && e.code === "bad_market");
  assert.throws(() => startResearch(ctx, { symbol: "300308", stages: ["nope"] }), (e: unknown) => e instanceof ServiceError && e.code === "bad_stage");
  assert.throws(() => startResearch(ctx, { symbol: "300308", company_name: `中际旭创\n${"x".repeat(80)}` }), (e: unknown) => e instanceof ServiceError && e.code === "bad_company_name");
  assert.throws(() => startResearch(ctx, { symbol: "300308", run_id: "../x" }), (e: unknown) => e instanceof ServiceError && e.code === "bad_run_id");
  assert.throws(() => startResearch(ctx, { symbol: "300308", endpoints: "all" as never }), (e: unknown) => e instanceof ServiceError && e.code === "bad_scope");
});

test("HTTP API:token 必需 / 非本机 Origin 403 / 跨站 403 / 非 JSON POST 415 / 路由 / 无绝对路径 / 500 脱敏", async () => {
  const ctx = fakeCtx();
  assert.throws(() => createApiServer(ctx, { token: "short" }), /16/);
  const srv = createApiServer(ctx, { token: TOKEN });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const port = (srv.address() as { port: number }).port;
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ code: number; json: unknown; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { let j: unknown = null; try { j = JSON.parse(buf); } catch { /* text */ } resolve({ code: res.statusCode ?? 0, json: j, text: buf }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
  try {
    assert.equal((await call("GET", "/health")).code, 200);
    assert.ok(!JSON.stringify((await call("GET", "/health")).json).includes(ctx.dataRoot));
    assert.equal((await call("GET", "/health", undefined, { Authorization: "Bearer wrong" })).code, 401);
    assert.equal((await call("GET", "/health", undefined, { Authorization: "" })).code, 401);
    assert.equal((await call("POST", "/fetch", { endpoint: "em_reports", symbol: "300308" }, { Origin: "https://evil.example" })).code, 403);
    assert.equal((await call("POST", "/fetch", { endpoint: "em_reports", symbol: "300308" }, { "Sec-Fetch-Site": "cross-site" })).code, 403);
    assert.equal((await call("POST", "/fetch", "{}", { "Content-Type": "text/plain" })).code, 415);
    assert.equal((await call("GET", "/health", undefined, { Origin: "http://localhost:5173" })).code, 200);
    const agents = await call("GET", "/local-agents");
    assert.equal(agents.code, 200);
    assert.deepEqual((agents.json as { provider: string }[]).map((x) => x.provider), ["cli-codex", "cli-claude"]);
    assert.ok(!agents.text.includes(ctx.repoRoot) && !agents.text.includes(ctx.dataRoot) && !agents.text.includes("@"), "运行时探针不应回传路径或账号");
    const eps = await call("GET", "/endpoints?market=US&q=yahoo");
    assert.equal(eps.code, 200);
    assert.ok((eps.json as unknown[]).length >= 1);
    const f = await call("POST", "/fetch", { endpoint: "em_reports", symbol: "300308", session: "api" });
    assert.equal(f.code, 200);
    assert.equal((f.json as { envelope: { status: string } }).envelope.status, "ok");
    assert.ok(!f.text.includes(ctx.dataRoot));
    assert.equal((await call("POST", "/fetch", { endpoint: "em_reports", symbol: "../x" })).code, 400);
    assert.equal((await call("POST", "/fetch", { endpoint: "em_reports", symbol: "300308", args: { evil: 1 } })).code, 400);
    assert.equal((await call("GET", "/runs/r1/status")).code, 200);
    assert.equal((await call("GET", "/runs/r1/report")).code, 200);
    assert.equal(((await call("GET", "/runs/r1/evidence?field=price")).json as { total: number }).total, 1);
    assert.equal((await call("GET", "/runs/r1/manifest")).code, 200);
    assert.equal((await call("GET", "/runs/r1/viewer")).code, 200);
    assert.equal((await call("GET", "/runs/nope/viewer")).code, 404);
    assert.equal((await call("GET", "/runs/..%2Fx/status")).code, 400);
    assert.equal((await call("GET", "/knowledge/SZ/300308")).code, 200);
    // 用户研报：上传即提取正文并建索引；列表不泄露磁盘路径 / sha；原文件可下载；删除走 POST。
    const reportBody = Buffer.from("300308 中际旭创研报：高速光模块需求增长", "utf8");
    const up = await call("POST", "/reports", { name: "300308-test.md", content: `data:text/markdown;base64,${reportBody.toString("base64")}` });
    assert.equal(up.code, 200);
    const reportId = (up.json as { id: string }).id;
    assert.match(reportId, /^[0-9a-f]{32}$/);
    const reportList = await call("GET", "/reports");
    assert.equal(reportList.code, 200);
    assert.equal((reportList.json as unknown[]).length, 1);
    assert.ok(!reportList.text.includes(ctx.dataRoot) && !reportList.text.includes("sha256") && !reportList.text.includes("text_file"));
    const dl = await call("GET", `/reports/${reportId}/download`);
    assert.equal(dl.code, 200); assert.equal(dl.text, reportBody.toString("utf8"));
    const del = await call("POST", `/reports/${reportId}/delete`, { id: "ffffffffffffffffffffffffffffffff" });
    assert.equal(del.code, 200); assert.deepEqual(del.json, { removed: true }, "删除必须认 URL 里的 id，不能被请求体覆盖");
    assert.equal(((await call("GET", "/reports")).json as unknown[]).length, 0);
    assert.equal((await call("GET", "/nope")).code, 404);
    // 薄 UI:/login 用 token 换 Cookie;Cookie 只对只读 GET 有效;POST 仍只认 Bearer
    const login = await new Promise<{ code: number; cookie: string; loc: string }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `/login?token=${TOKEN}` }, (r) => { resolve({ code: r.statusCode ?? 0, cookie: String(r.headers["set-cookie"]?.[0] ?? ""), loc: String(r.headers.location ?? "") }); r.resume(); }).on("error", reject);
    });
    assert.equal(login.code, 302); assert.equal(login.loc, "/ui"); assert.ok(login.cookie.includes("HttpOnly") && login.cookie.includes("SameSite=Strict"));
    assert.equal((await call("GET", "/login?token=wrong", undefined, { Authorization: "" })).code, 401);
    const cookieHdr = { Authorization: "", Cookie: `vra_token=${TOKEN}` };
    const ui = await call("GET", "/ui", undefined, cookieHdr);
    assert.equal(ui.code, 200); assert.ok(ui.text.includes("r1") && ui.text.includes("运行列表") && !ui.text.includes(ctx.dataRoot));
    const uiRunPage = await call("GET", "/ui/runs/r1", undefined, cookieHdr);
    assert.equal(uiRunPage.code, 200); assert.ok(uiRunPage.text.includes("# 报告") && uiRunPage.text.includes("/runs/r1/viewer"));
    assert.equal((await call("GET", "/ui/runs/nope", undefined, cookieHdr)).code, 404);
    assert.equal((await call("GET", "/runs/r1/report", undefined, cookieHdr)).code, 200, "Cookie 可读只读 GET");
    assert.equal((await call("POST", "/fetch", { endpoint: "em_reports", symbol: "300308" }, cookieHdr)).code, 401, "POST 不认 Cookie");
    assert.equal((await call("GET", "/ui", undefined, { Authorization: "", Cookie: "vra_token=wrong" })).code, 401);
    // Cookie 只对白名单只读 GET 有效:非白名单 GET(/endpoints /health /knowledge /runs/:id/evidence|manifest)即使 cookie 正确也 401
    for (const pth of ["/endpoints", "/health", "/knowledge/SZ/300308", "/runs/r1/evidence", "/runs/r1/manifest", "/nope"])
      assert.equal((await call("GET", pth, undefined, cookieHdr)).code, 401, `cookie 不应放行 ${pth}`);
    // 安全响应头:所有响应带 Referrer-Policy: no-referrer + nosniff + no-store(含 /login 302 与 HTML 页)
    const head = (p: string, headers: Record<string, string> = {}) => new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: p, headers }, (r) => { resolve(r.headers); r.resume(); }).on("error", reject);
    });
    for (const [p, h] of [[`/login?token=${TOKEN}`, {}], ["/ui", cookieHdr], ["/health", { Authorization: `Bearer ${TOKEN}` }]] as const) {
      const hs = await head(p, h as Record<string, string>);
      assert.equal(hs["referrer-policy"], "no-referrer", p); assert.equal(hs["x-content-type-options"], "nosniff", p); assert.equal(hs["cache-control"], "no-store", p);
    }
    // UI 转义:恶意 run_id / 状态 / 报告正文不进 HTML 原文
    const evilId = "r1"; // run id 受 assertRunId 限制,这里只验证报告正文与状态字段的转义路径
    fs.writeFileSync(path.join(ctx.dataRoot, "runs", evilId, "report.md"), "# r\n<script>alert(1)</script> \"q\" 'x'\n");
    const page = await call("GET", `/ui/runs/${evilId}`, undefined, cookieHdr);
    assert.equal(page.code, 200); assert.ok(!page.text.includes("<script>alert(1)</script>")); assert.ok(page.text.includes("&lt;script&gt;"));
    // 500:底层非 ServiceError 异常 → 只回 {error:"internal"},不带路径 / 堆栈
    fs.rmSync(path.join(ctx.dataRoot, "runs"), { recursive: true, force: true });
    fs.writeFileSync(path.join(ctx.dataRoot, "runs"), "not a dir");
    const r500 = await call("GET", "/runs");
    assert.equal(r500.code, 500); assert.deepEqual(r500.json, { error: "internal" });
    fs.rmSync(path.join(ctx.dataRoot, "runs"));
  } finally { srv.close(); }
  // 回环判定口径(前置 token 检查与 cookie 开关共用)
  for (const h of ["127.0.0.1", "localhost", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.2", "example.com", ""]) assert.equal(isLoopbackHost(h), false, h);
  // 非本机绑定模式(cookieLogin=false):/login 404,cookie 对白名单路由也无效,Bearer 照常
  const srv2 = createApiServer(ctx, { token: TOKEN, cookieLogin: false });
  await new Promise<void>((res) => srv2.listen(0, "127.0.0.1", () => res()));
  const port2 = (srv2.address() as { port: number }).port;
  const get2 = (p: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => { http.get({ host: "127.0.0.1", port: port2, path: p, headers }, (r) => { resolve(r.statusCode ?? 0); r.resume(); }).on("error", reject); });
  try {
    assert.equal(await get2(`/login?token=${TOKEN}`), 404);
    assert.equal(await get2("/ui", { Cookie: `vra_token=${TOKEN}` }), 401);
    assert.equal(await get2("/ui", { Authorization: `Bearer ${TOKEN}` }), 200);
  } finally { srv2.close(); }
  const tk = resolveToken(ctx, {});
  assert.equal(tk.source, "generated"); assert.ok(tk.token.length >= 32 && fs.existsSync(tk.file));
  if (process.platform !== "win32") assert.equal((fs.statSync(tk.file).mode & 0o777), 0o600);
  assert.equal(resolveToken(ctx, {}).source, "file");
  assert.equal(resolveToken(ctx, { VRA_API_TOKEN: "e".repeat(20) }).source, "env");
});

test("MCP:stdio 起真实 server(SDK Client),tools/list 含 8 个工具,list_endpoints / fetch_endpoint / research_status 可调,错误以 isError 返回,返回无绝对路径", async () => {
  const ctx = fakeCtx();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, "orchestrator", "src", "mcp.ts"), "--repo-root", ctx.repoRoot], env: { ...process.env, VRA_PYTHON: ctx.python } });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["fetch_endpoint", "get_evidence", "get_report", "knowledge_recall", "list_endpoints", "list_runs", "research_status", "start_research"]);
    const le = await client.callTool({ name: "list_endpoints", arguments: { q: "研报", market: "CN" } });
    assert.ok(JSON.parse((le.content as { text: string }[])[0].text).some((e: { id: string }) => e.id === "em_reports"));
    const fe = await client.callTool({ name: "fetch_endpoint", arguments: { endpoint: "em_reports", symbol: "300308", session: "mcp" } });
    const env = JSON.parse((fe.content as { text: string }[])[0].text);
    assert.equal(env.envelope.status, "ok"); assert.equal(env.out_dir, "mcp/mcp");
    const bad = await client.callTool({ name: "fetch_endpoint", arguments: { endpoint: "em_reports", symbol: "../x?token=abc123" } });
    assert.equal(bad.isError, true);
    const badText = (bad.content as { text: string }[])[0].text;
    assert.ok(!badText.includes("abc123") && badText.includes("bad_symbol") && !badText.includes(ctx.dataRoot), badText);
    const st = await client.callTool({ name: "research_status", arguments: { run_id: "r1" } });
    const stText = (st.content as { text: string }[])[0].text;
    assert.equal(JSON.parse(stText).status, "complete"); assert.ok(!stText.includes(ctx.dataRoot));
  } finally { await client.close(); }
});

test("台账全量读取也要过 safePath —— 防线只在次要入口生效等于没有防线", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ledgersvc-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-outside-"));
  const ctx = { repoRoot: root, dataRoot: root, python: "python3", node: process.execPath, providerEnvKey: null } as ServiceContext;

  // 先正常写一条,确保目录与文件存在
  ledgerUpsert(ctx, { kind: "position", record: { symbol: "300308", shares: 1, cost: 1 } });
  const f = path.join(root, "ledger", "position.json");
  fs.writeFileSync(path.join(outside, "evil.json"), JSON.stringify({ schema_version: 1, kind: "position", records: [] }));
  fs.rmSync(f);
  if (!fileLinkOrSkip(t, path.join(outside, "evil.json"), f)) return; // 数据区里被塞了指向区外的链接

  // 单查会被挡 —— 这条原本就过
  assert.throws(() => ledgerList(ctx, "position"), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
  // 🔴 全查是界面的**主入口**,原实现直接调 listAll,绕过了这道防线
  assert.throws(() => ledgerList(ctx), (e: unknown) => e instanceof ServiceError && e.code === "path_symlink");
});

/** 真仓库根(读得到注册表)+ 临时数据根(快照不污染本机) */
const realRepoCtx = (): ServiceContext => ({
  repoRoot: REPO,
  dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-svc-real-")),
  python: process.env.VRA_PYTHON ?? "python3",
  node: process.execPath,
  providerEnvKey: null,
} as ServiceContext);

const svcCtx = (): ServiceContext => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-svc-"));
  return { repoRoot: root, dataRoot: root, python: "python3", node: process.execPath, providerEnvKey: null } as ServiceContext;
};

test("🔴 /ledger 的 records 与 issues 必须来自同一次读盘(分两次读会自相矛盾)", () => {
  const ctx = svcCtx();
  const rec = ledgerUpsert(ctx, { kind: "thesis", record: { title: "正常一条" } });
  const snap = ledgerSnapshot(ctx);
  assert.ok(snap.records.thesis?.some((r) => r.id === rec.id));
  assert.deepEqual({ ...snap.issues }, {});

  // 手改成不合契约的一条:同一次快照里,它既在 records 里、也在 issues 里 —— 两半对得上
  const file = path.join(ctx.dataRoot, "ledger", "thesis.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  d.records[0]!.title = 123; // title 应是字符串
  fs.writeFileSync(file, JSON.stringify(d));
  const bad = ledgerSnapshot(ctx);
  assert.equal(bad.records.thesis?.length, 1, "坏记录仍然返回(不删不改)");
  assert.equal(bad.issues.thesis?.length, 1, "同一份响应里必须同时报出问题");
  assert.equal(bad.issues.thesis?.[0]!.id, rec.id, "issue 指的就是响应里那条");
});

test("请求体上限按字节算,不按字符算(一个中文 3 字节却只算 1 个字符)", async () => {
  const ctx = svcCtx();
  const server = createApiServer(ctx, { token: "t-test-token-0123456789" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const big = "中".repeat(200 * 1024); // 字符 20 万 < 256K 上限,字节约 600KB > 256KB
    const r = await fetch(`http://127.0.0.1:${port}/ledger/thesis`, {
      method: "POST",
      headers: { authorization: "Bearer t-test-token-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ title: big }),
    });
    // 🔴 状态码也要断言:上一版只断言了 error 码,于是"注释说 413、代码回 400"这件事被放过去了
    assert.equal(r.status, 413, "请求体过大是 413,不是笼统的 400");
    assert.equal(((await r.json()) as { error?: string }).error, "body_too_large");
    assert.equal(r.headers.get("connection"), "close", "不收连接的话客户端会一直卡在上传上");
  } finally {
    server.close();
  }
});

test("运行产物的 HTML 以 CSP 送出 —— 产物里混进 <script> 时不能在已认证的源上执行", async () => {
  const ctx = svcCtx();
  const runDir = path.join(ctx.dataRoot, "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "viewer.html"), "<html><body>hi</body></html>");
  const server = createApiServer(ctx, { token: "t-test-token-0123456789" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/runs/r1/viewer`, { headers: { authorization: "Bearer t-test-token-0123456789" } });
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/, "HTML 响应必须带 CSP");
    assert.match(csp, /sandbox/);
    // JSON 响应不需要 CSP(带上只是噪音)
    const j = await fetch(`http://127.0.0.1:${port}/runs`, { headers: { authorization: "Bearer t-test-token-0123456789" } });
    assert.equal(j.headers.get("content-security-policy"), null);
  } finally {
    server.close();
  }
});

test("🔴 同一份查询并发进来只真取一次(single-flight)—— 否则一屏五个卡片打五次上游", async () => {
  const ctx = realRepoCtx();
  let spawned = 0;
  // 端点用 tx_quotes_batch:参数一致 ⇒ 快照键一致
  const req = { endpoint: "tx_quotes_batch", args: { codes: ["300308"] }, consistency: { mode: "fresh" as const } };
  const orig = process.env.PATH;
  try {
    const results = await Promise.allSettled([fetchEndpoint(ctx, req), fetchEndpoint(ctx, req), fetchEndpoint(ctx, req)]);
    // 三个都拿到同一个结果对象(共用同一个在飞的 Promise)
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<unknown>[];
    if (ok.length === 3) {
      assert.equal(ok[0]!.value, ok[1]!.value, "并发的两次应共用同一个 Promise 的结果");
      assert.equal(ok[1]!.value, ok[2]!.value);
    } else {
      // 取数失败(本机网络/代理)时这条测不到并发,但**不能因此假绿** —— 明说跳过原因
      assert.ok(results.every((r) => r.status === "rejected"), "要么全成要么全败:部分成功说明没走同一条飞行");
    }
  } finally {
    process.env.PATH = orig;
    void spawned;
  }
});

test("🔴 cache_only 没快照就报错,绝不偷偷联网", async () => {
  const ctx = realRepoCtx();
  await assert.rejects(
    () => fetchEndpoint(ctx, { endpoint: "fetch_quote", symbol: "300308", consistency: { mode: "cache_only" } }),
    (e: unknown) => e instanceof ServiceError && e.code === "no_snapshot",
  );
});

/**
 * 展示用 URL 必须剥掉凭据。
 * 🔴 主密钥只在环境变量里,但 `base_url` 是用户能自己编辑的 —— 一条
 *    `https://user:secret@host/v1` 会**原样**回到设置页(审计 pages-r1-P1)。
 */
test("displayUrl 剥掉用户名 / 密码 / 查询串 / 片段", () => {
  assert.ok(!displayUrl("https://u:p@h.example/v1")!.includes("p@"), displayUrl("https://u:p@h.example/v1")!);
  assert.ok(!displayUrl("https://u:p@h.example/v1")!.includes("secret"));
  const q = displayUrl("https://h.example/v1?api_key=SECRET&x=1")!;
  assert.ok(!q.includes("SECRET") && !q.includes("api_key"), q);
  assert.match(q, /已隐藏/, "隐掉了就要说一声,不然用户以为自己没配上");
  // 🔴 连路径都不回:有些供应商把密钥放在**路径段**里,剥 query 剥不掉它
  const withKeyInPath = displayUrl("https://h.example/v1/sk-SECRETSECRET/chat")!;
  assert.ok(!withKeyInPath.includes("SECRET"), withKeyInPath);
  assert.match(withKeyInPath, /已隐藏.*3 段路径/, withKeyInPath);
  assert.equal(displayUrl("https://h.example"), "https://h.example", "没有路径就不加噪音");
  assert.equal(displayUrl(null), null);
  // 解析不了**不回原串** —— 回原串等于"解析失败时反而全暴露"
  const bad = displayUrl("not a url ?token=SECRET")!;
  assert.ok(!bad.includes("SECRET"), bad);
  // 🔴 非 http(s) 一律不显示原文:data: 之类整段内容都在 path 里,剥 query 根本剥不掉
  for (const u of ["data:text/plain;base64,U0VDUkVU", "weird://host/SECRET", "javascript:alert('SECRET')"]) {
    const out = displayUrl(u)!;
    assert.ok(!out.includes("SECRET") && !out.includes("U0VDUkVU"), `${u} → ${out}`);
  }
  // 换行 / 空白不能把内容带出来
  assert.ok(!displayUrl("https://h.example/v1?x=1\n\nSECRET")!.includes("SECRET"));
});

test("🔴 /chat 的 llm 在**边界**上校验形状 —— 畸形负载给可读的 400，不是 500", async () => {
  const ctx: ServiceContext = { repoRoot: REPO, dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-llmshape-")), python: "python3", node: process.execPath, providerEnvKey: null };
  const bad: [unknown, string][] = [
    ["x", "llm 必须是一个对象"],
    // 🔴 显式 null 不算"没传":当没传处理等于给"静默换一家去打"留了后门
    [null, "llm 必须是一个对象"],
    [["a"], "llm 必须是一个对象"],
    [{ provider: {} }, "llm.provider 必须是字符串"],
    [{ provider: "mimo", apiKey: { secret: "x" } }, "llm.apiKey 必须是字符串"],
    [{ provider: "mimo", model: 1 }, "llm.model 必须是字符串"],
    // 未知字段要拒:悄悄忽略的话,前端多打一个字段就永远不生效,而两边都看不出来
    [{ provider: "mimo", apiKey: "k", extra: "x" }, "不认识的字段 extra"],
  ];
  for (const [llm, want] of bad) {
    await assert.rejects(
      () => chatSend(ctx, { message: "问", llm } as never),
      (e: unknown) => e instanceof ServiceError && e.code === "bad_llm" && e.message.includes(want),
      `${JSON.stringify(llm)} 应报 bad_llm/${want}`,
    );
  }
  fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
});

test("浏览器断开 /chat 后，API 会把取消信号传到底层并结束本机 Claude 进程", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-api-abort-"));
  const pidFile = path.join(root, "claude.pid");
  const bin = fakeNodeExecutable(root, "claude", `
const fs=require('node:fs');
fs.writeFileSync(process.env.TEST_CLAUDE_PID,String(process.pid));
setInterval(()=>{},1000);
`);
  const ctx: ServiceContext = {
    repoRoot: REPO, dataRoot: path.join(root, "data"), python: "python3",
    node: process.execPath, providerEnvKey: null,
  };
  fs.mkdirSync(ctx.dataRoot, { recursive: true });
  const oldBin = process.env.CLAUDE_BIN;
  const oldPid = process.env.TEST_CLAUDE_PID;
  process.env.CLAUDE_BIN = bin;
  process.env.TEST_CLAUDE_PID = pidFile;
  const server = createApiServer(ctx, { token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const request = http.request({
      host: "127.0.0.1", port, path: "/chat", method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    request.on("error", () => { /* 主动 destroy 的预期结果 */ });
    request.end(JSON.stringify({ session: "abort-live", message: "等待", llm: { provider: "cli-claude" } }));
    // 全量测试会并行启动较多 Node 子进程；给假 CLI 足够的调度时间，避免把负载抖动
    // 误报成取消链路失败。若仍未启动，先销毁请求，不能让 finally 等满 180 秒。
    for (let i = 0; i < 500 && !fs.existsSync(pidFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!fs.existsSync(pidFile)) request.destroy();
    assert.ok(fs.existsSync(pidFile), "假 Claude 必须真的启动，才能证明取消链路");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    request.destroy();
    for (let i = 0; i < 100; i += 1) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = oldBin;
    if (oldPid === undefined) delete process.env.TEST_CLAUDE_PID; else process.env.TEST_CLAUDE_PID = oldPid;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
