import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeConfig } from "../src/config.ts";
import { installHooks } from "../src/hooks.ts";
import { runInit } from "../src/init.ts";
import { loadProductConfig } from "../src/productConfig.ts";
import { directoryLink, tryFileLink } from "./platform.ts";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import {
  SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END, SKILLS_MAX_CONTEXT_TOKENS, SKILLS_MAX_SCAN_DEPTH,
  buildSkillsIsolationBlock, findForeignSkillsConfig, installCommandFor, installSkillsIsolation, listForeignSkillPaths, posixQuote,
  SKILLS_MAX_DIRS_PER_ROOT, resolveHomeDir, scanForeignSkills, sha256List, skillsIsolationStatus, tildePath, uninstallSkillsIsolation, validateTomlText,
} from "../src/skills_isolation.ts";

const mk = (p: string, body = "---\nname: x\ndescription: y\n---\n") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

/**
 * 假用户主目录 ~/.agents/skills(与 Codex discovery_tests.rs 同构):
 *   a-stock-data/SKILL.md(目录深度 1)· valuation/SKILL.md(与产品 skill 同名)· group/sub/SKILL.md(深度 2)
 *   d0/d1/d2/d3/d4/d5/SKILL.md(目录深度 6,Codex 可见)· d0/d1/d2/d3/d4/d5/d6/SKILL.md(深度 7,Codex 不可见)
 *   x/.hid/SKILL.md(隐藏祖先,剪掉)· .hidden/SKILL.md(隐藏,剪掉)· lower/skill.md(文件名不对)· no-skill-md/ · README.md
 *   alias -> a-stock-data(兄弟目录链接:Codex 全局 canonical 去重只遍历其一;我们两条都禁 = 安全超集)
 *   dangling -> 不存在(跳过)· prod -> <产品仓库>/.agents/skills/valuation(产品 skill 集合成员,不写入禁用清单)· repodoc -> <产品仓库>/docs/example-skill(仓库内但非产品 skill,照样禁)
 * 假 CODEX_HOME/skills:.system/imagegen/SKILL.md(捆绑,隐藏,剪掉)· legacy-user-skill/SKILL.md(弃用根下的用户 skill)
 */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vra-skiso-"));
  const home = path.join(base, "home"), codexHome = path.join(base, "codex-home"), ext = path.join(base, "external-skills"), repo = path.join(base, "repo");
  const root = path.join(home, ".agents", "skills");
  const a = path.join(root, "a-stock-data", "SKILL.md");
  const b = path.join(root, "valuation", "SKILL.md");
  const nested = path.join(root, "group", "sub", "SKILL.md");
  const deep6 = path.join(root, "d0", "d1", "d2", "d3", "d4", "d5", "SKILL.md");
  const deep7 = path.join(root, "d0", "d1", "d2", "d3", "d4", "d5", "d6", "SKILL.md");
  const linked = path.join(root, "link", "SKILL.md");
  const prodSkill = path.join(repo, ".agents", "skills", "valuation", "SKILL.md");
  const repoDoc = path.join(repo, "docs", "example-skill", "SKILL.md");  // 仓库内但不在 .agents/skills:Codex 不当产品 skill,用户链接指向它时照样禁
  for (const p of [a, b, nested, deep6, deep7, path.join(root, "x", ".hid", "SKILL.md"), path.join(root, ".hidden", "SKILL.md"), path.join(root, "lower", "skill.md"),
    path.join(ext, "SKILL.md"), path.join(ext, "file-target.md"), path.join(codexHome, "skills", ".system", "imagegen", "SKILL.md"), prodSkill, repoDoc]) mk(p);
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# c\n");
  fs.mkdirSync(path.join(root, "no-skill-md"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "x");
  directoryLink(ext, path.join(root, "link"));
  directoryLink(path.join(root, "a-stock-data"), path.join(root, "alias"));
  const alias = path.join(root, "alias", "SKILL.md");
  fs.mkdirSync(path.join(root, "filelink"));
  tryFileLink(path.join(ext, "file-target.md"), path.join(root, "filelink", "SKILL.md"));
  tryFileLink(path.join(base, "nope"), path.join(root, "dangling"));
  directoryLink(path.dirname(prodSkill), path.join(root, "prod"));
  directoryLink(path.dirname(repoDoc), path.join(root, "repodoc"));
  const repodocLink = path.join(root, "repodoc", "SKILL.md");
  const legacy = path.join(codexHome, "skills", "legacy-user-skill", "SKILL.md");
  mk(legacy);
  return { base, home, codexHome, repo, a, b, nested, deep6, deep7, linked, legacy, alias, prodSkill, repodocLink };
}

