/**
 * skills 隔离(执行层,零 fork)。
 *
 * 问题:Codex 发现 skill 的根不止产品的 `.agents/skills`——还有**用户主目录** `~/.agents/skills`(按 $HOME 定位,**不受 CODEX_HOME 控制**;
 * 源码 codex-rs/ext/skills/src/host_roots.rs `home_dir.join(".agents").join("skills")`)、已弃用的用户级根 `$CODEX_HOME/skills`,
 * 以及 Codex 每次启动自动装进 `$CODEX_HOME/skills/.system` 的捆绑系统 skills(imagegen / plugin-creator …,无法不装)。
 * 用户机器上的个人 skill 会:① 挤爆 skills 目录的上下文预算(默认 8,000 字符或上下文窗口 2%)→ 产品 skill 描述被截断
 * (事件流里出现 "Skill descriptions were shortened to fit the skills context budget");② 污染提示层——2026-08-22 本机实测
 * 92 个个人 skill / 描述 18,892 字,agent 真的去读 `~/.agents/skills/<x>/SKILL.md`,靠 PreToolUse 钩子才拦下。
 *
 * 解法全部走 Codex 自己的配置(codex-rs/config/src/skills_config.rs),写在**产品 CODEX_HOME/config.toml** 的标记块内:
 *   [skills] max_context_tokens = 10000        ← 目录预算抬到上限(Codex 封顶 10,000 token)
 *   [skills.bundled] enabled = false           ← 捆绑系统 skills 不进 catalog
 *   [[skills.config]] path = "<SKILL.md>" enabled = false ← 用户级 skill 逐条禁用;**用 path 不用 name**,同名时 name 会把产品 skill 一起禁掉
 * 被禁用的 skill 不进提示词也不占预算(ext/skills/src/catalog.rs `enabled && prompt_visible`)。与 hooks 块同一套幂等合并机制,不动块外内容。
 *
 * 枚举规则复刻 Codex 对用户根的发现(ext/skills/src/loader/{host.rs,discovery.rs,discovery_tests.rs} + exec-server/src/local_file_system.rs,2026-08-22 四轮核对):
 *   非插件根一律 Recursive,**按目录名排序的 BFS**,最深 MAX_SCAN_DEPTH = 6 **层目录**(`d0/d1/d2/d3/d4/d5/SKILL.md` 可见,再深一层不可见);
 *   文件名恰为 `SKILL.md`(区分大小写);根以下任一祖先目录以 `.` 开头则跳过;User 作用域**跟随目录符号链接**(整根按 canonical 目录全局去重,
 *   同一真实目录只遍历先碰到的那条——我们把指向同一目录的兄弟链接两条都写进禁用清单,安全超集,多余 selector 无害),**忽略 SKILL.md 文件本身是符号链接**;
 *   **2,000 个唯一目录 / 20,000 个条目处截断并继续**(Codex 同样截断、只是少看到 skill;截断后置 truncated,编排器出声,不中断运行);
 *   主目录取 dirs::home_dir()(HOME 非空用之,否则 passwd)且必须是绝对路径,否则该根不存在。
 * Codex 对我们写的 path selector 会 canonicalize 后再比较(skills_config.rs),所以**realpath 命中产品 skill 集合(按同样规则枚举 <repo>/.agents/skills)的一律不写**——
 * 否则用户目录里一条指向产品 skill 的目录链接会把产品 skill 禁掉。
 * 写入前用 Python `tomllib`(3.11+ 标准库,产品本就带 venv)解析合并后的整份 config.toml,解析不过就不写(不会把能用的配置改坏)。
 * 每次运行开始时重算(用户的 skill 集合会变);只能禁"此刻能枚举到的",运行中新装的要下次运行才隔离。
 * 边界:产品 CODEX_HOME 不装插件,插件自带的 skill 不在本块范围;这是提示层的净化,最终兜底仍是 PreToolUse 钩子 + validator 的越界读取检查。
 * 事件 / manifest 只记数量与清单哈希,不记用户路径(service 层会把事件经 API / MCP 回给调用方);异常信息里的路径用 ~ 相对主目录。
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RunConfig } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";
import { mergeBlock } from "./hooks.ts";
import { scanTomlLine, splitKeyValue, unquoteTomlKey } from "./tomlscan.ts";

export const SKILLS_BLOCK_BEGIN = "# >>> vibe-research skills isolation (generated; do not edit) >>>";
export const SKILLS_BLOCK_END = "# <<< vibe-research skills isolation <<<";
/** Codex 对 skills.max_context_tokens 的封顶值(render.rs MAX_CONFIGURED_SKILL_METADATA_TOKEN_BUDGET) */
export const SKILLS_MAX_CONTEXT_TOKENS = 10_000;
/** Codex 用户根递归发现的最大**目录**深度(loader/mod.rs MAX_SCAN_DEPTH;discovery_tests.rs:d0/…/d5 可见、d6 不可见) */
export const SKILLS_MAX_SCAN_DEPTH = 6;
/** Codex 每根 walk 的截断边界(loader/mod.rs MAX_SKILLS_DIRS_PER_ROOT / MAX_SKILLS_ENTRIES_PER_ROOT):超过即 truncated、继续运行 */
export const SKILLS_MAX_DIRS_PER_ROOT = 2_000;
export const SKILLS_MAX_ENTRIES_PER_ROOT = 20_000;
const SKILL_FILENAME = "SKILL.md";

