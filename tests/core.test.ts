import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBV, safeName, scanMedia } from "../server/paths.ts";
import {
  parseCookies,
  serializeCookies,
  selectPlan,
} from "../server/downloader.ts";
import { runProcess } from "../server/process.ts";

test("BV casing and cross-platform directory names", () => {
  assert.equal(normalizeBV("[BV1abcDEFghi].mp4"), "BV1abcDEFghi");
  assert.equal(safeName("../../bad:name"), "_.._bad_name");
  assert.equal(safeName("CON"), "_CON");
  assert(!safeName("a/b").includes("/"));
});
test("Cookie parser only retains Bilibili and rejects suffix lookalikes / expired credentials", () => {
  const text =
    "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest_fixture\n.notbilibili.com\tTRUE\t/\tTRUE\t0\tTOKEN\tother_fixture\n";
  const rows = parseCookies(text);
  assert.equal(rows.length, 1);
  assert(!serializeCookies(rows).includes("other_fixture"));
  assert.throws(() =>
    parseCookies(text.replace(".bilibili.com", ".evilbilibili.com")),
  );
  assert.throws(() =>
    parseCookies(text.replace("\t0\tSESSDATA", "\t1\tSESSDATA")),
  );
  assert.throws(() =>
    parseCookies(text.replace("test_fixture", "x; injected")),
  );
});
test("highest available selection preserves exact audio/video IDs below 1080p", () => {
  const plan = selectPlan(
    {
      id: "BV1abcDEFghi",
      title: "fixture",
      upload_date: "20260801",
      requested_formats: [
        {
          format_id: "100024",
          width: 1280,
          height: 634,
          vcodec: "av01",
          acodec: "none",
        },
        { format_id: "30280", vcodec: "none", acodec: "mp4a" },
      ],
    },
    "BV1abcDEFghi",
  );
  assert.equal(plan.height, 634);
  assert.equal(plan.format, "100024+30280");
  assert.equal(plan.date, "2026-08-01");
  assert.throws(() =>
    selectPlan(
      { id: "BV1abcDEFghi", title: "fixture", requested_formats: [] },
      "BV1abcDEFghi",
    ),
  );
});
test("media index ignores incomplete downloads, sidecars and unmerged format fragments", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-index-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "[BV1abcDEFghi].mp4"), "test");
    await writeFile(join(root, "[BV1abcDEFghi].f30077.mp4"), "fragment");
    await writeFile(join(root, "[BV1jklMNOpqr].mp4.part"), "partial");
    await writeFile(join(root, "[BV1jklMNOpqr].info.json"), "{}");
    const index = await scanMedia(root);
    assert.equal(index.size, 1);
    assert.equal(index.get("BV1abcDEFghi")?.length, 1);
    await assert.rejects(() => scanMedia(join(root, "absent"), true));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("child process supports explicit timeout, cancellation and redacts stderr", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 100,
    }),
    /超时/,
  );
  const ctl = new AbortController();
  const task = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: ctl.signal },
  );
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(task, /取消/);
  await assert.rejects(
    runProcess(process.execPath, [
      "-e",
      'process.stderr.write("SECRET_FIXTURE");process.exit(1)',
    ]),
    (e) => !String(e).includes("SECRET_FIXTURE"),
  );
});
test("stderr progress survives split chunks and carriage returns without entering JSON stdout", async () => {
  const lines: string[] = [];
  const output = await runProcess(
    process.execPath,
    [
      "-e",
      'process.stderr.write("AF_PRO");setTimeout(()=>{process.stderr.write("GRESS: 42.5%\\rAF_PROGRESS: 100%");process.stdout.write("{}");},20)',
    ],
    { onStderrLine: (line) => lines.push(line) },
  );
  assert.equal(output, "{}");
  assert.deepEqual(lines, ["AF_PROGRESS: 42.5%", "AF_PROGRESS: 100%"]);
});