test("scanForeignSkills:复刻 Codex Recursive 发现——目录深度 ≤ 6、跳隐藏祖先、跟随目录链接、忽略文件链接、悬空跳过、只认 SKILL.md;只排除产品 skill 集合成员;根不存在 → 空", () => {
  const f = fixture();
  const all = listForeignSkillPaths({ codexHome: f.codexHome, homeDir: f.home });
  // 不传 productRoots:prod 链接下的 SKILL.md 也会被列出(它的 realpath 是产品 skill)
  assert.deepEqual(all, [f.a, f.b, f.nested, f.deep6, f.linked, f.legacy, f.alias, f.repodocLink, path.join(f.home, ".agents", "skills", "prod", "SKILL.md")].sort());
  assert.ok(!all.includes(f.deep7), "第 7 层目录不可见");
  assert.ok(!all.some((p) => p.includes("/filelink/")), "SKILL.md 文件符号链接必须忽略(Codex ignores_symlinked_skill_files)");
  const scan = scanForeignSkills({ codexHome: f.codexHome, homeDir: f.home, productRoots: [f.repo] });
  assert.deepEqual(scan.paths, [f.a, f.b, f.nested, f.deep6, f.linked, f.legacy, f.alias, f.repodocLink].sort(), "只排除产品 skill 集合成员,仓库里非 skill 目录照样禁");
  assert.equal(scan.excludedInRepo, 1);
  assert.deepEqual(listForeignSkillPaths({ codexHome: path.join(f.base, "nope"), homeDir: path.join(f.base, "nope2") }), []);
  assert.deepEqual(listForeignSkillPaths({ codexHome: path.join(f.base, "nope"), homeDir: null }), []);  // 无主目录根
  assert.equal(SKILLS_MAX_SCAN_DEPTH, 6);
});

test("scanForeignSkills:符号链接环路不死循环;不可读目录 → 抛错(不静默少禁),错误信息用 ~ 相对主目录", () => {
  const f = fixture();
  const root = path.join(f.home, ".agents", "skills");
  directoryLink(root, path.join(root, "loop"));  // 指回根
  const got = listForeignSkillPaths({ codexHome: f.codexHome, homeDir: f.home });
  assert.ok(got.includes(f.a) && !got.some((p) => p.includes("/loop/")));
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
    const locked = path.join(root, "locked");
    mk(path.join(locked, "SKILL.md"));
    fs.chmodSync(locked, 0o000);
    try { assert.throws(() => listForeignSkillPaths({ codexHome: f.codexHome, homeDir: f.home }), (e: Error) => /枚举用户级 skill 失败:~\/\.agents\/skills\/locked:EACCES/.test(e.message)); }
    finally { fs.chmodSync(locked, 0o755); }
  }
  assert.equal(tildePath("/h/u/.agents/skills/x", "/h/u"), "~/.agents/skills/x");
  assert.equal(tildePath("/other/x", "/h/u"), "/other/x");
});

test("resolveHomeDir:HOME 绝对 → 用之;HOME 相对 → null(Codex 丢弃该根);HOME 未设 / 空 → passwd 主目录", () => {
  assert.equal(resolveHomeDir({ HOME: "/Users/x" }), "/Users/x");
  assert.equal(resolveHomeDir({ HOME: "rel/dir" }), null);
  const pw = os.userInfo().homedir;
  assert.equal(resolveHomeDir({ HOME: "" }), pw);
  assert.equal(resolveHomeDir({}), pw);
});

