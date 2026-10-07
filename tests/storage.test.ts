import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { Store } from "../server/store.ts";
import { StorageManager, remotePath } from "../server/storage.ts";
import type {
  BackupConfig,
  StorageSource,
  Settings,
} from "../shared/contracts.ts";

const bv = "BV1abcDEFghi";
async function fixture(nativeRemoteNames = false) {
  const root = await mkdtemp(join(tmpdir(), "archive-storage-"));
  const download = join(root, "downloads"),
    library = join(root, "library");
  await mkdir(download);
  await mkdir(library);
  const store = new Store(join(root, "state"));
  const source: StorageSource = {
    id: "cloud",
    name: "测试云端",
    kind: "rclone",
    root: "qa:",
  };
  store.put("storages", source.id, source);
  const config: BackupConfig = {
    id: "cfg",
    name: "合集",
    storage_name: source.name,
    library_dir: "",
    download_dir: download,
    season_url: "https://space.bilibili.com/1/lists/2",
    cookie_id: "",
    excluded: [],
    after_date: "",
    interval_minutes: 0,
    auto_download: false,
    next_run: null,
  };
  const settings: Settings = {
    download_root: download,
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
  };
  await writeFile(
    join(store.root, "rclone.conf"),
    `[qa]\ntype = alias\nremote = ${nativeRemoteNames ? ":local,encoding=InvalidUtf8:" : ""}${library.replace(/\\/g, "/")}\n`,
  );
  const manager = new StorageManager(store, () => settings, resolve("."));
  return {
    root,
    store,
    manager,
    config,
    download,
    library,
    async close() {
      await manager.rpc.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("bundled rclone SDK lists, uploads, verifies, retrieves and deletes a named remote", async () => {
  const f = await fixture();
  const name = `${bv} 中文 [test].mp4`,
    local = join(f.download, name),
    remote = join(f.library, name);
  try {
    assert(f.manager.binary.startsWith(resolve("bin/rclone")));
    await writeFile(local, "original video");
    const messages: string[] = [];
    const archived = await f.manager.archive(
      f.config,
      f.download,
      bv,
      undefined,
      { message: (m) => messages.push(m) },
    );
    assert.equal(archived.status, "archived");
    assert.equal(await readFile(remote, "utf8"), "original video");
    await assert.rejects(access(local));
    assert(messages.some((m) => m.includes("上传")));
    assert.equal((await f.manager.scan(f.config)).get(bv)?.[0], `qa:${name}`);
    await writeFile(local, "different video");
    await assert.rejects(f.manager.archive(f.config, f.download, bv), /不一致/);
    assert.equal(await readFile(local, "utf8"), "different video");
    await writeFile(local, "original video");
    const duplicate = await f.manager.archive(f.config, f.download, bv);
    assert.equal(duplicate.status, "duplicate");
    await access(local);
    assert.equal(
      (await f.manager.archive(f.config, f.download, bv, duplicate.hash))
        .status,
      "deduplicated",
    );
    const receipt = await f.manager.retrieve(f.config, f.download, bv);
    assert.equal(await readFile(receipt.path, "utf8"), "original video");
    await writeFile(local, "same-name local conflict");
    await assert.rejects(
      f.manager.retrieve(f.config, f.download, bv),
      /不同内容/,
    );
    assert.equal(await readFile(local, "utf8"), "same-name local conflict");
    const identity = await f.manager.identity(f.config, archived.destination);
    await writeFile(remote, "changed remote");
    await assert.rejects(
      f.manager.delete(f.config, archived.destination, identity),
      /变化/,
    );
    const fresh = await f.manager.identity(f.config, archived.destination);
    await f.manager.delete(f.config, archived.destination, fresh);
    assert.equal((await f.manager.scan(f.config)).size, 0);
  } finally {
    await f.close();
  }
});

test("failed upload, failed verification and cancellation preserve the local source", async () => {
  const f = await fixture();
  const local = join(f.download, `${bv}.mp4`);
  try {
    await writeFile(local, "source");
    const execute = f.manager.rpc.execute.bind(f.manager.rpc);
    f.manager.rpc.execute = async (path, body, ctx) => {
      if (path === "/operations/copyfile") throw Error("upload failed");
      return execute(path, body, ctx);
    };
    await assert.rejects(f.manager.archive(f.config, f.download, bv));
    assert.equal(await readFile(local, "utf8"), "source");
    f.manager.rpc.execute = async (path, body, ctx) => {
      if (path === "/operations/hashsum")
        return { hashsum: ["0".repeat(64) + "  name"] };
      return execute(path, body, ctx);
    };
    await assert.rejects(
      f.manager.archive(f.config, f.download, bv),
      /校验失败/,
    );
    assert.equal(await readFile(local, "utf8"), "source");
    f.manager.rpc.execute = execute;
    const duplicate = await f.manager.archive(f.config, f.download, bv);
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      f.manager.archive(f.config, f.download, bv, duplicate.hash, {
        signal: ctl.signal,
      }),
      /取消/,
    );
    assert.equal(await readFile(local, "utf8"), "source");
  } finally {
    await f.close();
  }
});

test("InvalidUtf8 remote encoding preserves native fullwidth punctuation and protects duplicate copies", async () => {
  const f = await fixture(true);
  const name = `[2026-09-23] 风险与机会？中文：标题＊ ＂引用＂ [${bv}].mp4`;
  const local = join(f.download, name),
    remote = join(f.library, name);
  try {
    await writeFile(local, "punctuation video");
    if (process.platform === "win32") {
      // Reproduce the original RC failure using the native name as srcRemote.
      await assert.rejects(
        f.manager.rpc.execute("/operations/copyfile", {
          srcFs: f.download,
          srcRemote: name,
          dstFs: "qa:",
          dstRemote: name,
        }),
        /复制文件失败/,
      );
      await assert.rejects(access(remote));
      assert.equal(await readFile(local, "utf8"), "punctuation video");
    }
    const archived = await f.manager.archive(f.config, f.download, bv);
    assert.equal(archived.status, "archived");
    assert.equal(archived.destination, `qa:${name}`);
    assert.equal(await readFile(remote, "utf8"), "punctuation video");
    await assert.rejects(access(local));
    const fetched = await f.manager.retrieve(f.config, f.download, bv);
    assert.equal(fetched.path, local);
    assert.equal(await readFile(local, "utf8"), "punctuation video");
    await writeFile(local, "changed source");
    await assert.rejects(f.manager.archive(f.config, f.download, bv), /不一致/);
    assert.equal(await readFile(remote, "utf8"), "punctuation video");
    assert.equal(await readFile(local, "utf8"), "changed source");
    await writeFile(local, "punctuation video");
    const duplicate = await f.manager.archive(f.config, f.download, bv);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.destination, archived.destination);
    await access(local);
    assert.equal(
      (await f.manager.archive(f.config, f.download, bv, duplicate.hash))
        .status,
      "deduplicated",
    );
  } finally {
    await f.close();
  }
});

test("existing default-encoded cloud names retain their location and restore valid Windows names", async () => {
  const f = await fixture();
  const name = `旧文件？ [${bv}].mp4`;
  const local = join(f.download, name),
    remote = join(f.library, name);
  try {
    await writeFile(remote, "existing video");
    await writeFile(local, "existing video");
    const duplicate = await f.manager.archive(f.config, f.download, bv);
    assert.equal(duplicate.status, "duplicate");
    if (process.platform === "win32")
      assert(duplicate.destination.includes("?"));
    assert.equal(
      (await f.manager.archive(f.config, f.download, bv, duplicate.hash))
        .status,
      "deduplicated",
    );
    const retrieved = await f.manager.retrieve(f.config, f.download, bv);
    assert.equal(retrieved.path, local);
    assert.equal(await readFile(local, "utf8"), "existing video");
    await writeFile(remote, "different video");
    await assert.rejects(f.manager.archive(f.config, f.download, bv), /不一致/);
    assert.equal(await readFile(local, "utf8"), "existing video");
  } finally {
    await f.close();
  }
});

test("cloud archive templates use publication dates and continue indexing existing nested copies", async () => {
  const f = await fixture();
  const cases = [
    ["{{YYYY}}/{{MM}}/", "2026/08", "BV1abcDEFghi"],
    ["{{YYYY}}-{{MM}}/", "2026-08", "BV1xyzABCdef"],
    ["{{YYYY}}/", "2026", "BV1jklMNOpqr"],
  ] as const;
  try {
    f.store.put("snapshots", f.config.id, {
      items: cases.map(([, , bv]) => ({ bv, date: "2026-08-01" })),
    });
    for (const [template, folder, bv] of cases) {
      const c = { ...f.config, directory_template: template };
      const name = `${bv}.mp4`;
      await writeFile(join(f.download, name), "video");
      const result = await f.manager.archive(c, f.download, bv);
      assert.equal(result.destination, `qa:${folder}/${name}`);
      assert.equal(
        await readFile(join(f.library, folder, name), "utf8"),
        "video",
      );
      assert.equal((await f.manager.scan(c)).get(bv)?.[0], result.destination);
      await writeFile(join(f.download, name), "video");
      const duplicate = await f.manager.archive(
        { ...c, directory_template: "" },
        f.download,
        bv,
      );
      assert.equal(duplicate.status, "duplicate");
      assert.equal(duplicate.destination, result.destination);
    }
    const undated = "BV1pqrSTUvwx.mp4";
    await writeFile(join(f.download, undated), "undated-video");
    const unknown = await f.manager.archive(
      { ...f.config, directory_template: "{{YYYY}}/{{MM}}/" },
      f.download,
      "BV1pqrSTUvwx",
    );
    assert.equal(unknown.destination, `qa:${undated}`);
  } finally {
    await f.close();
  }
});

test("rclone failure preserves the backend reason and operation stage", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.manager.rpc.execute("/operations/list", {
        fs: "missing-fixture:",
        remote: "",
        opt: { recurse: true },
      }),
      (error: unknown) => {
        const e = error as {
          code?: string;
          message?: string;
          details?: string;
        };
        assert.equal(e.code, "STORAGE_FAILED");
        assert(e.message?.includes("读取文件列表"));
        assert(e.details?.includes("missing-fixture"));
        assert(/config|section/i.test(e.details || ""));
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("legacy paths migrate idempotently to shared named local sources", async () => {
  const f = await fixture();
  try {
    f.store.put("configs", "one", {
      ...f.config,
      id: "one",
      name: "合集一",
      storage_name: "",
      library_dir: f.library,
    });
    f.store.put("configs", "two", {
      ...f.config,
      id: "two",
      name: "合集二",
      storage_name: "",
      library_dir: f.library,
    });
    f.manager.migrate();
    f.manager.migrate();
    const one = f.store.get<BackupConfig>("configs", "one")!,
      two = f.store.get<BackupConfig>("configs", "two")!;
    assert(one.storage_name);
    assert.equal(one.storage_name, two.storage_name);
    assert.equal(one.library_dir, "");
    assert.equal(
      f.store.all<StorageSource>("storages").filter((s) => s.kind === "local")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("remote paths preserve remote syntax and reject traversal, absolute paths and drive letters", () => {
  assert.equal(
    remotePath("onedrive:视频存档", "合集/a.mp4"),
    "onedrive:视频存档/合集/a.mp4",
  );
  assert.equal(remotePath("onedrive:", "a.mp4"), "onedrive:a.mp4");
  for (const path of ["../x.mp4", "/x.mp4", "a/../x", "a\\x", "a\nx", "a//x"])
    assert.throws(() => remotePath("onedrive:", path));
  assert.throws(() => remotePath("D:\\videos"));
});

test("SDK cancellation stops an active RC transfer and closing releases the bundled daemon", async () => {
  const f = await fixture();
  const source = join(f.download, "slow.bin"),
    bytes = Buffer.alloc(8 * 1024 * 1024, 1);
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Length": bytes.length,
      "Last-Modified": "Thu, 08 Oct 2026 00:00:00 GMT",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    let offset = 0;
    const timer = setInterval(() => {
      res.write(bytes.subarray(offset, offset + 16384));
      offset += 16384;
      if (offset >= bytes.length) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    res.on("close", () => clearInterval(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await writeFile(source, bytes);
    await writeFile(
      join(f.store.root, "rclone.conf"),
      `[slow]\ntype = http\nurl = http://127.0.0.1:${port}/\n[qa]\ntype = alias\nremote = ${f.library.replace(/\\/g, "/")}\n`,
    );
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      await assert.rejects(
        f.manager.rpc.execute(
          "/operations/copyfile",
          {
            srcFs: "slow:",
            srcRemote: "slow.bin",
            dstFs: "qa:",
            dstRemote: "slow.bin",
          },
          { signal: ctl.signal },
        ),
        /取消/,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.equal((await readFile(source)).length, 8 * 1024 * 1024);
    const child = f.manager.rpc.child;
    assert(child?.pid);
    await f.manager.rpc.close();
    assert(child.exitCode !== null || child.signalCode !== null);
    assert.equal(
      (await f.manager.scan(f.config)).size,
      0,
      "later operations start a fresh daemon",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
