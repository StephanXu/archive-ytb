import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFile } from "../server/file-actions.ts";

test("archive moves without overwrite, compares nested names, and rechecks deletion confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-files-"));
  const download = join(root, "download"),
    library = join(root, "library");
  await mkdir(download);
  await mkdir(library);
  const bv = "BV1abcDEFghi",
    name = `${bv} title.mp4`;
  const source = join(download, name),
    destination = join(library, name);
  try {
    await writeFile(source, "video");
    const original = await stat(source);
    const moved = await archiveFile(download, library, bv);
    assert.equal(moved.status, "archived");
    assert.equal(
      (await stat(destination)).ino,
      original.ino,
      "same-volume move preserves the file identity",
    );
    await assert.rejects(access(source));
    assert.equal(await readFile(destination, "utf8"), "video");
    await writeFile(source, "different");
    await assert.rejects(archiveFile(download, library, bv), /不一致/);
    assert.equal(await readFile(source, "utf8"), "different");
    assert.equal(await readFile(destination, "utf8"), "video");
    await writeFile(source, "video");
    const duplicate = await archiveFile(download, library, bv);
    assert.equal(duplicate.status, "duplicate");
    await access(source);
    await writeFile(destination, "changed");
    await assert.rejects(
      archiveFile(download, library, bv, duplicate.hash),
      /不一致/,
    );
    await access(source);
    await writeFile(destination, "video");
    assert.equal(
      (await archiveFile(download, library, bv, duplicate.hash)).status,
      "deduplicated",
    );
    await assert.rejects(access(source));
    await mkdir(join(library, "nested"));
    await rm(destination);
    await writeFile(join(library, "nested", name), "video");
    await writeFile(source, "video");
    assert.equal(
      (await archiveFile(download, library, bv)).status,
      "duplicate",
    );
    await assert.rejects(archiveFile(download, download, bv), /互相包含/);
    await writeFile(join(download, `${bv} second.mkv`), "video");
    await assert.rejects(archiveFile(download, library, bv), /多个下载文件/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive API updates snapshot and receipt and rejects missing local files", async () => {
  const { createApp } = await import("../server/app.ts");
  const root = await mkdtemp(join(tmpdir(), "archive-route-"));
  const download = join(root, "download"),
    library = join(root, "library");
  await mkdir(download);
  await mkdir(library);
  const opened: string[] = [];
  const { app, store, engine } = createApp({
    openPath: async (path) => {
      opened.push(path);
    },
    root: process.cwd(),
    stateDir: join(root, "state"),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const bv = "BV1abcDEFghi",
    path = join(download, `${bv}.mp4`);
  const config = {
    id: "test",
    name: "test",
    library_dir: library,
    download_dir: download,
    excluded: [],
    after_date: "",
  };
  store.put("configs", "test", config);
  store.put("snapshots", "test", {
    id: "before",
    refreshed_at: 1,
    items: [{ bv, base_status: "staged" }],
  });
  store.put("receipts", `test:${bv}`, { bv, path });
  await writeFile(path, "video");
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/configs/test/archive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Backup-Request": "1",
        },
        body: JSON.stringify({ bv }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "archived");
    assert.equal(engine.diff(engine.config("test"))[0].base_status, "archived");
    assert.equal(
      store.get<{ path: string }>("receipts", `test:${bv}`)?.path,
      join(library, `${bv}.mp4`),
    );
    const missing = await fetch(
      `http://127.0.0.1:${port}/api/configs/test/open-file`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Backup-Request": "1",
        },
        body: JSON.stringify({ bv: "BV1jklMNOpqr" }),
      },
    );
    assert.equal(missing.status, 409);
    const recorded = join(download, "recorded-name.mp4");
    await writeFile(recorded, "video");
    store.put("receipts", "test:BV1jklMNOpqr", { path: recorded });
    const playback = await fetch(
      `http://127.0.0.1:${port}/api/configs/test/open-file`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Backup-Request": "1",
        },
        body: JSON.stringify({ bv: "BV1jklMNOpqr" }),
      },
    );
    assert.equal(playback.status, 200);
    assert.deepEqual(
      opened,
      [recorded],
      "recorded path resolves without depending on filename scanning",
    );

    const post = async (route: string, body: unknown, method = "POST") => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/configs/test/${route}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Backup-Request": "1",
          },
          body: JSON.stringify(body),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    assert.equal(
      (await post("excluded", { excluded: [bv] }, "PUT")).status,
      409,
    );
    const preview = await post("delete-file", { bv });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.files, [join(library, `${bv}.mp4`)]);
    await access(join(library, `${bv}.mp4`));
    assert.equal(
      (await post("delete-file", { bv, confirmation: "invalid" })).status,
      409,
    );
    await writeFile(join(library, `${bv}.mp4`), "changed");
    assert.equal(
      (
        await post("delete-file", {
          bv,
          confirmation: preview.body.confirmation,
        })
      ).status,
      409,
    );
    await access(join(library, `${bv}.mp4`));
    const fresh = await post("delete-file", { bv });
    assert.equal(
      (await post("delete-file", { bv, confirmation: fresh.body.confirmation }))
        .status,
      200,
    );
    await assert.rejects(access(join(library, `${bv}.mp4`)));
    assert.equal(engine.diff(engine.config("test"))[0].base_status, "missing");
    assert.equal(store.get("receipts", `test:${bv}`), undefined);
    assert.equal(
      (await post("excluded", { excluded: [bv] }, "PUT")).status,
      200,
    );
    assert.equal(engine.diff(engine.config("test"))[0].status, "excluded");
  } finally {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
