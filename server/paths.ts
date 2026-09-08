import { homedir } from "node:os";
import { resolve, join, extname, delimiter, isAbsolute } from "node:path";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";

export const normalizeBV = (s: unknown) => {
  const m = String(s || "").match(/BV[0-9A-Za-z]{10}/i);
  return m ? "BV" + m[0].slice(2) : null;
};
export function safeName(value: string) {
  let s = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 100);
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s))
    s = "_" + (s || "backup");
  return s;
}
export function expandPath(value: string, base = process.cwd()) {
  return resolve(
    base,
    value
      .replace(/^~(?=$|[\/\\])/, homedir())
      .replace(/%([^%]+)%/g, (s, k) => process.env[k] || s),
  );
}
export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function executable(name: string) {
  if (isAbsolute(name) || name.includes("/") || name.includes("\\"))
    return await exists(expandPath(name));
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const ext of extensions) {
      try {
        await access(
          join(dir, name + ext),
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return true;
      } catch {}
    }
  }
  return false;
}
const media = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".avi",
  ".mov",
  ".flv",
  ".m4v",
  ".ts",
]);
export async function scanMedia(
  root: string,
  required = false,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!(await exists(root))) {
    if (required) throw new Error("存档目录不存在，请检查路径或磁盘连接");
    return result;
  }
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (
        entry.isFile() &&
        media.has(extname(entry.name).toLowerCase()) &&
        !/\.f\d+\./.test(entry.name)
      ) {
        const bv = normalizeBV(entry.name);
        if (bv) result.set(bv, [...(result.get(bv) || []), path]);
      }
    }
  }
  await walk(root);
  return result;
}
