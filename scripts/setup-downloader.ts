import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, chmod, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { DOWNLOADER_VERSION } from "../shared/contracts.ts";

const assets: Record<string, string> = {
  "win32-x64": "yt-dlp.exe",
  "win32-arm64": "yt-dlp_arm64.exe",
  "darwin-x64": "yt-dlp_macos",
  "darwin-arm64": "yt-dlp_macos",
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
};
const asset = assets[`${process.platform}-${process.arch}`];
if (!asset) throw Error("此平台没有配置官方 yt-dlp 独立二进制");
const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${DOWNLOADER_VERSION}`;
async function get(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw Error(`下载失败：HTTP ${r.status}`);
  return r;
}
const sums = await (await get(base + "/SHA2-256SUMS")).text();
const expected = sums
  .split("\n")
  .map((s) => s.trim().split(/\s+/))
  .find((parts) => parts[1]?.replace(/^\*/, "") === asset)?.[0];
if (!expected) throw Error("官方校验列表缺少此二进制");
console.log(`下载官方 yt-dlp ${DOWNLOADER_VERSION} / ${asset}`);
const bytes = Buffer.from(await (await get(base + "/" + asset)).arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw Error("SHA-256 校验失败，未安装");
await mkdir(resolve("bin"), { recursive: true });
const target = resolve(
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);
try {
  await writeFile(target + ".tmp", bytes, { mode: 0o755 });
  await rename(target + ".tmp", target);
  await chmod(target, 0o755);
  await writeFile(
    resolve("bin/manifest.json"),
    JSON.stringify(
      { version: DOWNLOADER_VERSION, asset, sha256: expected },
      null,
      2,
    ),
  );
} finally {
  await unlink(target + ".tmp").catch(() => {});
}
console.log(`已校验并安装：${target}`);
