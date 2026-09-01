import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register.ts";  // makeConfig 需要已注册的插件
import { makeConfig } from "../src/config.ts";
import {
  CONSTITUTION_FILENAME, CONSTITUTION_OVERRIDE_FILENAME, ROOT_MARKER_FILENAME, SKILLS_REL,
  buildProjectRootBlock, dirsBetween, verifyProjectRootBlock, ensureInstructionsRoot, ensureRootMarker,
  findForeignProjectRootMarkers, installProjectRootMarkers, preflightInstructions,
  resolveInstructionsRoot, syncInstructionAssets,
} from "../src/instructions_root.ts";
import { directoryLink, fileLinkOrSkip } from "./platform.ts";

/**
 * 这些校验拦的全是**静默失效**:引擎不报错,只是宪法 / 技能不在提示词里,而报告照样产出。
 * 所以每条都要有一个会红的用例 —— 校验本身失效是没人会发现的那种失效。
 * 规则本身由 `codex debug prompt-input` 实测确认(见 docs/instructions-root.md)。
 */

function tmp(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** 造一个"产品根":宪法 + 项目技能 */
function product(): string {
  const root = tmp("vra-ir-app-");
  fs.writeFileSync(path.join(root, CONSTITUTION_FILENAME), "# 宪法\n产出红线在这里\n");
  fs.mkdirSync(path.join(root, SKILLS_REL), { recursive: true });
  fs.writeFileSync(path.join(root, SKILLS_REL, "a.md"), "# 技能 a\n");
  return root;
}

function cfgOf(repoRoot: string, dataRoot: string, runId = "r1") {
  const runDir = path.join(dataRoot, "runs", runId);
  return { repoRoot, dataRoot, runDir, codexHome: path.join(dataRoot, "codex-home") };
}

test("指令根:产品根是运行目录祖先 → product 模式;否则 data 模式", () => {
  const app = product();
  assert.deepEqual(resolveInstructionsRoot(cfgOf(app, path.join(app, ".local"))), { root: path.resolve(app), mode: "product" });
  const data = tmp("vra-ir-data-");
  assert.deepEqual(resolveInstructionsRoot(cfgOf(app, data)), { root: path.resolve(data), mode: "data" });
  // 数据根恰好等于产品根也算 product(祖先判定含自身)
  assert.equal(resolveInstructionsRoot(cfgOf(app, app)).mode, "product");
});

test("dirsBetween:含两端;运行目录不是后代时返回空", () => {
  const r = path.resolve("/a/b");
  assert.deepEqual(dirsBetween(r, "/a/b/c/d"), [r, path.resolve("/a/b/c"), path.resolve("/a/b/c/d")]);
  assert.deepEqual(dirsBetween(r, r), [r]);
  assert.deepEqual(dirsBetween(r, "/a/x"), []);
});

test("project_root_markers 块:格式、非法输入、块外冲突", () => {
  assert.match(buildProjectRootBlock(), /project_root_markers = \[".vibe-research-root"\]/);
  assert.match(buildProjectRootBlock(["m1", "m2"]), /\["m1", "m2"\]/);
  // 空数组会**关掉**向上遍历(引擎语义),等于把发现链整个废掉 → 必须拒绝
  assert.throws(() => buildProjectRootBlock([]), /不能为空/);
  assert.throws(() => buildProjectRootBlock([" "]), /空串/);
  assert.throws(() => buildProjectRootBlock(["a/b"]), /不能含分隔符/);
  assert.equal(findForeignProjectRootMarkers('project_root_markers = [".git"]\n'), true);
  assert.equal(findForeignProjectRootMarkers(buildProjectRootBlock()), false, "块内的不算冲突");
  assert.equal(findForeignProjectRootMarkers("# project_root_markers = x\n"), false, "注释不算");
});

test("installProjectRootMarkers:幂等、块外已有则拒绝", () => {
  const home = tmp("vra-ir-home-");
  const first = installProjectRootMarkers({ codexHome: home });
  assert.equal(first.changed, true);
  assert.equal(installProjectRootMarkers({ codexHome: home }).changed, false, "第二次不该再写");
  assert.match(fs.readFileSync(first.configTomlPath, "utf8"), /project_root_markers/);
  const dirty = tmp("vra-ir-home2-");
  fs.writeFileSync(path.join(dirty, "config.toml"), 'project_root_markers = [".git"]\n');
  assert.throws(() => installProjectRootMarkers({ codexHome: dirty }), /标记块之外已有/);
});

test("ensureRootMarker:幂等", () => {
  const d = tmp("vra-ir-m-");
  assert.equal(ensureRootMarker(d), true);
  assert.equal(ensureRootMarker(d), false);
  assert.ok(fs.existsSync(path.join(d, ROOT_MARKER_FILENAME)));
});

test("syncInstructionAssets:幂等、删多余、缺母本报错、同根跳过", () => {
  const app = product(), data = tmp("vra-ir-sync-");
  const first = syncInstructionAssets(app, data);
  assert.deepEqual(first.copied.sort(), [CONSTITUTION_FILENAME, path.join(SKILLS_REL, "a.md")].sort());
  assert.deepEqual(fs.readFileSync(path.join(data, CONSTITUTION_FILENAME)), fs.readFileSync(path.join(app, CONSTITUTION_FILENAME)));
  const second = syncInstructionAssets(app, data);
  assert.deepEqual(second.copied, [], "内容没变就不该重写(否则每次运行都动 mtime)");
  assert.equal(second.unchanged, 2);
  // 目标端多出来的文件要删:那是上一版产品留下的,不删就会被引擎当成当前技能加载
  fs.writeFileSync(path.join(data, SKILLS_REL, "stale.md"), "# 上一版留下的\n");
  assert.deepEqual(syncInstructionAssets(app, data).removed, [path.join(SKILLS_REL, "stale.md")]);
  assert.deepEqual(syncInstructionAssets(app, app), { copied: [], removed: [], unchanged: 0 }, "同根不搬");
  assert.throws(() => syncInstructionAssets(tmp("vra-ir-empty-"), tmp("vra-ir-x-")), /指令资产缺失/);
});

test("preflight:每一条静默失效都要被拦住", () => {
  const app = product(), data = tmp("vra-ir-pf-");
  const cfg = cfgOf(app, data);
  fs.mkdirSync(cfg.runDir, { recursive: true });
  const probs = () => preflightInstructions(cfg).problems.join("\n");

  // 什么都没装 → 缺宪法 / 缺技能 / 缺 marker / 缺配置块,四条都要报
  const bare = probs();
  for (const re of [/宪法不是普通文件/, /项目技能不是普通目录/, /缺 project root 标记/, /没有 project_root_markers 生成块/]) {
    assert.match(bare, re);
  }

  ensureInstructionsRoot(cfg);
  assert.deepEqual(preflightInstructions(cfg).problems, [], "装配后应全部通过");

  // AGENTS.override.md:实测会**整份替换**同目录的 AGENTS.md,产出红线随之消失
  const ov = path.join(data, CONSTITUTION_OVERRIDE_FILENAME);
  fs.writeFileSync(ov, "# 覆盖\n");
  assert.match(probs(), /整份替换/);
  fs.rmSync(ov);

  // 链上多余的宪法会被**追加**;多余的技能目录会被当项目技能加载
  const midConstitution = path.join(data, "runs", CONSTITUTION_FILENAME);
  fs.writeFileSync(midConstitution, "# 混进来的\n");
  assert.match(probs(), /会被追加进宪法/);
  fs.rmSync(midConstitution);
  fs.mkdirSync(path.join(data, "runs", SKILLS_REL), { recursive: true });
  assert.match(probs(), /会被当作项目技能加载/);
  fs.rmSync(path.join(data, "runs", ".agents"), { recursive: true });

  // 宪法副本被改 → 与母本不一致(manifest 记母本 sha256、引擎跑副本 = 记一份跑另一份)
  fs.writeFileSync(path.join(data, CONSTITUTION_FILENAME), "# 被人改过的宪法\n");
  assert.match(probs(), /与产品根母本不一致/);
  fs.copyFileSync(path.join(app, CONSTITUTION_FILENAME), path.join(data, CONSTITUTION_FILENAME));
  assert.deepEqual(preflightInstructions(cfg).problems, []);

  // marker 被删 → 无 .git 时引擎只看运行目录那一层(zip 解压场景)
  fs.rmSync(path.join(data, ROOT_MARKER_FILENAME));
  assert.match(probs(), /缺 project root 标记/);
  ensureRootMarker(data);

  // 🔴 链上**更近**的 marker 会把 project root 拉下来,指令根的宪法与技能一条都进不去,而其它检查全绿
  const nearer = path.join(data, "runs", ROOT_MARKER_FILENAME);
  fs.writeFileSync(nearer, "x");
  assert.match(probs(), /会把 project root 拉到这一层/);
  fs.rmSync(nearer);

  // 类型不对:目录冒充宪法 / 文件冒充技能目录 —— 只查 existsSync 会放过
  const c = path.join(data, CONSTITUTION_FILENAME);
  const keep = fs.readFileSync(c);
  fs.rmSync(c); fs.mkdirSync(c);
  assert.match(probs(), /宪法不是普通文件/);
  fs.rmSync(c, { recursive: true }); fs.writeFileSync(c, keep);

  // data 模式:技能镜像被改 / 有上一版残留 → 必须报(只查目录在不在挡不住)
  const mirrored = path.join(data, SKILLS_REL, "a.md");
  fs.writeFileSync(mirrored, "# 被改过的技能\n");
  assert.match(probs(), /项目技能镜像与产品根母本不一致/);
  fs.copyFileSync(path.join(app, SKILLS_REL, "a.md"), mirrored);
  fs.writeFileSync(path.join(data, SKILLS_REL, "stale.md"), "# 上一版残留\n");
  assert.match(probs(), /项目技能镜像与产品根母本不一致/);
  fs.rmSync(path.join(data, SKILLS_REL, "stale.md"));
  assert.deepEqual(preflightInstructions(cfg).problems, []);
});

test("config 块必须真的生效:落进上一张表 / 值被改 / 重复 / 缺半边,都要报(不能只查块在不在)", () => {
  const good = buildProjectRootBlock();
  assert.equal(verifyProjectRootBlock(good + "\n"), null);
  assert.equal(verifyProjectRootBlock(good + "\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n"), null);
  // 🔴 这条就是实测踩到的:块被追加到末尾 → 键落进 [hooks.state."…"],引擎照旧用 .git
  assert.match(String(verifyProjectRootBlock('[hooks.state."k"]\nenabled = true\n\n' + good + "\n")), /不在文件开头/);
  assert.match(String(verifyProjectRootBlock("")), /没有 project_root_markers 生成块/);
  assert.match(String(verifyProjectRootBlock(good.replace(".vibe-research-root", ".git") + "\n")), /内容与预期不符/);
  assert.match(String(verifyProjectRootBlock(good.split("\n").slice(0, 2).join("\n") + "\n")), /内容与预期不符/);
  assert.match(String(verifyProjectRootBlock(good + "\n\n" + good + "\n")), /出现多次/);
});

test("同步:拒绝源与目标互相包含;目标端的符号链接与非普通文件一律清掉", (t) => {
  const app = product();
  assert.throws(() => syncInstructionAssets(app, path.join(app, "sub")), /不得互相包含/);
  assert.throws(() => syncInstructionAssets(path.join(app, "sub"), app), /不得互相包含/);

  const data = tmp("vra-ir-link-");
  const outside = tmp("vra-ir-outside-");
  // 目标端的宪法是一条指向仓库外的符号链接,而且内容"恰好相同" —— 只比内容会把它当成已同步留下来,
  // 之后链接目标被改,引擎加载的就是外部内容
  fs.writeFileSync(path.join(outside, "evil.md"), fs.readFileSync(path.join(app, CONSTITUTION_FILENAME)));
  if (!fileLinkOrSkip(t, path.join(outside, "evil.md"), path.join(data, CONSTITUTION_FILENAME))) return;
  // 技能目录整个是指向外部的链接:不处理的话下面的复制会顺着它写到外面去
  fs.mkdirSync(path.join(outside, "skills"), { recursive: true });
  fs.mkdirSync(path.join(data, ".agents"), { recursive: true });
  directoryLink(path.join(outside, "skills"), path.join(data, SKILLS_REL));
  syncInstructionAssets(app, data);
  // 断言的是**安全性质**,不是某个实现细节:目标端不再是链接、外部文件没被写、改外部也影响不到我们
  for (const rel of [CONSTITUTION_FILENAME, SKILLS_REL]) {
    assert.equal(fs.lstatSync(path.join(data, rel)).isSymbolicLink(), false, `${rel} 不该还是符号链接`);
  }
  assert.deepEqual(fs.readdirSync(path.join(outside, "skills")), [], "不许顺着链接把技能写到外部目录");
  fs.writeFileSync(path.join(outside, "evil.md"), "# 链接目标被改了\n");
  assert.deepEqual(fs.readFileSync(path.join(data, CONSTITUTION_FILENAME)), fs.readFileSync(path.join(app, CONSTITUTION_FILENAME)));
});

test("preflight:运行目录不是指令根后代 → 直接判死,不再往下查", () => {
  const app = product(), data = tmp("vra-ir-out-");
  const cfg = { ...cfgOf(app, data), runDir: path.join(tmp("vra-ir-elsewhere-"), "runs", "r1") };
  const pre = preflightInstructions(cfg);
  assert.equal(pre.chain.length, 0);
  assert.equal(pre.problems.length, 1);
  assert.match(pre.problems[0], /不是指令根[\s\S]*的后代/);
});

test("ensureInstructionsRoot:product 模式不搬东西;data 模式搬完即通过;母本缺失则抛", () => {
  const app = product();
  const inRepo = { repoRoot: app, dataRoot: path.join(app, ".local"), runDir: path.join(app, ".local", "runs", "r1"), codexHome: path.join(app, ".local", "codex-home") };
  fs.mkdirSync(inRepo.runDir, { recursive: true });
  const a = ensureInstructionsRoot(inRepo);
  assert.equal(a.mode, "product");
  assert.equal(a.sync, null, "product 模式不该同步");
  assert.ok(fs.existsSync(path.join(app, ROOT_MARKER_FILENAME)));

  const data = tmp("vra-ir-e2-");
  const cfg = cfgOf(app, data);
  fs.mkdirSync(cfg.runDir, { recursive: true });
  const b = ensureInstructionsRoot(cfg);
  assert.equal(b.mode, "data");
  assert.equal(b.sync?.copied.length, 2);
  assert.deepEqual(preflightInstructions(cfg).problems, []);

  assert.throws(() => ensureInstructionsRoot({ ...cfg, repoRoot: tmp("vra-ir-noassets-") }), /指令资产缺失/);
});

test("同步:路径**中间段**是符号链接必须抛(否则会删到数据根之外)", () => {
  const app = product(), data = tmp("vra-ir-mid-"), outside = tmp("vra-ir-victim-");
  // 用户的真实资料被链接进来:.agents -> outside;不拦的话清理逻辑会顺着链接删掉 outside 里的文件
  fs.mkdirSync(path.join(outside, "skills"), { recursive: true });
  fs.writeFileSync(path.join(outside, "skills", "重要资料.md"), "# 不能被删\n");
  directoryLink(outside, path.join(data, ".agents"));
  assert.throws(() => syncInstructionAssets(app, data), /中间段是符号链接/);
  assert.ok(fs.existsSync(path.join(outside, "skills", "重要资料.md")), "外部文件一个都不许动");
  // 源端同理:不许从产品根之外取资产
  const app2 = tmp("vra-ir-app2-");
  fs.writeFileSync(path.join(app2, CONSTITUTION_FILENAME), "# c\n");
  directoryLink(outside, path.join(app2, ".agents"));
  assert.throws(() => syncInstructionAssets(app2, tmp("vra-ir-dst2-")), /中间段是符号链接/);
});

test("块外的等价键(引号形式)要认出来;表里的同名键不算", () => {
  const good = buildProjectRootBlock();
  for (const k of ['project_root_markers', '"project_root_markers"', "'project_root_markers'"]) {
    assert.equal(findForeignProjectRootMarkers(`${good}\n\n${k} = [".git"]\n`), true, k);
    assert.match(String(verifyProjectRootBlock(`${good}\n\n${k} = [".git"]\n`)), /生成块之外还有一个顶层/, k);
  }
  // 表里的是嵌套键,与顶层无关
  assert.equal(findForeignProjectRootMarkers(`${good}\n\n[skills]\nproject_root_markers = [".git"]\n`), false);
  assert.equal(verifyProjectRootBlock(`${good}\n\n[skills]\nproject_root_markers = [".git"]\n`), null);
});

test("多行字符串里的标记与键一律不算(排查笔记贴配置不该把安装卡死,Codex ir-r3)", () => {
  const good = buildProjectRootBlock();
  const Q = '"""';
  // 多行字符串里整行贴着我们的键 → 不是真的顶层定义
  const note = `${good}\n\ntroubleshooting = ${Q}\nproject_root_markers = [".git"]\n这只是排查记录\n${Q}\n`;
  assert.equal(findForeignProjectRootMarkers(note), false);
  assert.equal(verifyProjectRootBlock(note), null);
  // 多行字符串里贴着我们的开始标记 → 不该被判成"块只有一半"而永久卡住安装
  const home = tmp("vra-ir-ml-");
  fs.writeFileSync(path.join(home, "config.toml"), `x = ${Q}\n# >>> vibe-research project root (generated) >>>\n笔记\n${Q}\n`);
  assert.doesNotThrow(() => installProjectRootMarkers({ codexHome: home }));
  // 真的只有一半仍要抛
  const bad = tmp("vra-ir-half-");
  fs.writeFileSync(path.join(bad, "config.toml"), "# >>> vibe-research project root (generated) >>>\nproject_root_markers = [\".git\"]\n");
  assert.throws(() => installProjectRootMarkers({ codexHome: bad }), /只有一半/);
});

test("多行字符串里的转义引号不算闭合(Codex ir-r4)", () => {
  const good = buildProjectRootBlock();
  const Q = '"""', BS = String.fromCharCode(92);
  // `BS + Q` 在 basic 多行串里是"转义引号 + 两个普通引号",不是结束符 —— 提前判闭合会把下一行当真配置
  const note = [good, "", `note = ${Q}`, `示例:${BS}${Q}`, 'project_root_markers = [".git"]', Q, ""].join("\n");
  assert.equal(findForeignProjectRootMarkers(note), false, "字符串内容不是真的顶层键");
  assert.equal(verifyProjectRootBlock(note), null);
  // 字符串真的结束之后,同名键仍要认出来
  const after = [good, "", `note = ${Q}`, "笔记", Q, 'project_root_markers = [".git"]', ""].join("\n");
  assert.equal(findForeignProjectRootMarkers(after), true, "闭合之后的才是真的");
});

test("根路径不许含空白:带空格的数据根会让执行层拒掉所有引用运行目录的命令(实测),提前拒绝并说清楚", () => {
  const app = product();
  const spaced = path.join(tmp("vra-ir-sp-"), "Application Support", "VibeResearch");
  fs.mkdirSync(spaced, { recursive: true });
  assert.throws(() => makeConfig({ symbol: "1", repoRoot: app, dataRoot: spaced, python: "false", executionMode: "shell_hooks" }), /不能含空格/);
  // 根目录本身也不行:dataRoot="/" 时钩子边界会拼成 "//",每次调用都判不一致并放行(全审 r1-P3-7)
  assert.throws(() => makeConfig({ symbol: "1", repoRoot: app, dataRoot: "/", python: "false" }), /不能是文件系统根目录/);
  // 无空格照常
  assert.doesNotThrow(() => makeConfig({ symbol: "1", repoRoot: app, dataRoot: tmp("vra-ir-ok-"), python: "false" }));
});
