import { basename, dirname, join, extname } from "node:path";
import {
  mkdir,
  mkdtemp,
  rm,
  link,
  unlink,
  lstat,
  copyFile,
  readdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  BackupConfig,
  Settings,
  StorageSource,
  Snapshot,
} from "../shared/contracts.ts";
import type { Store } from "./store.ts";
import { expandPath, scanMedia, normalizeBV } from "./paths.ts";
import { archiveFile, hashFile, fileIdentity } from "./file-actions.ts";
import { TaskError } from "./process.ts";
import { RcloneClient, type TransferContext } from "./rclone-client.ts";
import { mediaSubdirectory } from "./media-layout.ts";

type RemoteEntry = {
  Path: string;
  Size: number;
  ModTime: string;
  IsDir: boolean;
  ID?: string;
};
type Context = TransferContext;
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

export function remotePath(root: string, path = "") {
  if (!/^[\w .-]+:/.test(root) || /^[a-z]:[\\/]/i.test(root))
    throw new TaskError(
      "VALIDATION",
      "云端路径应为 rclone远端名:目录，例如 onedrive:视频存档",
    );
  if (
    path &&
    (path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      /[\x00-\x1f]/.test(path))
  )
    throw new TaskError("CONFLICT", "云端返回了无效文件路径");
  return (
    root.replace(/\/+$/, "") +
    (path ? (root.endsWith(":") ? "" : "/") + path : "")
  );
}