/**
 * 与 Codex `dirs::home_dir()` + 绝对路径检查同语义的主目录解析:
 *   HOME 非空 → 绝对路径用之;相对路径 → Codex 会丢弃该根,返回 null(不枚举,也不生成相对 selector);
 *   HOME 未设 / 空 → passwd 主目录(Node `os.userInfo().homedir`)。
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const h = env.HOME;
  if (typeof h === "string" && h.length > 0) return path.isAbsolute(h) ? h : null;
  let pw: string | undefined;
  try { pw = os.userInfo().homedir; } catch { pw = undefined; }
  return pw && path.isAbsolute(pw) ? pw : null;
}

/** 异常 / 日志里的路径:主目录下的写成 ~/…(不把用户目录绝对路径带进 manifest / 事件) */
export function tildePath(p: string, home: string | null = resolveHomeDir()): string {
  if (!home) return p;
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : p;
}

export interface ForeignSkillRoots {
  codexHome: string;
  /** undefined = 按 resolveHomeDir(process.env);null = 没有用户主目录根(不枚举) */
  homeDir?: string | null;
  /**
   * 产品仓库根:其 `.agents/skills` 下按 Codex Repo 规则发现到的 SKILL.md(canonical)不写入禁用清单——
   * Codex 会 canonicalize selector,用户目录里一条指向产品 skill 的链接否则会把产品 skill 禁掉。
   * 只排除"产品 skill 集合成员",不按仓库前缀排除(仓库里非 skill 目录被用户链接指向时,Codex 照样当用户 skill,我们也照样禁)。
   */
  productRoots?: string[];
}

/** 用户级 skill 根:`~/.agents/skills` + 已弃用的 `$CODEX_HOME/skills`(其下 `.system` 是隐藏目录,Codex 发现时剪掉,捆绑 skills 由 [skills.bundled] 开关处理) */
export function foreignSkillRoots(opts: ForeignSkillRoots): string[] {
  const home = opts.homeDir === undefined ? resolveHomeDir() : opts.homeDir;
  const roots = home ? [path.join(home, ".agents", "skills")] : [];
  roots.push(path.join(opts.codexHome, "skills"));
  return roots;
}

const isMissing = (e: unknown) => { const c = (e as NodeJS.ErrnoException)?.code; return c === "ENOENT" || c === "ENOTDIR"; };
const realOrNull = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };

interface WalkResult { found: string[]; excluded: number; truncated: boolean }

