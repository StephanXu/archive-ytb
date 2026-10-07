import { mkdir, mkdtemp, copyFile, rename, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../server/process.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
if (!npm) throw Error("请通过 npm run bundle 创建分发包");
process.chdir(root);
await runProcess(process.execPath, [npm, "run", "build"], {
  timeout: 180000,
  onLine: (line) => console.log(line),
});
await mkdir(resolve(".qa"), { recursive: true });
await runProcess(
  process.execPath,
  [npm, "pack", "--pack-destination", ".qa", "--json"],
  { timeout: 180000 },
);
// npm pack deliberately excludes package-lock.json. Include it in this local
// deployment archive so the documented npm ci installs the reviewed versions.
const temp = await mkdtemp(resolve(".qa", "bundle-"));
const archive = resolve(".qa/archive-flow-0.2.0.tgz");
try {
  await runProcess("tar", ["-xzf", archive, "-C", temp]);
  await copyFile(
    resolve("package-lock.json"),
    resolve(temp, "package/package-lock.json"),
  );
  await runProcess("tar", ["-czf", archive + ".new", "-C", temp, "package"], {
    timeout: 180000,
  });
  await rename(archive + ".new", archive);
} finally {
  if (dirname(temp) !== resolve(".qa")) throw Error("分发临时目录超出工作区");
  await rm(temp, { recursive: true, force: true });
  await rm(archive + ".new", { force: true });
}
console.log(
  "已生成包含本平台 rclone 二进制的分发包：.qa/archive-flow-0.2.0.tgz",
);