test("buildSkillsIsolationBlock:预算封顶 / 捆绑关闭 / 逐条 path 禁用(JSON 转义 = TOML 基本字符串);非绝对路径与越界预算拒绝", () => {
  const blk = buildSkillsIsolationBlock(["/u/x/SKILL.md", "/u/含 中文 \"引号\"/SKILL.md", "/u/x/SKILL.md"]);
  assert.ok(blk.startsWith(SKILLS_BLOCK_BEGIN) && blk.endsWith(SKILLS_BLOCK_END));
  assert.ok(blk.includes(`[skills]\nmax_context_tokens = ${SKILLS_MAX_CONTEXT_TOKENS}\n`));
  assert.ok(blk.includes("[skills.bundled]\nenabled = false\n"));
  assert.equal((blk.match(/\[\[skills\.config\]\]/g) ?? []).length, 2);  // 去重
  assert.ok(blk.includes('path = "/u/含 中文 \\"引号\\"/SKILL.md"\nenabled = false'));
  assert.throws(() => buildSkillsIsolationBlock(["relative/SKILL.md"]), /绝对路径/);
  for (const bad of [0, 10001, 2.5]) assert.throws(() => buildSkillsIsolationBlock([], bad), /1\.\.10000/);
});

test("findForeignSkillsConfig:块外各种合法 TOML 写法都识别(含引号 / 转义键);块内 / 注释 / 别的表下的 skills 键不算", () => {
  const hit = (t: string) => findForeignSkillsConfig(t);
  assert.deepEqual(hit("[skills]\nmax_context_tokens = 1\n"), ["[skills]"]);
  assert.deepEqual(hit("[skills] # 注释\n"), ["[skills]"]);
  assert.deepEqual(hit('["skills"]\n'), ['["skills"]']);
  assert.deepEqual(hit("['skills']\n"), ["['skills']"]);
  assert.deepEqual(hit('["skill\\u0073"]\n'), ['["skill\\u0073"]']);  // \u 转义解码后仍是 skills
  assert.deepEqual(hit('"skill\\u0073".max_context_tokens = 1\n'), ['"skill\\u0073".max_context_tokens = 1']);
  assert.deepEqual(hit("[skills.bundled]\nenabled = true\n"), ["[skills.bundled]"]);
  assert.deepEqual(hit('[skills."bundled"]\n'), ['[skills."bundled"]']);
  assert.deepEqual(hit('[[skills.config]]\npath = "/x"\n'), ["[[skills.config]]"]);
  assert.deepEqual(hit("skills.max_context_tokens = 5000\n"), ["skills.max_context_tokens = 5000"]);
  assert.deepEqual(hit("skills = { bundled = { enabled = true } }\n"), ["skills = { bundled = { enabled = true } }"]);
  assert.deepEqual(hit("# [skills]\n"), []);
  assert.deepEqual(hit("[skillset]\nx = 1\n"), []);           // 前缀相同不算
  assert.deepEqual(hit("skillsets = 1\n"), []);
  assert.deepEqual(hit('[projects."/x"]\nskills = 1\ntrust_level = "trusted"\n'), []);  // 别的表下的键
  assert.deepEqual(hit('[projects."/x"]\ntrust_level = "trusted"\n' + buildSkillsIsolationBlock(["/x/SKILL.md"])), []);  // 块内的不算
  assert.deepEqual(hit('x = "a # not comment [skills]"\n'), []);  // 引号里的 # 不是注释,也不是表头
  assert.deepEqual(hit('note = """\n[not_a_real_table]\n"""\nskills.max_context_tokens = 100\n'), ["skills.max_context_tokens = 100"]);  // 多行字符串里的伪表头不算
  assert.deepEqual(hit("note = '''\n[skills]\n'''\n"), []);
  // 单行字符串里的三引号不是多行开头(r4):后面的顶层 skills 键必须仍被识别
  assert.deepEqual(hit('developer_instructions = "Use """ delimiters"\nskills.max_context_tokens = 100\n'), ["skills.max_context_tokens = 100"]);
  assert.deepEqual(hit("developer_instructions = 'Use \"\"\" delimiters'\nskills.max_context_tokens = 100\n"), ["skills.max_context_tokens = 100"]);
  assert.deepEqual(hit('x = """same line"""\nskills.max_context_tokens = 1\n'), ["skills.max_context_tokens = 1"]);  // 同行开合
});