export class StorageManager {
  binary: string;
  rpc: RcloneClient;
  constructor(
    public store: Store,
    private settings: () => Settings,
    root: string,
  ) {
    this.binary = join(
      root,
      "bin",
      "rclone",
      process.platform === "win32" ? "rclone.exe" : "rclone",
    );
    this.rpc = new RcloneClient(this.binary, () =>
      this.settings().rclone_config
        ? expandPath(this.settings().rclone_config!)
        : join(dirname(this.store.configuration.path), "rclone.conf"),
    );
  }
  resolve(c: BackupConfig): StorageSource | undefined {
    if (c.storage_name) {
      const source = this.store
        .all<StorageSource>("storages")
        .find((s) => s.name === c.storage_name);
      if (!source)
        throw new TaskError("VALIDATION", `存储源「${c.storage_name}」不存在`);
      return source;
    }
    // Compatibility for callers importing old configs while the service is running.
    if (c.library_dir)
      return {
        id: "legacy",
        name: "原存档目录",
        kind: "local",
        root: expandPath(c.library_dir),
      };
  }
  migrate() {
    this.store.transaction(() => {
      for (const c of this.store.all<BackupConfig>("configs")) {
        if (c.storage_name || !c.library_dir) continue;
        const root = expandPath(c.library_dir);
        let source = this.store
          .all<StorageSource>("storages")
          .find((s) => s.kind === "local" && s.root === root);
        if (!source) {
          const names = new Set(
            this.store.all<StorageSource>("storages").map((s) => s.name),
          );
          const base = `${c.name} 存档`.slice(0, 90);
          let name = base,
            n = 2;
          while (names.has(name)) name = `${base} ${n++}`;
          source = { id: randomUUID(), name, kind: "local", root };
          this.store.put("storages", source.id, source);
        }
        this.store.put("configs", c.id, {
          ...c,
          library_dir: "",
          storage_name: source.name,
        });
      }
    });
  }
  async entries(s: StorageSource, ctx: Context = {}) {
    const output = (await this.rpc.execute(
      "/operations/list",
      { fs: remotePath(s.root), remote: "", opt: { recurse: true } },
      ctx,
    )) as { list: unknown };
    const rows = output.list;
    if (!Array.isArray(rows))
      throw new TaskError("CONFLICT", "云端文件列表无效");
    return rows.map((row: RemoteEntry) => {
      remotePath(s.root, row.Path);
      if (
        typeof row.IsDir !== "boolean" ||
        typeof row.Size !== "number" ||
        typeof row.ModTime !== "string"
      )
        throw new TaskError("CONFLICT", "云端文件列表无效");
      return row;
    });
  }
  async scan(c: BackupConfig, ctx: Context = {}) {
    const s = this.resolve(c);
    if (!s) return new Map<string, string[]>();
    if (s.kind === "local") return scanMedia(expandPath(s.root), true);
    const result = new Map<string, string[]>();
    for (const e of await this.entries(s, ctx)) {
      if (
        e.IsDir ||
        !media.has(extname(e.Path).toLowerCase()) ||
        /\.f\d+\./.test(e.Path)
      )
        continue;
      const bv = normalizeBV(basename(e.Path));
      if (bv)
        result.set(bv, [...(result.get(bv) || []), remotePath(s.root, e.Path)]);
    }
    return result;
  }
  async remoteHash(path: string, ctx: Context = {}) {
    const output = (await this.rpc.execute(
      "/operations/hashsum",
      { fs: path, hashType: "SHA256", download: true, base64: false },
      ctx,
    )) as { hashsum: string[] };
    const lines = output.hashsum;
    if (lines.length !== 1 || !/^[a-f0-9]{64}\s+/.test(lines[0]))
      throw new TaskError("CONFLICT", "无法核验云端文件内容");
    return lines[0].slice(0, 64);
  }
  async archive(
    c: BackupConfig,
    download: string,
    bv: string,
    confirmedHash?: string,
    ctx: Context = {},
  ) {
    const s = this.resolve(c);
    if (!s) throw new TaskError("VALIDATION", "请先选择存储源");
    const files = (await scanMedia(download)).get(bv) || [];
    if (files.length !== 1)
      throw new TaskError(
        "CONFLICT",
        files.length
          ? "找到多个下载文件，请先整理"
          : "未找到下载文件，请刷新列表",
      );
    const source = files[0];
    const date =
      this.store
        .get<Snapshot>("snapshots", c.id)
        ?.items.find((i) => i.bv === bv)?.date ||
      this.store.get<{ date?: string }>("receipts", `${c.id}:${bv}`)?.date ||
      basename(source).match(/^\[(\d{4}-\d{2}-\d{2})\]/)?.[1];
    const subdirectory = mediaSubdirectory(c.directory_template, date);
    if (s.kind === "local")
      return archiveFile(
        download,
        expandPath(s.root),
        bv,
        confirmedHash,
        subdirectory,
      );
    const identity = await fileIdentity(source);
    const hash = await hashFile(source);
    // Explicit local Raw encoding preserves native fullwidth punctuation.
    // The destination remote retains the user's own encoding configuration.
    const src = this.parts(source);
    const collisions = (await this.entries(s, ctx)).filter(
      (e) =>
        basename(e.Path).toLowerCase() === src.remote.toLowerCase() ||
        normalizeBV(basename(e.Path)) === bv,
    );
    if (collisions.length > 1 || collisions.some((e) => e.IsDir))
      throw new TaskError(
        "CONFLICT",
        "存储源有多个同名项目或同名目录，请先整理",
      );
    const destination = remotePath(
      s.root,
      collisions[0]?.Path ||
        (subdirectory ? `${subdirectory}/` : "") + src.remote,
    );
    if (collisions.length) {
      ctx.message?.("核验云端重复文件");
      if ((await this.remoteHash(destination, ctx)) !== hash)
        throw new TaskError(
          "CONFLICT",
          "同名文件 SHA-256 不一致，已保留两份文件",
        );
      if (!confirmedHash)
        return { status: "duplicate" as const, source, destination, hash };
      if (confirmedHash !== hash)
        throw new TaskError("CONFLICT", "文件已变化，请重新确认");
    } else {
      if (confirmedHash)
        throw new TaskError("CONFLICT", "原存档文件已变化，请重新存档");
      ctx.message?.(`上传到「${s.name}」`);
      await this.copy(src, destination, ctx, true);
      ctx.message?.("读取云端内容并校验");
      if ((await this.remoteHash(destination, ctx)) !== hash)
        throw new TaskError("CONFLICT", "云端内容校验失败，已保留本地文件");
    }
    if (ctx.signal?.aborted)
      throw new TaskError("CANCELLED", "任务已取消，本地副本已保留");
    if (
      (await fileIdentity(source)) !== identity ||
      (await hashFile(source)) !== hash
    )
      throw new TaskError("CONFLICT", "上传期间本地文件已变化，已保留本地副本");
    this.store.put("cloud_receipts", `${s.id}:${bv}`, {
      path: destination,
      hash,
    });
    await unlink(source);
    return {
      status: collisions.length
        ? ("deduplicated" as const)
        : ("archived" as const),
      source,
      destination,
      hash,
    };
  }
  async retrieve(
    c: BackupConfig,
    download: string,
    bv: string,
    ctx: Context = {},
  ) {
    const s = this.resolve(c);
    if (!s || s.kind !== "rclone")
      throw new TaskError("VALIDATION", "取回操作需要云端存储源");
    const files = (await this.scan(c, ctx)).get(bv) || [];
    if (files.length !== 1)
      throw new TaskError("CONFLICT", "云端没有唯一的对应视频，请先刷新或整理");
    const source = files[0],
      name = this.parts(source).remote;
    await mkdir(download, { recursive: true });
    const folder = await mkdtemp(join(download, ".retrieve-"));
    try {
      ctx.message?.(`从「${s.name}」取回`);
      // Preserve native-compatible names. Existing remotes may expose ASCII
      // Windows-restricted characters; only those need local default encoding.
      const needsConversion =
        process.platform === "win32" &&
        /[<>:"/\\|?*\x00-\x1f]|[ .]$/.test(name);
      await this.copy(
        source,
        {
          fs: needsConversion ? folder : this.localFs(folder),
          remote: name,
        },
        ctx,
      );
      const created = await readdir(folder, { withFileTypes: true });
      if (created.length !== 1 || !created[0].isFile())
        throw new TaskError(
          "CONFLICT",
          "取回文件名无法安全解析，云端副本已保留",
        );
      const temp = join(folder, created[0].name);
      const destination = join(download, created[0].name);
      const hash = await hashFile(temp);
      const receipt = this.store.get<{ path: string; hash: string }>(
        "cloud_receipts",
        `${s.id}:${bv}`,
      );
      ctx.message?.("校验取回的文件");
      const expected =
        receipt?.path === source
          ? receipt.hash
          : await this.remoteHash(source, ctx);
      if (hash !== expected)
        throw new TaskError("CONFLICT", "取回文件校验失败，云端副本已保留");
      if (ctx.signal?.aborted) throw new TaskError("CANCELLED", "任务已取消");
      try {
        await link(temp, destination);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (
          ["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
            code || "",
          )
        ) {
          try {
            await copyFile(temp, destination, constants.COPYFILE_EXCL);
          } catch (copyError) {
            if ((copyError as NodeJS.ErrnoException).code !== "EEXIST")
              throw copyError;
          }
        } else if (code !== "EEXIST") throw e;
        if (
          !(await lstat(destination)).isFile() ||
          (await hashFile(destination)) !== hash
        )
          throw new TaskError(
            "CONFLICT",
            "本地已有不同内容的同名文件，已停止取回",
          );
      }
      return { path: destination, hash, source };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  async identity(c: BackupConfig, path: string) {
    const s = this.resolve(c);
    if (!s || s.kind === "local") return fileIdentity(path);
    const entry = (await this.entries(s)).find(
      (e) => remotePath(s.root, e.Path) === path && !e.IsDir,
    );
    if (!entry) throw new TaskError("CONFLICT", "云端文件已变化，请重新确认");
    return JSON.stringify([entry.ID, entry.Size, entry.ModTime]);
  }
  async delete(c: BackupConfig, path: string, identity: string) {
    const s = this.resolve(c);
    if (
      s?.kind === "rclone" &&
      path.startsWith(remotePath(s.root) + (s.root.endsWith(":") ? "" : "/"))
    ) {
      if ((await this.identity(c, path)) !== identity)
        throw new TaskError("CONFLICT", "云端文件已变化，请重新确认删除");
      const parts = this.parts(path);
      await this.rpc.execute("/operations/deletefile", {
        fs: parts.fs,
        remote: parts.remote,
      });
      const bv = normalizeBV(parts.remote),
        key = `${s.id}:${bv}`;
      if (
        this.store.get<{ path: string }>("cloud_receipts", key)?.path === path
      )
        this.store.delete("cloud_receipts", key);
    } else {
      if ((await fileIdentity(path)) !== identity)
        throw new TaskError("CONFLICT", "文件已变化，请重新确认删除");
      await unlink(path);
    }
  }
  localRoot(c: BackupConfig) {
    const s = this.resolve(c);
    return s?.kind === "local" ? expandPath(s.root) : "";
  }
  private localFs(folder: string) {
    return `:local,encoding=Raw:${folder}`;
  }
  private parts(path: string) {
    if (/^[\w .-]+:/.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
      const slash = path.lastIndexOf("/"),
        colon = path.indexOf(":");
      return slash > colon
        ? { fs: path.slice(0, slash), remote: path.slice(slash + 1) }
        : { fs: path.slice(0, colon + 1), remote: path.slice(colon + 1) };
    }
    return { fs: this.localFs(dirname(path)), remote: basename(path) };
  }
  private async copy(
    source: string | { fs: string; remote: string },
    destination: string | { fs: string; remote: string },
    ctx: Context,
    immutable = false,
  ) {
    const src = typeof source === "string" ? this.parts(source) : source,
      dst =
        typeof destination === "string" ? this.parts(destination) : destination;
    await this.rpc.execute(
      "/operations/copyfile",
      {
        srcFs: src.fs,
        srcRemote: src.remote,
        dstFs: dst.fs,
        dstRemote: dst.remote,
        _config: { Immutable: immutable },
      },
      ctx,
    );
  }
}
