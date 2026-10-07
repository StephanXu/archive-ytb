import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  chmod,
  rm,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { RCLONE_VERSION } from "../shared/contracts.ts";
import { runProcess } from "../server/process.ts";

const platforms: Record<string, string> = {
  "win32-x64": "windows-amd64",
  "win32-arm64": "windows-arm64",
  "darwin-x64": "osx-amd64",
  "darwin-arm64": "osx-arm64",
  "linux-x64": "linux-amd64",
  "linux-arm64": "linux-arm64",
};
const platform = platforms[`${process.platform}-${process.arch}`];
if (!platform) throw Error("此平台未配置 rclone 官方二进制");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const folder = join(root, "bin", "rclone");
const executable = process.platform === "win32" ? "rclone.exe" : "rclone";
const target = join(folder, executable);
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
let ready = false;
try {
  const manifest = JSON.parse(
    await readFile(join(folder, "manifest.json"), "utf8"),
  );
  ready =
    manifest.version === RCLONE_VERSION &&
    manifest.platform === platform &&
    digest(await readFile(target)) === manifest.binary_sha256 &&
    (await runProcess(target, ["version"], { timeout: 20000 })).split(
      /\r?\n/,
    )[0] === `rclone v${RCLONE_VERSION}`;
} catch {
  /* Install a verified bundle when absent or damaged. */
}
if (!ready) {
  const base = `https://downloads.rclone.org/v${RCLONE_VERSION}`;
  const asset = `rclone-v${RCLONE_VERSION}-${platform}.zip`;
  async function get(url: string) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error(`下载失败：HTTP ${response.status}`);
    return response;
  }
  const sums = await (await get(`${base}/SHA256SUMS`)).text();
  const expected = sums
    .split(/\r?\n/)
    .map((s) => s.trim().split(/\s+/))
    .find((p) => p[1]?.replace(/^\*/, "") === asset)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
    throw Error("官方校验列表缺少此平台");
  console.log(`下载项目内 rclone ${RCLONE_VERSION} / ${platform}`);
  const bytes = Buffer.from(
    await (await get(`${base}/${asset}`)).arrayBuffer(),
  );
  if (digest(bytes) !== expected.toLowerCase())
    throw Error("rclone 压缩包 SHA-256 校验失败，未安装");
  const temp = await mkdtemp(join(tmpdir(), "archive-rclone-"));
  try {
    const archive = join(temp, "rclone.zip"),
      extracted = join(temp, "unpacked");
    await writeFile(archive, bytes);
    if (process.platform === "win32") {
      const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
      await runProcess("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extracted)}`,
      ]);
    } else await runProcess("unzip", ["-q", archive, "-d", extracted]);
    const contents = join(extracted, asset.slice(0, -4));
    const binary = await readFile(join(contents, executable));
    await mkdir(folder, { recursive: true });
    await writeFile(target + ".new", binary, { mode: 0o755 });
    await chmod(target + ".new", 0o755);
    if (
      (
        await runProcess(target + ".new", ["version"], { timeout: 20000 })
      ).split(/\r?\n/)[0] !== `rclone v${RCLONE_VERSION}`
    )
      throw Error("rclone 二进制版本不匹配");
    await rename(target + ".new", target);
    await writeFile(
      join(folder, "README.txt"),
      await readFile(join(contents, "README.txt")),
    );
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify(
        {
          version: RCLONE_VERSION,
          platform,
          asset,
          archive_sha256: expected,
          binary_sha256: digest(binary),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(target + ".new", { force: true });
  }
}
console.log(`项目内 rclone ${RCLONE_VERSION} 已校验：${target}`);