/**
 * 枚举一个根(复刻 Codex Recursive 发现:按目录名排序的 BFS)。根不存在 → 空;权限 / I/O 错误抛出(不静默少禁)。
 * - 目录深度:根 = 0,最多进入深度 6 的目录(d0/…/d5),其中的 SKILL.md 可见;深度 7 的目录不进。
 * - 目录符号链接跟随;同一 canonical 目录只进一次(Codex visited_directories;兄弟链接先碰到的那条胜出),但其 SKILL.md 路径按**看到的路径**记——
 *   指向同一目录的兄弟链接各自的 `<link>/SKILL.md` 都会写进清单(安全超集)。
 * - SKILL.md 本身是符号链接 → 跳过(Codex discovery_tests.rs ignores_symlinked_skill_files)。
 * - realpath 命中 excludeCanon(产品 skill 集合)→ 不记;记入 excluded 供日志计数。
 * - 2,000 唯一目录 / 20,000 条目处截断(truncated = true),不抛错:Codex 在同样的边界截断并继续,我们也不能因为用户 skill 目录里有个 node_modules 就拒绝运行。
 */
function walkRoot(root: string, excludeCanon: Set<string>, home: string | null): WalkResult {
  const found: string[] = [];
  let excluded = 0, truncated = false, entryCount = 0;
  const fail = (p: string, e: unknown) => new Error(`枚举用户级 skill 失败:${tildePath(p, home)}:${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)}`);
  const rootReal = realOrNull(root);
  if (!rootReal) { try { fs.statSync(root); } catch (e) { if (isMissing(e)) return { found, excluded, truncated }; throw fail(root, e); } return { found, excluded, truncated }; }
  const visited = new Set<string>([rootReal]);
  let dirCount = 0;
  const queue: [string, number][] = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift() as [string, number];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (isMissing(e)) continue; throw fail(dir, e); }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (entryCount >= SKILLS_MAX_ENTRIES_PER_ROOT) { truncated = true; break; }
      entryCount++;
      const p = path.join(dir, ent.name);
      let isDir = ent.isDirectory(), isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = false; }  // 文件符号链接(含 SKILL.md 链接)一律忽略,与 Codex 一致
        catch (e) { if (isMissing(e)) continue; throw fail(p, e); }  // 悬空链接 = Codex 也读不到,跳过
      }
      if (isDir) {
        if (ent.name.startsWith(".")) continue;          // 隐藏目录及其子树整体剪掉(has_hidden_ancestor_below_root)
        if (depth + 1 > SKILLS_MAX_SCAN_DEPTH) continue;
        let real: string;
        try { real = fs.realpathSync(p); } catch (e) { if (isMissing(e)) continue; throw fail(p, e); }
        if (visited.has(real)) {
          // 环路 / 兄弟链接指向同一目录:不再下钻(与 Codex visited_directories 一致),但该路径下直接的 SKILL.md 仍记一条——
          // 安全超集:Codex 只会列先碰到的那条,排序若与我们有出入(非 ASCII 文件名)也不会漏禁;多余 selector 无害
          const sk = path.join(p, SKILL_FILENAME);
          let st: fs.Stats | null = null;
          try { st = fs.lstatSync(sk); } catch (e) { if (!isMissing(e)) throw fail(sk, e); }
          if (st?.isFile()) { const rp = realOrNull(sk); if (rp && excludeCanon.has(rp)) excluded++; else found.push(sk); }
          continue;
        }
        visited.add(real);
        if (dirCount >= SKILLS_MAX_DIRS_PER_ROOT) { truncated = true; continue; }
        dirCount++;
        queue.push([p, depth + 1]);
      } else if (isFile && ent.name === SKILL_FILENAME) {
        const rp = realOrNull(p);
        if (rp && excludeCanon.has(rp)) { excluded++; continue; }
        found.push(p);
      }
    }
    if (truncated && entryCount >= SKILLS_MAX_ENTRIES_PER_ROOT) break;
  }
  return { found, excluded, truncated };
}

export interface ForeignSkillScan { paths: string[]; /** 因 realpath 命中产品 skill 集合而未写入的条数 */ excludedInRepo: number; /** 任一根触及 Codex 截断边界(2,000 目录 / 20,000 条目) */ truncated: boolean }