test("installSkillsIsolation:写入产品 CODEX_HOME/config.toml 标记块;块外内容保留;幂等(changed=false);产品仓库内 realpath 不写;与 hooks 块并存;重装整体替换;uninstall 只删自己的块", () => {
  const f = fixture();
  const cfg = makeConfig({ symbol: "1", repoRoot: f.repo, codexHome: f.codexHome });
  fs.writeFileSync(path.join(f.codexHome, "config.toml"), '[projects."/x"]\ntrust_level = "trusted"\n');
  const r1 = installSkillsIsolation(cfg, { homeDir: f.home });
  assert.deepEqual(r1.disabledPaths, [f.a, f.b, f.nested, f.deep6, f.linked, f.legacy, f.alias, f.repodocLink].sort());
  assert.equal(r1.excludedInRepo, 1);
  assert.equal(r1.bundledDisabled, true); assert.equal(r1.changed, true); assert.equal(r1.disabledSha256, sha256List(r1.disabledPaths)); assert.match(r1.disabledSha256, /^[0-9a-f]{64}$/);
  const t1 = fs.readFileSync(r1.configTomlPath, "utf8");
  assert.ok(t1.startsWith('[projects."/x"]\ntrust_level = "trusted"\n'));
  assert.ok(!t1.includes("/prod/SKILL.md") && !t1.includes(f.prodSkill), "指向产品 skill 的链接不得写入(canonicalize 后会禁掉产品 skill)");
  for (const p of r1.disabledPaths) assert.ok(t1.includes(`[[skills.config]]\npath = ${JSON.stringify(p)}\nenabled = false`));
  // 幂等
  const r2 = installSkillsIsolation(cfg, { homeDir: f.home });
  assert.equal(r2.changed, false); assert.equal(fs.readFileSync(r1.configTomlPath, "utf8"), t1);
  // hooks 块随后安装:两块并存
  const h = installHooks(cfg, "/usr/local/bin/node");
  const t2 = fs.readFileSync(h.configTomlPath, "utf8");
  assert.ok(t2.includes(SKILLS_BLOCK_BEGIN) && t2.includes(SKILLS_BLOCK_END) && t2.includes("vibe-research hooks state"));
  for (const st of h.states) assert.ok(t2.includes(st.trusted_hash));
  assert.equal((t2.match(/\[skills\]/g) ?? []).length, 1);
  // 用户 skill 集合变化后重装:旧块整体替换(不累积),hooks 块不动
  mk(f.a.replace("a-stock-data", "new-one"));
  fs.rmSync(path.dirname(f.b), { recursive: true });
  const r3 = installSkillsIsolation(cfg, { homeDir: f.home });
  const t3 = fs.readFileSync(r3.configTomlPath, "utf8");
  assert.equal(r3.changed, true); assert.equal(r3.disabledPaths.length, 8);
  assert.ok(!t3.includes(JSON.stringify(f.b)) && t3.includes(JSON.stringify(f.a.replace("a-stock-data", "new-one"))));
  assert.equal((t3.match(/\[skills\]/g) ?? []).length, 1);
  for (const st of h.states) assert.ok(t3.includes(st.trusted_hash));
  assert.ok(t3.startsWith('[projects."/x"]'));
  // 卸载只删自己的块
  uninstallSkillsIsolation(cfg);
  const t4 = fs.readFileSync(r3.configTomlPath, "utf8");
  assert.ok(!t4.includes(SKILLS_BLOCK_BEGIN) && !t4.includes("[skills]"));
  assert.ok(t4.includes("vibe-research hooks state") && t4.startsWith('[projects."/x"]'));
});

test("installSkillsIsolation:块外已有 skills 配置 → 拒绝(否则 TOML 重复定义,Codex 启动即配置错误)", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.codexHome, "config.toml"), 'skills.max_context_tokens = 100\n');
  assert.throws(() => installSkillsIsolation({ codexHome: f.codexHome }, { homeDir: f.home }), /skills 配置/);
  fs.writeFileSync(path.join(f.codexHome, "config.toml"), '["skill\\u0073"]\nmax_context_tokens = 100\n');
  assert.throws(() => installSkillsIsolation({ codexHome: f.codexHome }, { homeDir: f.home }), /skills 配置/);
});

