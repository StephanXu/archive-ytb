import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Downloader } from "../server/downloader.ts";

test("collection metadata is paged without video extraction; incomplete and duplicate pages fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-list-"));
  const cookie = join(root, "cookies.txt");
  await writeFile(
    cookie,
    "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tFIXTURE\n",
  );
  let mode = "ok";
  const pages: number[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/x/web-interface/nav")
        return Response.json({ code: 0, data: { isLogin: true } });
      assert.equal(url.pathname, "/x/polymer/web-space/seasons_archives_list");
      assert.equal(url.searchParams.get("season_id"), "123");
      const page = Number(url.searchParams.get("page_num"));
      pages.push(page);
      let archives =
        page === 1
          ? [
              {
                bvid: "BV1abcDEFghi",
                title: "标题一",
                pubdate: Date.parse("2026-08-01T23:30:00Z") / 1000,
              },
              { bvid: "BV2abcDEFghi", title: "标题二", ctime: 1785628800 },
            ]
          : [
              {
                bvid: mode === "duplicate" ? "BV1abcDEFghi" : "BV3abcDEFghi",
                title: "标题三",
                pubdate: 1785628800,
              },
            ];
      if (mode === "short" && page === 2) archives = [];
      return Response.json({
        code: 0,
        data: { page: { page_num: page, page_size: 2, total: 3 }, archives },
      });
    },
  );
  try {
    const d = new Downloader(root, async () => {
      throw Error("must not spawn yt-dlp for collection lists");
    });
    const load = () =>
      d.playlist(
        cookie,
        "https://space.bilibili.com/456/lists/123?type=season",
        new AbortController().signal,
      );
    const result = await load();
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.entries.length, 3);
    assert.equal(result.entries[0].title, "标题一");
    assert.equal(result.entries[0].upload_date, "20260801");
    assert.equal(
      result.entries[1].upload_date,
      undefined,
      "never substitute creation time for publication date",
    );
    mode = "short";
    await assert.rejects(load, /不完整/);
    mode = "duplicate";
    await assert.rejects(load, /重复 BV/);
  } finally {
    fetchMock.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});