/** 产品 skill 集合(canonical SKILL.md 路径):按 Codex Repo 规则(同样 Recursive / 跟随目录链接)枚举 <repo>/.agents/skills */
export function productSkillCanonicalSet(productRoots: string[], home: string | null = resolveHomeDir()): Set<string> {
  const set = new Set<string>();
  for (const r of productRoots) for (const p of walkRoot(path.join(r, ".agents", "skills"), new Set(), home).found) { const rp = realOrNull(p); if (rp) set.add(rp); }
  return set;
}

export function scanForeignSkills(opts: ForeignSkillRoots): ForeignSkillScan {
  const home = opts.homeDir === undefined ? resolveHomeDir() : opts.homeDir;
  const excludeCanon = productSkillCanonicalSet(opts.productRoots ?? [], home);
  const out: string[] = [];
  let excluded = 0, truncated = false;
  for (const root of foreignSkillRoots(opts)) { const r = walkRoot(root, excludeCanon, home); out.push(...r.found); excluded += r.excluded; truncated ||= r.truncated; }
  return { paths: [...new Set(out)].sort(), excludedInRepo: excluded, truncated };
}
export function listForeignSkillPaths(opts: ForeignSkillRoots): string[] { return scanForeignSkills(opts).paths; }

/** TOML 基本字符串:JSON 的转义规则是 TOML 基本字符串的子集(\" \\ \uXXXX,非 ASCII 原样) */
const tomlString = (s: string) => JSON.stringify(s);

/** 生成标记块(纯函数,便于测试) */
export function buildSkillsIsolationBlock(disabledPaths: string[], maxContextTokens: number = SKILLS_MAX_CONTEXT_TOKENS): string {
  if (!Number.isInteger(maxContextTokens) || maxContextTokens < 1 || maxContextTokens > SKILLS_MAX_CONTEXT_TOKENS) {
    throw new Error(`skills.max_context_tokens 必须是 1..${SKILLS_MAX_CONTEXT_TOKENS} 的整数(Codex 封顶),得到 ${maxContextTokens}`);
  }
  const lines = [SKILLS_BLOCK_BEGIN, "[skills]", `max_context_tokens = ${maxContextTokens}`, "", "[skills.bundled]", "enabled = false", ""];
  for (const p of [...new Set(disabledPaths)].sort()) {
    if (!path.isAbsolute(p)) throw new Error(`skills.config path 必须是绝对路径:${p}`);
    lines.push("[[skills.config]]", `path = ${tomlString(p)}`, "enabled = false", "");
  }
  lines.push(SKILLS_BLOCK_END);
  return lines.join("\n");
}

/** 一行的首个键段(表头 `[a.b]` / `[[a.b]]` 或键 `a.b = …`)是否解码后等于 skills */
function firstKeyIsSkills(line: string, header: boolean): boolean {
  let body = line;
  if (header) { body = body.replace(/^\[\[?/, "").replace(/\]\]?.*$/, ""); }
  else { const eq = body.indexOf("="); if (eq < 0) return false; body = body.slice(0, eq); }
  body = body.trim();
  const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(body);
  return !!m && unquoteTomlKey(m[1]) === "skills";
}

/**
 * 块外若已有 skills 配置(表头 `[skills]` / `[skills.x]` / `[[skills.config]]`、引号或转义表头 `["skills"]` `["skill\u0073"]`、
 * 顶层点号键 `skills.max_context_tokens = …`、顶层内联表 `skills = {…}`),再写一份会让 TOML 重复定义 → Codex 启动即配置错误;
 * 这里正向识别并拒绝(返回命中的行)。非顶层(某个表头之后)的 `skills = …` 是别的表的键,不算冲突;多行字符串内的文本不算。
 * 最后一道保险是写入前用 tomllib 解析整份文档(installSkillsIsolation),这里漏判也不会把配置写坏。
 */
export function findForeignSkillsConfig(existing: string): string[] {
  const b = existing.indexOf(SKILLS_BLOCK_BEGIN), e = existing.indexOf(SKILLS_BLOCK_END);
  const outside = b >= 0 && e > b ? existing.slice(0, b) + existing.slice(e + SKILLS_BLOCK_END.length) : existing;
  const hits: string[] = [];
  let inTable = false;
  let multiline: '"""' | "'''" | null = null;
  for (const raw of outside.split("\n")) {
    if (multiline) { if (raw.includes(multiline)) multiline = null; continue; }
    const sc = scanTomlLine(raw);
    const line = sc.text.trim();
    if (sc.opensMultiline) multiline = sc.opensMultiline;
    if (!line) continue;
    if (line.startsWith("[")) { inTable = true; if (firstKeyIsSkills(line, true)) hits.push(line); continue; }
    if (!inTable && firstKeyIsSkills(line, false)) hits.push(line);
  }
  return hits;
}

