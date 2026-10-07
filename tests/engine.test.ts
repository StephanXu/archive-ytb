import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import { Downloader, type Plan } from "../server/downloader.ts";
import { TaskError } from "../server/process.ts";
import type {
  BackupConfig,
  CookieSource,
  Snapshot,
  Job,
  Settings,
} from "../shared/contracts.ts";

const first = "BV1abcDEFghi",
  second = "BV1jklMNOpqr";
class FakeDownloader extends Downloader {
  planned: string[] = [];
  downloaded: string[] = [];
  failFirst = "";
  refreshes = 0;
  override async withCookie<T>(
    _source: CookieSource,
    folder: string,
    _signal: AbortSignal,
    fn: (path: string) => Promise<T>,
  ) {
    const path = join(folder, "fixture.txt");
    await writeFile(
      path,
      "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tTEST_FIXTURE_ONLY\n",
    );
    return fn(path);
  }
  override async playlist() {
    this.refreshes++;
    return {
      entries: [
        { id: first, title: "first", upload_date: "20260801" },
        { id: second, title: "second", upload_date: "20260802" },
      ],
    };
  }
  override async plan(_cookie: string, bv: string) {
    this.planned.push(bv);
    if (bv === first && this.failFirst)
      throw new TaskError(this.failFirst, this.failFirst);
    return {
      bv,
      title: bv,
      date: bv === first ? "2026-08-01" : "2026-08-02",
      format: "100024+30280",
      width: 1280,
      height: 634,
    };
  }
  override async verify(): Promise<never> {
    throw new TaskError("QUALITY_MISMATCH", "低画质");
  }
  override async download(_cookie: string, dir: string, plan: Plan) {
    this.downloaded.push(plan.bv);
    const path = join(dir, `[${plan.date}] title [${plan.bv}].mp4`);
    await writeFile(path, "TEST_MEDIA");
    return { path, size: 10, mtime: 1, width: 1280, height: 634 };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "archive-engine-"));
  const store = new Store(join(root, "state"));
  const downloader = new FakeDownloader(root),
    engine = new Engine(store, downloader);
  const cfg: BackupConfig = {
    id: "cfg",
    name: "test",
    season_url: "https://space.bilibili.com/1/lists/2",
    library_dir: "",
    download_dir: join(root, "downloads"),
    cookie_id: "cookie",
    after_date: "",
    interval_minutes: 0,
    auto_download: false,
    excluded: [],
    next_run: null,
  };
  store.put<CookieSource>("cookies", "cookie", {
    id: "cookie",
    name: "fixture",
    kind: "file",
    path: "fixture",
    browser: "chrome",
    profile: "",
    status: "未验证",
  });
  store.put("configs", cfg.id, cfg);
  store.put<Settings>("settings", "global", {
    download_root: join(root, "downloads"),
    ffmpeg: process.execPath,
    ffprobe: process.execPath,
  });
  store.put<Snapshot>("snapshots", "cfg", {
    id: "v1",
    refreshed_at: 1,
    items: [first, second].map((bv) => ({
      bv,
      title: bv,
      url: `https://www.bilibili.com/video/${bv}`,
      date: null,
      base_status: "missing",
    })),
  });
  return {
    root,
    store,
    engine,
    downloader,
    cfg,
    async close() {
      await engine.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("download skips item failures, continues next BV, and records partial status", async () => {
  const f = await fixture();
  try {
    f.downloader.failFirst = "FORMAT_UNAVAILABLE";
    const j = f.engine.enqueue("download", "cfg");
    await f.engine.pump();
    assert.deepEqual(f.downloader.downloaded, [second]);
    const done = f.store.get<Job>("jobs", j.id)!;
    assert.equal(done.status, "partial");
    assert.equal(done.failures[0].bv, first);
    assert.equal(done.done, 2);
    assert.equal(
      f.store.get<Snapshot>("snapshots", "cfg")!.items[1].verified,
      true,
    );
  } finally {
    await f.close();
  }
});
test("Cookie failure stops the entire job without downloading later entries", async () => {
  const f = await fixture();
  try {
    f.downloader.failFirst = "COOKIE_INVALID";
    const j = f.engine.enqueue("download", "cfg");
    await f.engine.pump();
    assert.deepEqual(f.downloader.planned, [first]);
    assert.deepEqual(f.downloader.downloaded, []);
    assert.equal(f.store.get<Job>("jobs", j.id)!.status, "failed");
    assert.equal(
      f.store.get<CookieSource>("cookies", "cookie")!.status,
      "验证失败",
    );
  } finally {
    await f.close();
  }
});

test("refresh failures persist diagnostic details and retain the old snapshot", async () => {
  const f = await fixture();
  try {
    f.engine.storage.scan = async () => {
      throw new TaskError(
        "STORAGE_FAILED",
        "读取云端列表失败",
        "HTTP 401 invalid_grant",
      );
    };
    const job = f.engine.enqueue("refresh", "cfg");
    await f.engine.pump();
    const failed = f.store.get<Job>("jobs", job.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, "STORAGE_FAILED");
    assert.equal(failed.error_details, "HTTP 401 invalid_grant");
    assert.equal(f.store.get<Snapshot>("snapshots", "cfg")!.id, "v1");
  } finally {
    await f.close();
  }
});
test("manual exclusions avoid format calls and strict date cutoff avoids download", async () => {
  const f = await fixture();
  try {
    f.cfg.excluded = [second];
    f.cfg.after_date = "2026-08-01";
    f.store.put("configs", "cfg", f.cfg);
    f.engine.enqueue("download", "cfg");
    await f.engine.pump();
    assert.deepEqual(f.downloader.planned, [first]);
    assert.deepEqual(f.downloader.downloaded, []);
    assert.equal(f.engine.diff(f.cfg)[0].status, "filtered");
    assert.equal(f.engine.diff(f.cfg)[1].status, "excluded");
  } finally {
    await f.close();
  }
});
test("low-quality staged file is not accepted and is not overwritten", async () => {
  const f = await fixture();
  try {
    await mkdir(f.cfg.download_dir);
    const path = join(f.cfg.download_dir, `[${first}].mp4`);
    await writeFile(path, "LOW_QUALITY_FIXTURE");
    f.engine.enqueue("download", "cfg", { selected: [first] });
    await f.engine.pump();
    assert.deepEqual(f.downloader.downloaded, []);
    assert.equal(await readFile(path, "utf8"), "LOW_QUALITY_FIXTURE");
    assert.equal(f.store.all<Job>("jobs")[0].status, "partial");
  } finally {
    await f.close();
  }
});
test("auto-review schedule only refreshes, auto-download schedule queues downloads", async () => {
  const f = await fixture();
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ code: 0, data: { isLogin: true } }), {
        status: 200,
      }),
  );
  try {
    f.engine.enqueue("refresh", "cfg", { scheduled: true });
    await f.engine.pump();
    assert.equal(f.downloader.refreshes, 1);
    assert.equal(f.downloader.planned.length, 0);
    f.cfg.auto_download = true;
    f.store.put("configs", "cfg", f.cfg);
    f.engine.enqueue("refresh", "cfg", { scheduled: true });
    await f.engine.pump();
    assert.equal(f.downloader.refreshes, 2);
    assert.deepEqual(f.downloader.downloaded, [first, second]);
  } finally {
    fetchMock.mock.restore();
    await f.close();
  }
});
test("restart marks queued work interrupted, does not silently resume old downloads", async () => {
  const f = await fixture();
  try {
    const j = f.engine.enqueue("download", "cfg");
    new Engine(f.store, f.downloader);
    assert.equal(f.store.get<Job>("jobs", j.id)!.status, "interrupted");
    assert.equal(f.downloader.downloaded.length, 0);
  } finally {
    await f.close();
  }
});
test("legacy TOML import preserves ISO date and disables automatic execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-import-"));
  const store = new Store(join(root, "state"));
  try {
    const legacy = join(root, "config.toml");
    await writeFile(
      legacy,
      "[global]\ncookie_file='cookie.txt'\n[[tasks]]\nname='old'\nseason_url='https://space.bilibili.com/1/lists/2'\nlibrary_dir='library'\nafter_date=2026-07-27\n",
    );
    new Engine(store, new Downloader(root), legacy);
    const cfg = store.all<BackupConfig>("configs")[0];
    assert.equal(cfg.after_date, "2026-07-27");
    assert.equal(cfg.interval_minutes, 0);
    assert.equal(cfg.auto_download, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