test("skillsIsolationStatus:结构化判定——恰好只有 path + enabled = false 才算禁用(path+name 同写 Codex 会整条忽略);bundled / 预算 / 覆盖 / 手改;无块 → 不 covered", () => {
  const a = "/u/a/SKILL.md", b = "/u/b/SKILL.md";
  const ok = skillsIsolationStatus(buildSkillsIsolationBlock([a, b]), [a, b]);
  assert.equal(ok.covered, true); assert.equal(ok.bundledDisabled, true); assert.equal(ok.maxContextTokens, SKILLS_MAX_CONTEXT_TOKENS); assert.deepEqual(ok.missing, []); assert.deepEqual(ok.malformed, []);
  const miss = skillsIsolationStatus(buildSkillsIsolationBlock([a]), [a, b]);
  assert.equal(miss.covered, false); assert.deepEqual(miss.missing, [b]);
  // 手改:enabled = true / 缺 enabled / 同时带 name / 单引号字面量 path → 不算禁用
  const base = buildSkillsIsolationBlock([a, b]);
  const t1 = skillsIsolationStatus(base.replace(`path = ${JSON.stringify(b)}\nenabled = false`, `path = ${JSON.stringify(b)}\nenabled = true`), [a, b]);
  assert.equal(t1.covered, false); assert.deepEqual(t1.disabled, [a]); assert.deepEqual(t1.malformed, [b]); assert.deepEqual(t1.missing, [b]);
  const t2 = skillsIsolationStatus(base.replace(`path = ${JSON.stringify(b)}\nenabled = false`, `path = ${JSON.stringify(b)}\nname = "b"\nenabled = false`), [a, b]);
  assert.equal(t2.covered, false); assert.deepEqual(t2.malformed, [b]);
  const t3 = skillsIsolationStatus(base.replace(`path = ${JSON.stringify(b)}`, `path = '${b}'`), [a, b]);
  assert.equal(t3.covered, false); assert.deepEqual(t3.disabled, [a]);
  // 后置 name-only 条目重新启用(Codex 按顺序应用 selector)→ 不 covered;额外键 → malformed
  const t4 = skillsIsolationStatus(base.replace(SKILLS_BLOCK_END, `[[skills.config]]\nname = "a"\nenabled = true\n${SKILLS_BLOCK_END}`), [a, b]);
  assert.equal(t4.covered, false); assert.deepEqual(t4.malformed, ["<无 path 的条目>"]); assert.deepEqual(t4.disabled, [a, b]);
  const t5 = skillsIsolationStatus(base.replace(`path = ${JSON.stringify(b)}\nenabled = false`, `path = ${JSON.stringify(b)}\nenabled = false\nfoo = 1`), [a, b]);
  assert.equal(t5.covered, false); assert.deepEqual(t5.malformed, [b]);
  // 引号 / 转义写法的 name 键(合法 TOML)同样计入 malformed(r4:原先只认裸键会假绿)
  for (const nameKey of ['"name"', '"na\\u006de"', "'name'"]) {
    const tq = skillsIsolationStatus(base.replace(`path = ${JSON.stringify(b)}\nenabled = false`, `path = ${JSON.stringify(b)}\n${nameKey} = "b"\nenabled = false`), [a, b]);
    assert.equal(tq.covered, false, nameKey); assert.deepEqual(tq.malformed, [b], nameKey);
  }
  // 非键值行(续行 / 垃圾)也算偏离
  const t6 = skillsIsolationStatus(base.replace(`path = ${JSON.stringify(b)}\nenabled = false`, `path = ${JSON.stringify(b)}\nenabled = false\ngarbage line`), [a, b]);
  assert.equal(t6.covered, false);
  // bundled 被改 / 预算缺失、越界、下划线写法 → 不 covered
  assert.equal(skillsIsolationStatus(base.replace("[skills.bundled]\nenabled = false", "[skills.bundled]\nenabled = true"), [a, b]).covered, false);
  assert.equal(skillsIsolationStatus(base.replace("max_context_tokens = 10000", "max_context_tokens = 99999"), [a, b]).covered, false);
  assert.equal(skillsIsolationStatus(base.replace("max_context_tokens = 10000", "max_context_tokens = 10_000"), [a, b]).maxContextTokens, null);
  assert.equal(skillsIsolationStatus(base.replace("max_context_tokens = 10000\n", ""), [a, b]).maxContextTokens, null);
  const none = skillsIsolationStatus("", []);
  assert.equal(none.hasBlock, false); assert.equal(none.covered, false);
  assert.deepEqual(skillsIsolationStatus("", [a]).missing, [a]);
});

