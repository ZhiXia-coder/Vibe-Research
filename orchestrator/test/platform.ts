/** Windows / POSIX 共用的测试夹具工具。 */
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";

/** 把测试里的 Unix 风格绝对路径按当前平台解析；不要拿 `/tmp` 硬断言 Windows 结果。 */
export function platformPath(value: string): string { return path.resolve(value); }

/** Windows junction 不需要 Developer Mode，且 lstat 仍能识别为 symbolic link。 */
export function directoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Windows 文件符号链接需要 Developer Mode 或 SeCreateSymbolicLinkPrivilege。
 * 环境不具备该能力时明确 skip，不把 OS 权限限制报成产品失败。
 */
export function fileLinkOrSkip(t: TestContext, target: string, link: string): boolean {
  try { fs.symlinkSync(target, link, "file"); return true; }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows 未启用 Developer Mode，当前用户不能创建文件符号链接");
      return false;
    }
    throw error;
  }
}

/** 混合场景用：无法创建 Windows 文件链接时只跳过该段断言，而不是整条测试。 */
export function tryFileLink(target: string, link: string): boolean {
  try { fs.symlinkSync(target, link, "file"); return true; }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}
