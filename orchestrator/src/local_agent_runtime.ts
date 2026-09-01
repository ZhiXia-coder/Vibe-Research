/**
 * 本机 Agent CLI 适配层。
 *
 * 来源与边界：参考 nexu-io/open-design 0.21.0 的 runtime registry / detection，
 * 但这里只收下金融工作台当前能安全证明的最小能力：Claude Code 订阅。
 * Open Design 对 Qwen / DeepSeek 使用自动批准模式；本产品的对话通道承诺“无本地工具”，
 * 所以在没有等价的禁工具调用方式与实测之前，不能照搬后把按钮点亮。
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_ACTIVE_LOCAL_AGENTS = 4;
let activeLocalAgents = 0;

export type LocalAgentId = "claude";

export interface LocalAgentStatus {
  provider: "cli-codex" | "cli-claude";
  name: "Codex" | "Claude Code";
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  version: string | null;
  status: "ready" | "not_installed" | "not_authenticated" | "login_pending" | "login_failed" | "probe_failed";
  detail: string;
}

export interface CodexLoginProgress {
  state: "pending" | "failed";
  startedAt: number;
  finishedAt?: number;
}

const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const CODEX_LOGIN_FAILURE_TTL_MS = 60 * 1_000;
const codexLoginJobs = new Map<string, CodexLoginProgress>();

/**
 * CreateProcess 可以用绝对路径启动 PowerShell，但 PowerShell / npm 启动器自身仍依赖几项
 * Windows 系统环境。受控调用传最小 env 时只补这些非凭据字段，不把用户 PATH 或密钥带回去。
 */
function windowsRuntimeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return { ...base };
  const out = { ...base };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"] as const) {
    if (out[key] === undefined && process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

/** Windows 没有 POSIX 进程组；taskkill /T 是对应的整棵进程树终止语义。 */
function signalProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
    } else if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* 整棵已经退出 */ }
}

function codexHomeKey(codexHome: string): string {
  return path.resolve(codexHome);
}

/** 只暴露产品需要的登录进度，不暴露 CLI 输出、账号或认证内容。 */
export function codexLoginProgress(codexHome: string): CodexLoginProgress | null {
  const key = codexHomeKey(codexHome);
  const progress = codexLoginJobs.get(key) ?? null;
  if (progress?.state === "failed" && Date.now() - (progress.finishedAt ?? 0) > CODEX_LOGIN_FAILURE_TTL_MS) {
    codexLoginJobs.delete(key);
    return null;
  }
  return progress;
}

/**
 * 启动官方 `codex login` 浏览器登录流程。登录态严格写入产品自己的 CODEX_HOME，
 * 同一个产品 home 同时只允许一条登录流程，避免重复弹浏览器窗口。
 */
