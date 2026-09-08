import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Downloader, type Plan } from "../server/downloader.ts";
import type { RunOptions } from "../server/process.ts";

test("download command locks preflight format, reports progress and validates output dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-dlp-"));
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ code: 0, data: { isLogin: true } })),
  );
  try {
    const cookie = join(root, "cookie.txt"),
      media = join(root, "[2026-08-01] 中文标题 [BV1abcDEFghi].mp4");
    await writeFile(
      cookie,
      "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tTEST_FIXTURE\n",
    );
    await writeFile(media, "TEST_MEDIA");
    const calls: string[][] = [];
    const runner = async (
      _cmd: string,
      args: string[],
      options: RunOptions = {},
    ) => {
      calls.push(args);
      if (args.includes("-show_entries"))
        return JSON.stringify({ streams: [{ width: 1280, height: 634 }] });
      options.onStderrLine?.("AF_PROGRESS: 50.0%");
      options.onLine?.("AF_PATH:" + media);
      return "";
    };
    const downloader = new Downloader(root, runner);
    const progress: number[] = [];
    const plan: Plan = {
      bv: "BV1abcDEFghi",
      title: "title",
      date: "2026-08-01",
      format: "100024+30280",
      width: 1280,
      height: 634,
    };
    const receipt = await downloader.download(
      cookie,
      root,
      plan,
      { download_root: root, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      new AbortController().signal,
      (p) => progress.push(p),
    );
    assert.equal(calls[0][calls[0].indexOf("--format") + 1], "100024+30280");
    assert(calls[0].includes("--ignore-config"));
    assert.equal(calls[0][calls[0].indexOf("--encoding") + 1], "utf-8");
    assert.equal(calls[1].at(-1), media);
    assert(calls[0].includes("--no-overwrites"));
    assert(calls[0].includes("--embed-thumbnail"));
    assert(calls[0].includes("--no-write-thumbnail"));
    assert(calls[0].includes("--embed-metadata"));
    assert.equal(receipt.height, 634);
    assert.deepEqual(progress, [50]);
    await assert.rejects(
      () =>
        downloader.verify(
          media,
          { ...plan, height: 1080 },
          { download_root: root, ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
          new AbortController().signal,
        ),
      /尺寸/,
    );
  } finally {
    fetchMock.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});
test("browser Cookie export uses empty local playlist, has no external media URL, and cleans temporary credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-browser-"));
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ code: 0, data: { isLogin: true } })),
  );
  try {
    let exported = false;
    const runner = async (_cmd: string, args: string[]) => {
      if (args.includes("--version")) return "2026.08.19";
      assert(args.includes("--load-info-json"));
      assert(!args.some((a) => a.startsWith("https://")));
      await writeFile(
        args[args.indexOf("--cookies") + 1],
        "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tTEST_FIXTURE\n",
      );
      exported = true;
      return "";
    };
    await new Downloader(root, runner).withCookie(
      {
        id: "fixture",
        name: "test",
        kind: "browser",
        path: "",
        browser: "chrome",
        profile: "",
        status: "未验证",
      },
      root,
      new AbortController().signal,
      async () => {},
    );
    assert(exported);
    assert.deepEqual(await readdir(root), []);
  } finally {
    fetchMock.mock.restore();
    await rm(root, { recursive: true, force: true });
  }
});
