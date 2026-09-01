import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ReportLibraryError, addReport, listReports, removeReport, reportCitationErrors, reportCitations, reportContext, reportFile, reportsForSymbol } from "../src/report_library.ts";
import { directoryLink } from "./platform.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-reports-"));
const b64 = (buf: Buffer, mime = "text/plain") => `data:${mime};base64,${buf.toString("base64")}`;

/** 生成一页、带真文字层的最小 PDF；xref 偏移动态计算，避免拿机器外的夹具。 */
function tinyPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, (m) => `\\${m}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

test("TXT 入库后原文件、正文索引、代码标签与检索引用同时成立", async () => {
  const root = tmp();
  const rec = await addReport(root, {
    name: "中际旭创300308调研.md",
    content: b64(Buffer.from("中际旭创 300308\n核心观点：收入增长来自高速光模块需求。", "utf8")),
  });
  assert.equal(rec.symbols.includes("300308"), true);
  assert.equal(rec.chars > 10, true);
  assert.equal(listReports(root).length, 1);
  const stored = reportFile(root, rec.id);
  assert.ok(stored && fs.readFileSync(stored.path, "utf8").includes("收入增长"));
  const hit = reportContext(root, "中际旭创的收入");
  assert.ok(hit?.text.includes(`[资料:${rec.id} p.-]`));
  assert.ok(hit?.text.includes("收入增长"));
  assert.ok(!hit?.text.includes("texts/"), "对话只能收到命中片段，不能获得完整正文路径");
});

test("PDF 真文字层可提取页码，并进入个股研究的代码召回", async () => {
  const root = tmp();
  const rec = await addReport(root, {
    name: "300308-report.pdf",
    content: b64(tinyPdf("300308 revenue growth"), "application/pdf"),
  });
  assert.equal(rec.pages, 1);
  assert.equal(rec.symbols.includes("300308"), true);
  const recalled = reportsForSymbol(root, "300308");
  assert.ok(recalled?.text.includes(`[资料:${rec.id} p.1]`));
  assert.ok(recalled?.text.includes("revenue growth"));
  assert.ok(!recalled?.text.includes("可继续读取:"), "研究线程禁止读取运行目录之外，不能给外部路径");
});

test("检索归一化不会让长文后页的片段与页码错位", async () => {
  const root = tmp();
  const firstPage = Array.from({ length: 500 }, (_, i) => `第一页填充${i}\n\n\n`).join("");
  const rec = await addReport(root, {
    name: "分页研报.md",
    content: b64(Buffer.from(`--- 第 1 页 ---\n${firstPage}--- 第 2 页 ---\n第二页独有结论：光模块需求继续增长。`, "utf8")),
  });
  const hit = reportContext(root, "光模块需求");
  assert.ok(hit?.text.includes(`[资料:${rec.id} p.2]`));
  assert.ok(hit?.text.includes("第二页独有结论"));
  assert.ok(!hit?.text.includes("第一页填充0"), "命中后页时不能按归一化坐标截取前页原文");
});

test("研报引用必须来自本轮真实命中，且页码不能由模型编造", () => {
  const id = "a".repeat(32);
  const sources = [{ id, name: "研究.pdf", page: 3 }];
  assert.deepEqual(reportCitationErrors("结论没有来源", sources), ["资料片段已进入本轮上下文，但回答没有保留任何 [资料:<id> p.<页码>] 引用"]);
  assert.ok(reportCitationErrors(`[资料:${id} p.4]`, sources).some((e) => e.includes("页码应为 p.3")));
  assert.ok(reportCitationErrors(`[资料:${"b".repeat(32)} p.3]`, sources).some((e) => e.includes("本轮未提供")));
  assert.deepEqual(reportCitationErrors(`该判断来自原文 [资料:${id} p.3]`, sources), []);
  assert.deepEqual(reportCitations(`前文 [资料:${id} p.3]`), [{ id, page: 3 }]);
});

test("同一文件重复上传不复制；删除同时移除原文件与正文，但不碰其他报告", async () => {
  const root = tmp();
  const content = b64(Buffer.from("300308 同一份内容"));
  const a = await addReport(root, { name: "a.txt", content });
  const b = await addReport(root, { name: "rename.txt", content });
  const other = await addReport(root, { name: "b.txt", content: b64(Buffer.from("600519 另一份")) });
  assert.equal(a.id, b.id);
  const file = reportFile(root, a.id)!.path;
  assert.equal(await removeReport(root, a.id), true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(listReports(root).map((r) => r.id), [other.id]);
  assert.equal(await removeReport(root, a.id), false);
});

test("损坏索引 fail-loud，绝不把它当空库覆盖；不支持的格式给出真实范围", async () => {
  const root = tmp();
  const manifest = path.join(root, "knowledge", "reports", "manifest.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "{broken");
  assert.throws(() => listReports(root), (e: unknown) => e instanceof ReportLibraryError && e.code === "report_index_corrupt");
  await assert.rejects(
    addReport(tmp(), { name: "old.doc", content: b64(Buffer.from("x")) }),
    (e: unknown) => e instanceof ReportLibraryError && e.code === "unsupported_report_type",
  );
});

test("非法 UTF-8 / GBK 字节必须明确失败，不能以乱码状态显示已接入 Agent", async () => {
  await assert.rejects(
    addReport(tmp(), { name: "gbk.txt", content: b64(Buffer.from([0xd6, 0xd0, 0xbc, 0xca])) }),
    (e: unknown) => e instanceof ReportLibraryError && e.code === "report_parse_failed" && /UTF-8/.test(e.message),
  );
});

test("A股 / 港股 / 美股代码都能成为归档与对话检索键", async () => {
  const root = tmp();
  const hk = await addReport(root, { name: "腾讯控股-HK:700.docx.txt", content: b64(Buffer.from("港股 HK:700 业务复盘")) });
  const us = await addReport(root, { name: "NASDAQ-NVDA.md", content: b64(Buffer.from("Ticker: NVDA datacenter demand")) });
  assert.deepEqual(hk.symbols, ["00700"]);
  assert.deepEqual(us.symbols, ["NVDA"]);
  assert.ok(reportsForSymbol(root, "00700")?.hits.some((x) => x.id === hk.id));
  assert.ok(reportsForSymbol(root, "NVDA")?.hits.some((x) => x.id === us.id));
});

test("普通六位业务数字不能冒充 A 股代码；只有公司名的研报仍能按主体召回", async () => {
  const root = tmp();
  const macro = await addReport(root, {
    name: "电力行业月报.md",
    content: b64(Buffer.from("本月新增并网装机 300308 千瓦，累计利用小时 128900。")),
  });
  const company = await addReport(root, {
    name: "中际旭创跟踪笔记.txt",
    content: b64(Buffer.from("中际旭创的高速光模块订单与产能跟踪。")),
  });
  assert.deepEqual(macro.symbols, [], "单位前的六位数字不是证券代码");
  assert.deepEqual(company.symbols, [], "正文没有明确代码时不应猜代码");
  const recalled = reportsForSymbol(root, "300308", { companyName: "中际旭创" });
  assert.ok(recalled?.hits.some((x) => x.id === company.id), "公司名必须参与无代码研报的召回");
  assert.ok(!recalled?.hits.some((x) => x.id === macro.id), "业务数字相同的无关报告不能被召回");
});

test("旧版索引会按新规则重建代码标签，精确召回也不会混入正文偶遇同号的报告", async () => {
  const root = tmp();
  const exact = await addReport(root, { name: "300308-公司报告.md", content: b64(Buffer.from("公司代码：300308，收入增长。")) });
  const macro = await addReport(root, { name: "行业统计.md", content: b64(Buffer.from("新增装机 300308 千瓦。")) });
  const manifest = path.join(root, "knowledge", "reports", "manifest.json");
  const old = JSON.parse(fs.readFileSync(manifest, "utf8"));
  old.schema_version = 1;
  old.reports.find((r: { id: string }) => r.id === macro.id).symbols = ["300308"];
  fs.writeFileSync(manifest, JSON.stringify(old));
  const records = listReports(root);
  assert.deepEqual(records.find((r) => r.id === macro.id)?.symbols, []);
  assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).schema_version, 2);
  const recalled = reportsForSymbol(root, "300308");
  assert.deepEqual(recalled?.hits.map((x) => x.id), [exact.id]);
});

test("研报目录里的符号链接不能把上传写到用户数据根之外", async () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  directoryLink(outside, path.join(root, "knowledge", "reports"));
  await assert.rejects(
    addReport(root, { name: "300308.md", content: b64(Buffer.from("300308 x")) }),
    (e: unknown) => e instanceof ReportLibraryError && e.code === "report_path_symlink",
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