export function startCodexLogin(
  bin: string | null, codexHome: string, env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {},
): { state: "started" | "pending" } {
  if (!bin || !fs.existsSync(bin)) {
    throw new LocalAgentError("agent_not_installed", "产品自带的 Codex 引擎不存在");
  }
  try {
    fs.accessSync(bin, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
  } catch {
    throw new LocalAgentError("agent_start_failed", "产品自带的 Codex 引擎无法启动");
  }

  const key = codexHomeKey(codexHome);
  if (codexLoginJobs.get(key)?.state === "pending") return { state: "pending" };
  fs.mkdirSync(key, { recursive: true, mode: 0o700 });
  const progress: CodexLoginProgress = { state: "pending", startedAt: Date.now() };
  codexLoginJobs.set(key, progress);

  const runEnv = { ...windowsRuntimeEnv(env), CODEX_HOME: key };
  const launch = executableInvocation(bin, ["login"], runEnv);
  const child = spawn(launch.file, launch.args, {
    env: runEnv,
    stdio: "ignore",
    shell: false,
    detached: process.platform !== "win32",
  });
  let settled = false;
  let timedOut = false;
  let hardKillTimer: NodeJS.Timeout | null = null;
  let exitPollTimer: NodeJS.Timeout | null = null;
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (exitPollTimer) clearTimeout(exitPollTimer);
    codexLoginJobs.set(key, { ...progress, state: "failed", finishedAt: Date.now() });
  };
  const signalTree = (signal: NodeJS.Signals) => {
    signalProcessTree(child, signal);
  };
  const processTreeAlive = (): boolean => {
    if (process.platform === "win32") return child.exitCode === null;
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch { return false; }
  };
  const failWhenTreeExited = () => {
    if (!processTreeAlive()) return fail();
    exitPollTimer = setTimeout(failWhenTreeExited, 50);
    exitPollTimer.unref();
  };
  const timeoutMs = Math.max(50, options.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS);
  const timer = setTimeout(() => {
    // 仍保持 pending，直到 close 或 KILL 收尾完成；否则用户能在旧进程仍活着时启动第二条登录。
    timedOut = true;
    signalTree("SIGTERM");
    hardKillTimer = setTimeout(() => {
      signalTree("SIGKILL");
      failWhenTreeExited();
    }, 2_000);
    hardKillTimer.unref();
  }, timeoutMs);
  timer.unref();
  child.once("error", fail);
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut && processTreeAlive()) {
      // 直接 child 已关不代表同组派生进程已关；保留 KILL timer 与 pending 状态。
      settled = false;
      return;
    }
    if (hardKillTimer) clearTimeout(hardKillTimer);
    if (exitPollTimer) clearTimeout(exitPollTimer);
    if (code === 0) codexLoginJobs.delete(key);
    else codexLoginJobs.set(key, { ...progress, state: "failed", finishedAt: Date.now() });
  });
  return { state: "started" };
}

/** 产品自带 Codex 的真实登录探针；只认命令退出码，不读取或返回 auth.json 内容。 */
export async function probeCodex(
  bin: string | null, codexHome: string, env: NodeJS.ProcessEnv = process.env,
): Promise<LocalAgentStatus> {
  if (!bin || !fs.existsSync(bin)) {
    return { provider: "cli-codex", name: "Codex", installed: false, authenticated: false, available: false,
      version: null, status: "not_installed", detail: "产品自带的 Codex 引擎不存在" };
  }
  const probeEnv = windowsRuntimeEnv(env);
  let version: string | null = null;
  try {
    const versionCall = executableInvocation(bin, ["--version"], probeEnv);
    const v = await execFileAsync(versionCall.file, versionCall.args, { env: probeEnv, timeout: 5_000, maxBuffer: 64 * 1024 });
    version = oneLine(v.stdout);
  } catch {
    return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
      version: null, status: "probe_failed", detail: "Codex 已安装，但版本检测失败" };
  }
  try {
    const statusEnv = { ...probeEnv, CODEX_HOME: codexHome };
    const statusCall = executableInvocation(bin, ["login", "status"], statusEnv);
    await execFileAsync(statusCall.file, statusCall.args, {
      env: statusEnv, timeout: 5_000, maxBuffer: 64 * 1024,
    });
    return { provider: "cli-codex", name: "Codex", installed: true, authenticated: true, available: true,
      version, status: "ready", detail: "产品自带引擎已登录，可使用 ChatGPT 订阅" };
  } catch {
    const login = codexLoginProgress(codexHome);
    if (login?.state === "pending") {
      return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
        version, status: "login_pending", detail: "正在等待浏览器完成 Codex 登录" };
    }
    if (login?.state === "failed") {
      return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
        version, status: "login_failed", detail: "Codex 登录未完成，请重新登录" };
    }
    return { provider: "cli-codex", name: "Codex", installed: true, authenticated: false, available: false,
      version, status: "not_authenticated", detail: "产品自带引擎尚未登录" };
  }
}

export class LocalAgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalAgentError";
    this.code = code;
  }
}

const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/usr/local/lib/node_modules/.bin",
  path.join(os.homedir(), ".local/bin"),
  path.join(os.homedir(), ".npm-global/bin"),
  path.join(os.homedir(), ".bun/bin"),
  path.join(os.homedir(), "Library/pnpm"),
  path.join(os.homedir(), ".local/share/pnpm"),
];

function executableDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return [...(platform === "win32" ? [] : EXTRA_PATH_DIRS),
    env.APPDATA ? path.join(env.APPDATA, "npm") : "",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : "",
    env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "npm") : "",
  ].filter(Boolean);
}

/** GUI 启动时 PATH 往往比终端短；按 OD 的做法补常见全局安装目录。 */
export function findExecutable(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const override = bin === "claude" ? String(env.CLAUDE_BIN ?? "").trim() : "";
  const extensions = platform === "win32"
    ? [...new Set([".exe", ".ps1", ".cmd", ".bat", "", ...String(env.PATHEXT ?? "").split(";").map((x) => x.toLowerCase()).filter(Boolean)])]
    : [""];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const candidates = override ? [override] : [...new Set(String(env.PATH ?? "").split(delimiter).concat(executableDirs(env, platform)).filter(Boolean))]
    .flatMap((dir) => extensions.map((ext) => path.join(dir, `${bin}${ext}`)));
  for (const candidate of candidates) {
    try {
      // npm 在 Windows 通常同时生成 claude.cmd 与 claude.ps1。优先返回可由
      // powershell.exe -File 安全传参的 ps1；不要把含提示词的 argv 拼进 cmd.exe 命令串。
      const ext = path.extname(candidate).toLowerCase();
      const ps1 = platform === "win32" && [".cmd", ".bat"].includes(ext) ? candidate.slice(0, -ext.length) + ".ps1" : candidate;
      fs.accessSync(ps1, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(ps1).isFile()) return ps1;
    } catch {
      // 继续找下一处；设置页会把“未安装”说清楚。
    }
  }
  return null;
}

export function executableInvocation(
  bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform !== "win32") return { file: bin, args };
  const ext = path.extname(bin).toLowerCase();
  if (ext !== ".ps1") {
    if ([".cmd", ".bat"].includes(ext)) throw new LocalAgentError("agent_start_failed", "Windows CLI 缺少安全的 PowerShell 启动器");
    return { file: bin, args };
  }
  // 测试与受控调用经常传最小环境；Windows 创建 PowerShell 进程仍需要系统目录。
  // 这里允许从宿主补 SystemRoot，但不会补 PATH 或任何认证变量。
  const windowsRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR
    ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  const powershell = windowsRoot
    ? path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return { file: powershell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bin, ...args] };
}

function oneLine(value: unknown): string | null {
  const line = String(value ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  return line ? line.slice(0, 80) : null;
}

function parseAuthStatus(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
    // 这一张卡片承诺的是 claude.ai 订阅，不是“Claude CLI 随便能调通”。
    // Bedrock / Vertex / API key 即使可用，也不能在这里冒充订阅额度。
    return parsed.loggedIn === true && parsed.authMethod === "claude.ai" && parsed.apiProvider === "firstParty";
  } catch {
    return false;
  }
}

const REQUIRED_CLAUDE_FLAGS = [
  "--safe-mode", "--tools", "--strict-mcp-config", "--no-session-persistence",
  "--output-format", "--system-prompt", "--json-schema",
] as const;

