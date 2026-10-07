import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { createApp } from "./app.ts";

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  import.meta.url.endsWith(".ts") ? ".." : "../..",
);
const host = process.env.BACKUP_HOST || "127.0.0.1",
  port = Number(process.env.PORT || 8765),
  token = process.env.BACKUP_TOKEN || "";
if (!["127.0.0.1", "localhost", "::1"].includes(host) && token.length < 24)
  throw Error(
    "远程监听需设置至少 24 字符 BACKUP_TOKEN，并通过 HTTPS 反向代理访问",
  );
const stateDir = resolve(
  process.env.BACKUP_STATE_DIR || resolve(root, "state"),
);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const lock = resolve(stateDir, "server.pid");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") alive = true;
  }
  if (alive) throw Error("该数据目录已有运行中的服务");
  unlinkSync(lock);
}
const fd = openSync(lock, "wx", 0o600);
writeFileSync(fd, String(process.pid));
closeSync(fd);
const release = () => {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
  } catch {}
};
process.once("exit", release);
const { app, engine, store } = createApp({
  root,
  stateDir,
  configPath: process.env.BACKUP_CONFIG_FILE,
  legacy: resolve(root, "legacy/config.toml"),
  token,
});
const server = app.listen(port, host, () => {
  engine.start();
  console.log(`Archive Flow: http://${host}:${port}`);
});
server.on("error", (error) => {
  console.error(error.message);
  release();
  process.exit(1);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await engine.close();
  store.close();
  release();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
