import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { Library } from "../server/library.ts";

test("platform identities stay separate, sources can share media, snapshots preserve independent metadata and offline covers", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-library-")),
    s = new Store(root),
    lib = new Library(s);
  let calls = 0,
    fail = false;
  const fm = mock.method(globalThis, "fetch", async () => {
    calls++;
    if (fail) throw Error("offline");
    return new Response(new Uint8Array([255, 216, 255, 217]));
  });
  try {
    const item = {
      url: "https://www.bilibili.com/video/BV1234567890",
      title: "same title",
      date: "2026-09-01",
      thumbnail: "https://i0.hdslb.com/cover.jpg",
    };
    const bili = lib.upsert("bilibili", "same-id", item),
      yt = lib.upsert("youtube", "same-id", { ...item, thumbnail: undefined });
    assert.notEqual(bili, yt);
    assert.equal(lib.upsert("bilibili", "same-id", item), bili);
    const media = s.db
      .prepare("SELECT media_id FROM media_sources WHERE id=?")
      .get(bili) as { media_id: string };
    s.db
      .prepare("UPDATE media_sources SET media_id=? WHERE id=?")
      .run(media.media_id, yt);
    assert.equal(
      (
        s.db
          .prepare("SELECT COUNT(*) AS n FROM media_sources WHERE media_id=?")
          .get(media.media_id) as { n: number }
      ).n,
      2,
    );
    lib.cacheCovers();
    await lib.pending;
    assert.equal(lib.coverId("bilibili", "same-id"), bili);
    lib.cacheCovers();
    await lib.pending;
    assert.equal(calls, 1);
    fail = true;
    lib.upsert("bilibili", "same-id", {
      ...item,
      thumbnail: "https://i0.hdslb.com/new.jpg",
    });
    lib.cacheCovers();
    await lib.pending;
    assert.equal(lib.coverId("bilibili", "same-id"), bili);
    lib.ingest("config", {
      id: "snap",
      refreshed_at: 1,
      items: [{ ...item, bv: "BV1234567890", base_status: "missing" }],
    });
    lib.ingest("config", { id: "snap2", refreshed_at: 2, items: [] });
    assert.equal(
      (
        s.db
          .prepare("SELECT present FROM media_collections WHERE config_id=?")
          .get("config") as { present: number }
      ).present,
      0,
    );
    assert.equal(
      (
        s.db.prepare("SELECT COUNT(*) AS n FROM media_sources").get() as {
          n: number;
        }
      ).n,
      3,
    );
    lib.recordFile("bilibili", "same-id", { path: "video.mp4" });
    assert.equal(
      (
        s.db.prepare("SELECT COUNT(*) AS n FROM media_files").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    await lib.close();
    fm.mock.restore();
    s.close();
    await rm(root, { recursive: true, force: true });
  }
});