test("posixQuote / installCommandFor:空格、中文、引号、$、反引号路径都作为字面量;命令用绝对路径", () => {
  assert.equal(posixQuote("a b"), "'a b'");
  assert.equal(posixQuote("it's $HOME `x` 中文"), `'it'\\''s $HOME \`x\` 中文'`);
  const repo = path.join(path.parse(process.cwd()).root, "r e", "po");
  const home = path.join(path.parse(process.cwd()).root, "h", "$x", "codex-home");
  const node = path.join(path.parse(process.cwd()).root, "Program Files", "node.exe");
  const cmd = installCommandFor(repo, home, node);
  const q = process.platform === "win32" ? (s: string) => `'${s.replace(/'/g, "''")}'` : posixQuote;
  assert.equal(cmd, `${process.platform === "win32" ? "& " : ""}${q(node)} ${q(path.join(repo, "orchestrator", "src", "skills_isolation.ts"))} --codex-home ${q(home)}`);
});

test("runInit:首装即写隔离块(doctor 首次运行前就能绿);再跑一次 action=exists", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-skiso-init-"));
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# c\n");
  const r1 = runInit({ repoRoot: repo, python: "/fake/python" });
  const s1 = r1.steps.find((s) => s.id === "skills_isolation");
  assert.ok(s1 && s1.action === "written", JSON.stringify(r1.steps));
  const toml = fs.readFileSync(path.join(repo, ".local", "codex-home", "config.toml"), "utf8");
  assert.ok(toml.includes("[skills.bundled]\nenabled = false"));
  assert.equal(runInit({ repoRoot: repo }).steps.find((s) => s.id === "skills_isolation")?.action, "exists");
});

test("scanForeignSkills:超过 Codex 截断边界(2,000 唯一目录)→ truncated=true 且不抛错(用户 skill 目录里有 node_modules 不能打断运行)", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vra-skiso-big-"));
  const home = path.join(base, "home"), codexHome = path.join(base, "codex-home");
  const root = path.join(home, ".agents", "skills");
  mk(path.join(root, "aaa-first", "SKILL.md"));  // 排序靠前,截断前一定能枚举到
  const big = path.join(root, "big-skill", "node_modules");
  for (let i = 0; i < SKILLS_MAX_DIRS_PER_ROOT + 5; i++) fs.mkdirSync(path.join(big, `pkg-${String(i).padStart(5, "0")}`), { recursive: true });
  const scan = scanForeignSkills({ codexHome, homeDir: home });
  assert.equal(scan.truncated, true);
  assert.ok(scan.paths.includes(path.join(root, "aaa-first", "SKILL.md")));
  const r = installSkillsIsolation({ codexHome }, { homeDir: home });
  assert.equal(r.truncated, true); assert.ok(r.disabledPaths.length >= 1);
});

test("installSkillsIsolation:写前 tomllib 校验——原文件本身语法错 / 冲突漏判时不写、原文件不动;合法时 tomlValidated=true(无 tomllib 的解释器 → null)", () => {
  const f = fixture();
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const PY = loadProductConfig(REPO, { env: process.env }).python ?? process.env.VRA_PYTHON ?? "python3";
  const probe = validateTomlText(PY, "a = 1\n");
  if (probe === undefined) { console.log("(解释器无 tomllib,跳过校验断言)"); return; }
  assert.equal(probe, null);
  assert.match(validateTomlText(PY, "a = \n") ?? "", /./);
  const cp = path.join(f.codexHome, "config.toml");
  fs.writeFileSync(cp, "broken = \n");
  assert.throws(() => installSkillsIsolation({ codexHome: f.codexHome, python: PY }, { homeDir: f.home }), /不是合法 TOML/);
  assert.equal(fs.readFileSync(cp, "utf8"), "broken = \n");  // 原文件未动
  fs.writeFileSync(cp, '[projects."/x"]\ntrust_level = "trusted"\n');
  const r = installSkillsIsolation({ codexHome: f.codexHome, python: PY }, { homeDir: f.home });
  assert.equal(r.tomlValidated, true); assert.equal(r.changed, true);
  assert.equal(installSkillsIsolation({ codexHome: f.codexHome, python: "/nonexistent/python" }, { homeDir: f.home }).tomlValidated, null);  // 幂等无变化时不校验
});