/** 只返回版本与“是否已登录”，绝不把账号、组织或 CLI 原始输出送到浏览器。 */
export async function probeClaude(env: NodeJS.ProcessEnv = process.env): Promise<LocalAgentStatus> {
  const bin = findExecutable("claude", env);
  if (!bin) {
    return {
      provider: "cli-claude", name: "Claude Code", installed: false, authenticated: false,
      available: false, version: null, status: "not_installed", detail: "本机未检测到 Claude Code",
    };
  }
  const runEnv = subscriptionEnv(env);
  let version: string | null = null;
  try {
    const versionCall = executableInvocation(bin, ["--version"], runEnv);
    const v = await execFileAsync(versionCall.file, versionCall.args, { env: runEnv, timeout: 5_000, maxBuffer: 64 * 1024 });
    version = oneLine(v.stdout);
    const helpCall = executableInvocation(bin, ["--help"], runEnv);
    const h = await execFileAsync(helpCall.file, helpCall.args, { env: runEnv, timeout: 5_000, maxBuffer: 128 * 1024 });
    const help = String(h.stdout);
    if (!REQUIRED_CLAUDE_FLAGS.every((flag) => help.includes(flag))) {
      return {
        provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
        available: false, version, status: "probe_failed", detail: "Claude Code 版本过旧，缺少受限对话所需的安全参数",
      };
    }
  } catch {
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
      available: false, version: null, status: "probe_failed", detail: "Claude Code 已安装，但版本检测失败",
    };
  }
  try {
    const authCall = executableInvocation(bin, ["auth", "status"], runEnv);
    const a = await execFileAsync(authCall.file, authCall.args, { env: runEnv, timeout: 5_000, maxBuffer: 64 * 1024 });
    const authenticated = parseAuthStatus(String(a.stdout));
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated,
      available: authenticated, version, status: authenticated ? "ready" : "not_authenticated",
      detail: authenticated ? "已安装并登录，可使用本机 Claude 订阅" : "已安装；请先运行 claude 并完成 /login",
    };
  } catch {
    return {
      provider: "cli-claude", name: "Claude Code", installed: true, authenticated: false,
      available: false, version, status: "not_authenticated", detail: "已安装；请先运行 claude 并完成 /login",
    };
  }
}

export interface RunLocalAgentOptions {
  systemPrompt: string;
  userPrompt: string;
  outputSchema?: unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** 可单测的参数生成器。`--safe-mode` 与 `--tools ""` 两道都在，避免用户配置把工具重新打开。 */
export function claudeArgs(systemPrompt: string, outputSchema?: unknown): string[] {
  const args = [
    "-p",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", systemPrompt,
  ];
  if (outputSchema !== undefined) args.push("--json-schema", JSON.stringify(outputSchema));
  return args;
}

function subscriptionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = windowsRuntimeEnv(base);
  // 用户明确选择“Claude 订阅”时，让 Claude Code 自己的 claude.ai 登录态胜出。
  // 否则外壳进程里遗留的 API key / 第三方网关可能静默改掉计费方。
  // `CLAUDE_CODE_OAUTH_TOKEN` 是 `claude setup-token` 生成的官方订阅认证，必须保留；
  // 探针若靠它判 ready、执行时却删掉，会造成“界面可用、实际未登录”的假绿。
  for (const key of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ]) delete env[key];
  return env;
}

/** Claude `--output-format json` 的脱敏解析；结构化任务优先取 structured_output。 */
export function parseClaudeOutput(stdout: string): string {
  let parsed: { result?: unknown; structured_output?: unknown; is_error?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new LocalAgentError("agent_bad_output", "Claude Code 返回了无法解析的结果");
  }
  if (parsed.is_error === true) throw new LocalAgentError("agent_failed", "Claude Code 本轮执行失败");
  if (parsed.structured_output !== undefined) return JSON.stringify(parsed.structured_output);
  if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result;
  throw new LocalAgentError("agent_empty_output", "Claude Code 没有返回可见回答");
}

function failureMessage(stderr: string, code: number | null): LocalAgentError {
  const text = stderr.slice(0, 16_000);
  if (/not logged in|login required|authentication|oauth|unauthori[sz]ed|\b401\b/i.test(text)) {
    return new LocalAgentError("agent_not_authenticated", "Claude Code 登录已失效，请先运行 claude 并完成 /login");
  }
  if (/rate.?limit|quota|usage limit|too many requests|\b429\b/i.test(text)) {
    return new LocalAgentError("agent_quota", "Claude Code 当前额度或频率受限，请稍后再试");
  }
  return new LocalAgentError("agent_failed", `Claude Code 调用失败（退出码 ${code ?? "未知"}）`);
}

/**
 * 运行一次无工具 Claude Code 请求。提示词走 stdin，避免把用户正文放进 argv / 进程列表。
 * stdout / stderr 都有限额；超时或取消后先 TERM，再 KILL，避免 CLI 留在后台继续消耗额度。
 */