/** 用 Python 标准库 tomllib(3.11+)解析整份 TOML 文本;返回 null = 解析通过,字符串 = 错误;python 不可用或没有 tomllib → undefined(无法校验) */
export function validateTomlText(python: string, text: string): string | null | undefined {
  // 只认两种明确结果:TOML_OK / TOML_INVALID:<原因>;解释器不存在、不是 Python、没有 tomllib、被桩替换……一律"无法校验"(undefined),不把环境问题当成配置错误
  const r = spawnSync(python, ["-c", "import sys\ntry:\n    import tomllib\nexcept Exception:\n    sys.exit(42)\ntry:\n    tomllib.loads(sys.stdin.read())\nexcept Exception as e:\n    sys.stdout.write('TOML_INVALID:' + str(e)); sys.exit(0)\nsys.stdout.write('TOML_OK'); sys.exit(0)"], { input: text, encoding: "utf8", timeout: 20_000 });
  if (r.error || r.status !== 0) return undefined;
  const out = (r.stdout || "").trim();
  if (out === "TOML_OK") return null;
  if (out.startsWith("TOML_INVALID:")) return out.slice("TOML_INVALID:".length).trim().slice(0, 300) || "TOML 解析失败";
  return undefined;
}

export interface InstalledSkillsIsolation {
  configTomlPath: string;
  disabledPaths: string[];
  /** 清单摘要(sha256 of 排序后的路径清单):日志 / 事件只记它,不记路径 */
  disabledSha256: string;
  /** realpath 命中产品 skill 集合、刻意未写入的条数(用户目录里指向产品 skill 的链接) */
  excludedInRepo: number;
  /** 枚举触及 Codex 截断边界(2,000 目录 / 20,000 条目):清单可能不完整,编排器应出声 */
  truncated: boolean;
  bundledDisabled: true;
  maxContextTokens: number;
  /** 本次是否改写了 config.toml(幂等:内容相同不写) */
  changed: boolean;
  /** 合并后的整份 config.toml 是否经 tomllib 解析通过(null = 未提供 python 或无 tomllib,未校验) */
  tomlValidated: boolean | null;
}

export const sha256List = (paths: string[]) => crypto.createHash("sha256").update([...paths].sort().join("\n")).digest("hex");

/**
 * 在产品 CODEX_HOME/config.toml 写入 / 更新隔离块(幂等;不动块外内容;块外已有 skills 配置则报错)。
 * repoRoot 给出时其产品 skill 不会被写进禁用清单;python 给出时合并后的整份文档先经 tomllib 解析,不过就不写(不把能用的配置改坏)。
 */
export function installSkillsIsolation(cfg: Pick<RunConfig, "codexHome"> & { repoRoot?: string; python?: string | null }, opts: { homeDir?: string | null; maxContextTokens?: number } = {}): InstalledSkillsIsolation {
  const scan = scanForeignSkills({ codexHome: cfg.codexHome, homeDir: opts.homeDir, productRoots: cfg.repoRoot ? [cfg.repoRoot] : [] });
  const maxContextTokens = opts.maxContextTokens ?? SKILLS_MAX_CONTEXT_TOKENS;
  const block = buildSkillsIsolationBlock(scan.paths, maxContextTokens);
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  const configTomlPath = path.join(cfg.codexHome, "config.toml");
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, "utf8") : "";
  const clash = findForeignSkillsConfig(existing);
  if (clash.length) throw new Error(`${configTomlPath} 标记块之外已有 skills 配置(${clash.join(" / ")}),与隔离块冲突;请先删除或并入块内(块由编排器生成)`);
  const next = mergeBlock(existing, block, SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END);
  const changed = next !== existing;
  let tomlValidated: boolean | null = null;
  if (changed && cfg.python) {
    const err = validateTomlText(cfg.python, next);
    if (err !== undefined) {
      tomlValidated = err === null;
      if (err !== null) throw new Error(`${configTomlPath} 合并隔离块后不是合法 TOML(未写入,原文件未动):${err}。多半是块外已有 skills 配置或原文件本身有语法错误`);
    }
  }
  if (changed) atomicWrite(configTomlPath, next);
  return { configTomlPath, disabledPaths: scan.paths, disabledSha256: sha256List(scan.paths), excludedInRepo: scan.excludedInRepo, truncated: scan.truncated, bundledDisabled: true, maxContextTokens, changed, tomlValidated };
}

