import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import type { BackupConfig, CookieSource } from "../shared/contracts.ts";

const content =
  "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tportable_fixture\n";
const settings = {
  download_root: "./downloads",
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};
const cookie = {
  id: "account",
  name: "账号",
  kind: "upload",
  path: "",
  content,
  browser: "chrome",
  profile: "",
};
const config = {
  id: "collection",
  name: "合集",
  season_url: "https://space.bilibili.com/123/lists/456",
  cookie_id: "account",
  storage_name: "视频库",
  library_dir: "",
  download_dir: "./staging",
  after_date: "",
  interval_minutes: 5,
  auto_download: false,
  excluded: ["BV1abcDEFghi"],
};
const document = {
  version: 1,
  settings,
  cookies: [cookie],
  configs: [config],
  storages: [
    { id: "library", name: "视频库", kind: "local", root: "./videos" },
  ],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "archive-config-"));
  const path = join(root, "config.toml");
  await writeFile(path, stringify(document));
  const store = new Store(join(root, "cache"), path);
  return {
    root,
    path,
    store,
    async close() {
      this.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a single TOML restores definitions, exclusions and managed credentials with an empty database", async () => {
  const f = await fixture();
  const destination = join(f.root, "moved");
  await mkdir(destination);
  await copyFile(f.path, join(destination, "config.toml"));
  const moved = new Store(
    join(destination, "cache"),
    join(destination, "config.toml"),
  );
  try {
    const c = moved.get<BackupConfig>("configs", config.id)!;
    assert.deepEqual(c.excluded, config.excluded);
    assert.equal(c.download_dir, join(destination, "staging"));
    assert.equal(c.cookie_id, cookie.id);
    assert.equal(
      moved.get<{ root: string }>("storages", "library")!.root,
      join(destination, "videos"),
    );
    const credentials = moved.get<CookieSource>("cookies", cookie.id)!;
    assert.equal(await readFile(credentials.path, "utf8"), content);
    assert.equal(credentials.status, "未验证");
    assert(!JSON.stringify(credentials).includes("portable_fixture"));
    assert.equal(moved.all("jobs").length, 0);
    assert.equal(moved.all("snapshots").length, 0);
    assert(c.next_run! > Date.now() / 1000);
  } finally {
    moved.close();
    await f.close();
  }
});

test("runtime status and schedule writes leave TOML and relative paths unchanged", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.path, "utf8");
    const c = f.store.get<BackupConfig>("configs", config.id)!;
    f.store.put("configs", c.id, { ...c, next_run: 123 });
    const k = f.store.get<CookieSource>("cookies", cookie.id)!;
    f.store.put("cookies", k.id, { ...k, status: "可用", checked_at: 456 });
    f.store.put("jobs", "job", { status: "completed" });
    assert.equal(await readFile(f.path, "utf8"), original);
    assert.equal(f.store.get<BackupConfig>("configs", c.id)!.next_run, 123);
    assert.equal(f.store.get<CookieSource>("cookies", k.id)!.status, "可用");
    assert.equal(
      (
        f.store.db
          .prepare(
            "SELECT count(*) AS n FROM documents WHERE kind IN ('settings','cookies','configs','storages')",
          )
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("validation updates preserve relative external Cookie references without rewriting TOML", async () => {
  const f = await fixture();
  try {
    f.store.close();
    await writeFile(
      f.path,
      stringify({
        ...document,
        cookies: [
          { ...cookie, kind: "file", path: "./external.txt", content: "" },
        ],
      }),
    );
    f.store = new Store(join(f.root, "cache"), f.path);
    const original = await readFile(f.path, "utf8");
    const c = f.store.get<CookieSource>("cookies", cookie.id)!;
    assert.equal(c.path, join(f.root, "external.txt"));
    f.store.put("cookies", c.id, { ...c, status: "验证失败", hint: "fixture" });
    assert.equal(await readFile(f.path, "utf8"), original);
  } finally {
    await f.close();
  }
});

test("mixed config/cache transactions publish once and roll back together on failure", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.path, "utf8");
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.put("configs", config.id, {
            ...f.store.get<BackupConfig>("configs", config.id)!,
            name: "修改",
          });
          f.store.put("snapshots", config.id, { id: "new" });
          throw Error("fixture failure");
        }),
      /fixture failure/,
    );
    assert.equal(await readFile(f.path, "utf8"), original);
    assert.equal(f.store.get<BackupConfig>("configs", config.id)!.name, "合集");
    assert.equal(f.store.get("snapshots", config.id), undefined);
    f.store.transaction(() => {
      f.store.put("storages", "library", {
        id: "library",
        name: "新视频库",
        kind: "local",
        root: "./videos",
      });
      f.store.put("configs", config.id, {
        ...f.store.get<BackupConfig>("configs", config.id)!,
        storage_name: "新视频库",
      });
    });
    const saved = parse(await readFile(f.path, "utf8")) as typeof document;
    assert.equal(saved.configs[0].storage_name, saved.storages[0].name);
  } finally {
    await f.close();
  }
});

test("external edits cause a conflict without overwriting the file or committing cached state", async () => {
  const f = await fixture();
  try {
    const external = stringify({
      ...document,
      settings: { ...settings, download_root: "./other" },
    });
    await writeFile(f.path, external);
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.put("jobs", "job", { status: "queued" });
          f.store.put("configs", config.id, {
            ...f.store.get<BackupConfig>("configs", config.id)!,
            name: "界面修改",
          });
        }),
      /外部修改/,
    );
    assert.equal(await readFile(f.path, "utf8"), external);
    assert.equal(f.store.get("jobs", "job"), undefined);
    assert.equal(f.store.get<BackupConfig>("configs", config.id)!.name, "合集");
  } finally {
    await f.close();
  }
});