export async function runLocalAgent(agent: LocalAgentId, opts: RunLocalAgentOptions): Promise<string> {
  if (agent !== "claude") throw new LocalAgentError("unsupported_cli", `尚未安全接通本机 Agent:${agent}`);
  if (opts.signal?.aborted) throw new LocalAgentError("agent_cancelled", "Claude Code 请求已取消");
  if (activeLocalAgents >= MAX_ACTIVE_LOCAL_AGENTS) {
    throw new LocalAgentError("agent_busy", `本机 Agent 已有 ${MAX_ACTIVE_LOCAL_AGENTS} 个任务在运行，请稍后再试`);
  }
  const baseEnv = opts.env ?? process.env;
  const bin = findExecutable("claude", baseEnv);
  if (!bin) throw new LocalAgentError("agent_not_installed", "本机未安装 Claude Code");

  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? 180_000, 600_000));
  const maxOut = 4 * 1024 * 1024;
  const maxErr = 64 * 1024;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-claude-"));
  activeLocalAgents += 1;

  return await new Promise<string>((resolve, reject) => {
    const runEnv = subscriptionEnv(baseEnv);
    const launch = executableInvocation(bin, claudeArgs(opts.systemPrompt, opts.outputSchema), runEnv);
    const child = spawn(launch.file, launch.args, {
      cwd: tmpDir,
      env: runEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX 下创建独立进程组。Claude CLI 可能继续派生 node / shell 子进程；
      // 只杀直接 child 会让后代留在后台继续消耗订阅额度。
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let settled = false;
    let terminationError: LocalAgentError | null = null;
    let hardKillTimer: NodeJS.Timeout | null = null;
    let killFallbackTimer: NodeJS.Timeout | null = null;

    const cleanup = (done: () => void) => {
      opts.signal?.removeEventListener("abort", onAbort);
      // Windows 偶尔在 child 的 close 事件后短暂保留 cwd 句柄。异步 rm 自带重试，
      // 避免 EPERM 覆盖真实的 Agent 结果，同时仍在返回调用方前完成清理尝试。
      fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }, () => done());
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      activeLocalAgents = Math.max(0, activeLocalAgents - 1);
      cleanup(fn);
    };
    const signalTree = (signal: NodeJS.Signals) => {
      signalProcessTree(child, signal);
    };
    const processTreeAlive = (): boolean => {
      if (process.platform === "win32") return child.exitCode === null;
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const terminate = (error: LocalAgentError) => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      try { child.stdin.destroy(); } catch { /* 已关闭 */ }
      signalTree("SIGTERM");
      // Promise 不能在 TERM 发出后立刻返回：那会清掉临时目录与监听器，
      // 却无法证明整个进程组已经退出。两秒后杀整组，再等 close。
      hardKillTimer = setTimeout(() => {
        signalTree("SIGKILL");
        killFallbackTimer = setTimeout(() => {
          finish(() => reject(terminationError!));
        }, 2_000);
        killFallbackTimer.unref();
      }, 2_000);
      hardKillTimer.unref();
    };
    const onAbort = () => {
      terminate(new LocalAgentError("agent_cancelled", "Claude Code 请求已取消"));
    };
    const timer = setTimeout(() => {
      terminate(new LocalAgentError("agent_timeout", `Claude Code 超时（>${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) return onAbort();
    child.stdin.on("error", () => { /* 提前退出时的 EPIPE 由 close 统一处理 */ });
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        terminate(new LocalAgentError("agent_output_too_large", "Claude Code 输出超出上限，已终止"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < maxErr) stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (terminationError) return finish(() => reject(terminationError!));
      finish(() => reject(new LocalAgentError("agent_start_failed", "Claude Code 启动失败")));
    });
    child.on("close", (code) => {
      if (terminationError) {
        // 直接 child 退出不代表它派生的进程也退出；组还活着就保留 KILL timer。
        if (processTreeAlive()) return;
        return finish(() => reject(terminationError!));
      }
      if (code !== 0) return finish(() => reject(failureMessage(stderr, code)));
      finish(() => {
        try { resolve(parseClaudeOutput(stdout)); } catch (e) { reject(e); }
      });
    });
    child.stdin.end(opts.userPrompt, "utf8");
  });
}