/** 移除隔离块(测试 / 手动回退用;运行时不调用——隔离是常开的) */
export function uninstallSkillsIsolation(cfg: Pick<RunConfig, "codexHome">): void {
  const cp = path.join(cfg.codexHome, "config.toml");
  if (!fs.existsSync(cp)) return;
  const txt = fs.readFileSync(cp, "utf8");
  const b = txt.indexOf(SKILLS_BLOCK_BEGIN), e = txt.indexOf(SKILLS_BLOCK_END);
  if (b >= 0 && e > b) atomicWrite(cp, (txt.slice(0, b) + txt.slice(e + SKILLS_BLOCK_END.length)).replace(/\s+$/, "") + "\n");
}

export interface SkillsIsolationStatus {
  hasBlock: boolean;
  bundledDisabled: boolean;
  /** 块内预算;null = 未设或非法 */
  maxContextTokens: number | null;
  /** 块内"恰好只有 path 选择器 + enabled = false"的条目(Codex skills_config.rs:同时含 path 与 name 的整条忽略) */
  disabled: string[];
  /** 当前能枚举到、但块内没有(或不是有效禁用条目)的用户级 skill */
  missing: string[];
  /** 块内偏离生成器格式的条目(enabled ≠ false、带 name(含引号 / 转义写法)、额外键、不是键值行、path 不是基本字符串)——生成器不会产生,出现即被手改 */
  malformed: string[];
  /** 以上全部满足 = 隔离对当前用户级 skill 集合完整生效 */
  covered: boolean;
}

/** 结构化读隔离块(doctor 用;只读):逐条 [[skills.config]] 必须是"仅 path(基本字符串、绝对)+ enabled = false"才算禁用;键按 TOML 规则解码(裸 / 引号 / 转义) */
export function skillsIsolationStatus(tomlText: string, foreignPaths: string[]): SkillsIsolationStatus {
  const b = tomlText.indexOf(SKILLS_BLOCK_BEGIN), e = tomlText.indexOf(SKILLS_BLOCK_END);
  if (!(b >= 0 && e > b)) return { hasBlock: false, bundledDisabled: false, maxContextTokens: null, disabled: [], missing: [...foreignPaths], malformed: [], covered: false };
  const lines = tomlText.slice(b, e).split("\n").map((l) => scanTomlLine(l).text.trim()).filter(Boolean);
  const disabled: string[] = [], malformed: string[] = [];
  let bundledDisabled = false, mct: number | null = null;
  let section: "skills" | "bundled" | "config" | null = null;
  let cur: { path?: string; pathOk?: boolean; name?: boolean; enabled?: boolean; extra?: boolean } | null = null;
  // 严格按生成器格式:一条 [[skills.config]] 必须恰好是 path(基本字符串、绝对)+ enabled = false,不得有 name / 其他键 / 非键值行。
  // 任何偏离(含只有 name 的后置 enabled = true 条目——Codex 按顺序应用,会把前面的 path 禁用撤销;含 "name" / "na\u006de" 引号写法)都计为 malformed → 不 covered。
  const flush = () => {
    if (!cur) return;
    const ok = cur.path !== undefined && cur.pathOk && cur.enabled === false && !cur.name && !cur.extra;
    if (ok) disabled.push(cur.path as string);
    else if (cur.path !== undefined || cur.name || cur.extra || cur.enabled !== undefined) malformed.push(cur.path ?? "<无 path 的条目>");
    cur = null;
  };
  for (const line of lines) {
    if (line === "[[skills.config]]") { flush(); section = "config"; cur = {}; continue; }
    if (line === "[skills.bundled]") { flush(); section = "bundled"; continue; }
    if (line === "[skills]") { flush(); section = "skills"; continue; }
    if (line.startsWith("[")) { flush(); section = null; continue; }
    const kv = splitKeyValue(line);
    if (!kv) { if (section === "config" && cur) cur.extra = true; continue; }  // 非键值行(续行 / 垃圾)也算偏离
    const { key: k, value: v } = kv;
    if (section === "skills" && k === "max_context_tokens") { const n = /^\d+$/.test(v) ? Number(v) : NaN; mct = Number.isInteger(n) && n >= 1 && n <= SKILLS_MAX_CONTEXT_TOKENS ? n : null; }
    else if (section === "bundled" && k === "enabled") bundledDisabled = v === "false";
    else if (section === "config" && cur) {
      if (k === "path") { try { const s = JSON.parse(v); cur.path = typeof s === "string" ? s : v; cur.pathOk = typeof s === "string" && path.isAbsolute(s); } catch { cur.path = v; cur.pathOk = false; } }
      else if (k === "name") cur.name = true;
      else if (k === "enabled") cur.enabled = v === "true" ? true : v === "false" ? false : undefined;
      else cur.extra = true;
    }
  }
  flush();
  const set = new Set(disabled);
  const missing = foreignPaths.filter((p) => !set.has(p));
  return { hasBlock: true, bundledDisabled, maxContextTokens: mct, disabled, missing, malformed, covered: bundledDisabled && mct !== null && missing.length === 0 && malformed.length === 0 };
}