test("restart preserves snapshots for a name edit and invalidates them for a source edit", async () => {
  const f = await fixture();
  try {
    f.store.put("snapshots", config.id, { id: "cached" });
    f.store.close();
    await writeFile(
      f.path,
      stringify({ ...document, configs: [{ ...config, name: "改名" }] }),
    );
    f.store = new Store(join(f.root, "cache"), f.path);
    assert.equal(
      f.store.get<{ id: string }>("snapshots", config.id)!.id,
      "cached",
    );
    f.store.close();
    await writeFile(
      f.path,
      stringify({
        ...document,
        configs: [
          { ...config, season_url: "https://space.bilibili.com/123/lists/789" },
        ],
      }),
    );
    f.store = new Store(join(f.root, "cache"), f.path);
    assert.equal(f.store.get("snapshots", config.id), undefined);
  } finally {
    await f.close();
  }
});

test("SQLite migration embeds uploaded Cookie content and preserves caches and runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-config-migrate-"));
  const db = new Database(join(root, "archive-flow.sqlite3"));
  const oldCookie = join(root, "old-cookie.txt");
  await writeFile(oldCookie, content);
  db.exec(
    "CREATE TABLE documents(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
  );
  const insert = db.prepare("INSERT INTO documents VALUES(?,?,?)");
  for (const [kind, id, body] of [
    [
      "settings",
      "global",
      { ...settings, download_root: join(root, "downloads") },
    ],
    [
      "cookies",
      cookie.id,
      {
        ...cookie,
        content: undefined,
        path: oldCookie,
        status: "可用",
        checked_at: 42,
      },
    ],
    ["storages", "library", document.storages[0]],
    ["configs", config.id, { ...config, next_run: 123 }],
    ["snapshots", config.id, { id: "preserved" }],
    ["receipts", "receipt", { verified: true }],
  ] as const)
    insert.run(kind, id, JSON.stringify(body));
  db.close();
  const store = new Store(root);
  try {
    const saved = parse(
      await readFile(join(root, "config.toml"), "utf8"),
    ) as typeof document;
    assert.equal(saved.cookies[0].content, content);
    assert.equal(saved.cookies[0].path, "");
    assert(!("next_run" in saved.configs[0]));
    assert(!("status" in saved.cookies[0]));
    assert.equal(store.get<BackupConfig>("configs", config.id)!.next_run, 123);
    assert.equal(store.get<CookieSource>("cookies", cookie.id)!.status, "可用");
    assert.equal(
      store.get<{ id: string }>("snapshots", config.id)!.id,
      "preserved",
    );
    assert.equal(
      store.get<{ verified: boolean }>("receipts", "receipt")!.verified,
      true,
    );
    assert.equal(store.all("configs").length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing managed credentials abort migration without deleting SQLite definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-failed-migration-"));
  const path = join(root, "archive-flow.sqlite3");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE documents(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
  );
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run(
    "cookies",
    cookie.id,
    JSON.stringify({
      ...cookie,
      content: undefined,
      path: join(root, "absent.txt"),
      status: "可用",
    }),
  );
  db.close();
  try {
    assert.throws(() => new Store(root), /ENOENT/);
    const verify = new Database(path, { readonly: true });
    try {
      assert.equal(
        (
          verify
            .prepare("SELECT count(*) AS n FROM documents WHERE kind='cookies'")
            .get() as { n: number }
        ).n,
        1,
      );
      assert.equal(
        (
          verify
            .prepare(
              "SELECT count(*) AS n FROM documents WHERE kind='cookie_runtime'",
            )
            .get() as { n: number }
        ).n,
        0,
      );
    } finally {
      verify.close();
    }
    await assert.rejects(readFile(join(root, "config.toml")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid TOML, versions and references fail closed without exposing secrets or replacing the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-invalid-config-"));
  const path = join(root, "config.toml");
  try {
    for (const text of [
      "secret = SECRET_FIXTURE",
      stringify({ ...document, version: 2 }),
      stringify({ ...document, configs: [{ ...config, cookie_id: "absent" }] }),
      stringify({ ...document, cookies: [{ ...cookie, id: "../escape" }] }),
    ]) {
      await writeFile(path, text);
      assert.throws(
        () => new Store(join(root, "cache"), path),
        (e) => !String(e).includes("SECRET_FIXTURE"),
      );
      assert.equal(await readFile(path, "utf8"), text);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing project config with an empty cache never reimports legacy definitions", async () => {
  const f = await fixture();
  const legacy = join(f.root, "legacy.toml");
  await writeFile(
    legacy,
    "[[tasks]]\nname='legacy'\nseason_url='https://space.bilibili.com/1/lists/2'\nlibrary_dir='library'\n",
  );
  const { store, engine } = createApp({
    root: process.cwd(),
    stateDir: join(f.root, "new-cache"),
    configPath: f.path,
    legacy,
  });
  try {
    assert.deepEqual(
      store.all<BackupConfig>("configs").map((c) => c.id),
      [config.id],
    );
    assert(!JSON.stringify(store.all("cookies")).includes("portable_fixture"));
  } finally {
    await engine.close();
    store.close();
    await f.close();
  }
});