/** POSIX 单引号转义(给 doctor 的修复命令用;Windows 未测) */
export const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** PowerShell 单引号转义；引号包住可执行文件时还需要调用运算符 &。 */
export const powershellQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 立即写入隔离块的命令行(绝对路径 + 单引号;与 init / 编排器同一实现) */
export function installCommandFor(repoRoot: string, codexHome: string, nodeBin: string = process.execPath): string {
  const script = path.join(repoRoot, "orchestrator", "src", "skills_isolation.ts");
  if (process.platform === "win32") return `& ${powershellQuote(nodeBin)} ${powershellQuote(script)} --codex-home ${powershellQuote(codexHome)}`;
  return `${posixQuote(nodeBin)} ${posixQuote(script)} --codex-home ${posixQuote(codexHome)}`;
}

/** 用法:node orchestrator/src/skills_isolation.ts --codex-home <产品 CODEX_HOME> [--repo-root <产品根>] [--python <解释器>] [--json](立即写入隔离块;scripts/init 与每次研究运行也会自动做) */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const codexHome = arg("--codex-home");
  if (!codexHome) { console.error("用法:node orchestrator/src/skills_isolation.ts --codex-home <dir> [--repo-root <dir>] [--python <bin>] [--json]"); process.exit(2); }
  const repoRoot = path.resolve(arg("--repo-root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const r = installSkillsIsolation({ codexHome: path.resolve(codexHome), repoRoot, python: arg("--python") ?? null });
  if (argv.includes("--json")) console.log(JSON.stringify({ ...r, disabledPaths: undefined, disabled_user_skills: r.disabledPaths.length }, null, 2));
  else console.log(`[skills-isolation] ${r.configTomlPath}:禁用用户级 skill ${r.disabledPaths.length} 个(清单 sha256 ${r.disabledSha256.slice(0, 12)}…${r.excludedInRepo ? `;另有 ${r.excludedInRepo} 条指向产品 skill 的链接未写入` : ""}${r.truncated ? ";⚠️ 枚举触及 Codex 截断边界,清单可能不完整" : ""});捆绑 skills 已关;max_context_tokens=${r.maxContextTokens};${r.changed ? "已写入" : "无变化"}${r.tomlValidated === true ? ";整份 TOML 经 tomllib 校验" : r.tomlValidated === false ? ";TOML 校验未通过" : ""}`);
}
